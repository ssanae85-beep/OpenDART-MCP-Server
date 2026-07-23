import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";
import {
  fetchDocumentBundle,
  findEntry,
  getParsed,
  type BundleEntry,
  type DocumentBundle,
} from "@/lib/opendart/document-cache";
import {
  findSection,
  findInDocument,
  getSectionText,
  extractText,
  paginate,
  truncate,
  type FindResult,
  type ParsedDocument,
} from "@/lib/opendart/document-parser";
import { UNREADABLE_THRESHOLD } from "@/lib/opendart/zip";

const DEFAULT_MAX_CHARS = 20000;
const HARD_MAX_CHARS = 50000;
const MAX_FIND_GROUPS = 15;

/**
 * Absolute server-side ceiling, independent of the client's max_chars.
 *
 * max_chars is already capped at HARD_MAX_CHARS by the schema, but the schema
 * can be bypassed and some paths (find, warnings) don't run through max_chars at
 * all. This is the last line: every response is truncated to this before it
 * leaves, so no reply can blow up the context regardless of how it was built.
 */
const MAX_RESPONSE_CHARS = 50000;

/** Clamp the client value and never exceed the server ceiling. Exported for tests. */
export function effectiveMaxChars(requested: number): number {
  return Math.min(requested, MAX_RESPONSE_CHARS);
}

export { MAX_RESPONSE_CHARS };

/** Final guard applied to every outgoing response, on every path. Exported for tests. */
export function capResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return (
    text.slice(0, MAX_RESPONSE_CHARS) +
    `\n\n---\n⚠️ 응답이 서버 상한(${MAX_RESPONSE_CHARS.toLocaleString("ko-KR")}자)에서 잘렸습니다. ` +
    `mode="section"/offset으로 나눠서 조회하세요. / Response truncated at the server limit.`
  );
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text: capResponse(text) }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: capResponse(text) }], isError: true };
}

function header(entry: BundleEntry, doc: ParsedDocument, rceptNo: string): string {
  const name = entry.docName || doc.docName || "공시 원문";
  const company = doc.companyName ? ` — ${doc.companyName}` : "";
  return `## ${name}${company}\n접수번호: ${rceptNo}`;
}

/**
 * A short warning instead of the garbled body when text extraction failed.
 *
 * Returned for filings whose fallback decode still can't be read (mostly some
 * pre-2020 EUC-KR reports): flooding the context with U+FFFD is exactly the kind
 * of bloat that raised the collapse risk, so we spend a few tokens saying so
 * rather than thousands emitting it.
 */
function garbleWarning(entry: BundleEntry, rceptNo: string): string {
  return [
    `## ${entry.docName || "공시 원문"}`,
    `접수번호: ${rceptNo}`,
    "",
    `⚠️ 이 문서는 인코딩 문제로 텍스트 추출이 불가능합니다 (깨진 문자 비율 ${Math.round(entry.garbleRatio * 100)}%).`,
    "This document could not be decoded to readable text (encoding issue).",
    "",
    "구형(2020년 이전) DART 보고서에서 종종 발생합니다.",
    "원문 확인이 필요하면 DART 웹사이트에서 직접 열어보세요: https://dart.fss.or.kr",
  ].join("\n");
}

/** List every document in the filing's ZIP, marking the one being read. */
function renderAttachments(bundle: DocumentBundle, selected: BundleEntry): string {
  if (bundle.entries.length === 1) return "";

  const lines = [`이 접수번호에 포함된 문서 ${bundle.entries.length}개:`];

  for (const e of bundle.entries) {
    const size = `${(e.chars / 1000).toFixed(0)}k자`;
    const role = e.index === 1 ? "본문" : "첨부";
    const marker = e.index === selected.index ? "  ← 현재 문서" : "";
    lines.push(`  ${e.index}. ${e.docName} (${role}, ${size})${marker}`);
  }

  lines.push(
    "",
    '> 다른 문서를 읽으려면 attachment에 번호 또는 이름을 넘기세요.',
    '> e.g. attachment="2" / attachment="감사보고서"'
  );

  return lines.join("\n");
}

function renderToc(bundle: DocumentBundle, entry: BundleEntry, doc: ParsedDocument): string {
  const parts = [header(entry, doc, bundle.rceptNo)];

  const attachments = renderAttachments(bundle, entry);
  if (attachments) parts.push("", attachments);

  if (doc.sections.length === 0) {
    parts.push(
      "",
      '이 문서에서 목차(섹션 제목)를 찾지 못했습니다. mode="full"로 원문을 직접 확인하세요.',
      'No section titles found. Use mode="full" to read the raw text.'
    );
    return parts.join("\n");
  }

  parts.push("", `총 ${doc.sections.length}개 섹션`, "");

  for (const s of doc.sections) {
    const indent = "  ".repeat(s.depth);
    const size = s.end - s.start;
    parts.push(`${indent}${s.index}. ${s.title} (~${Math.round(size / 1000)}k자)`);
  }

  parts.push(
    "",
    '> 본문을 보려면 mode="section"에 위 번호 또는 제목을 넘기세요.',
    '> e.g. mode="section", section="3" / section="사업의 내용"'
  );

  return parts.join("\n");
}

const ko = (n: number) => n.toLocaleString("ko-KR");

/** Each hit doubles as the next call: section + offset to read it. */
function renderFind(
  headerText: string,
  query: string,
  result: FindResult,
  attachment?: string
): string {
  if (result.totalHits === 0) {
    return [
      headerText,
      "",
      `"${query}" 검색 결과 없음 (범위: ${result.scope}) / No matches.`,
      "",
      '> 표기가 다를 수 있습니다. 더 짧은 키워드로 다시 시도하거나, mode="toc"로 목차를 확인하세요.',
    ].join("\n");
  }

  const attachmentArg = attachment ? `, attachment="${attachment}"` : "";

  const parts = [
    headerText,
    "",
    `"${query}" 검색 결과: ${ko(result.totalHits)}건 / ${result.groups.length}개 섹션 — 범위: ${result.scope}`,
    "(많이 언급된 섹션 순)",
    "",
  ];

  for (const [i, g] of result.groups.entries()) {
    const first = g.offsets[0];
    parts.push(
      `**${i + 1}. #${g.sectionIndex} ${g.sectionTitle}** — ${ko(g.count)}건`,
      `   …${g.snippet}…`,
      `   → mode="section", section="${g.sectionIndex}", offset=${first}${attachmentArg}`
    );

    const others = g.offsets.slice(1, 5);
    if (others.length > 0) {
      const more = g.count - 1 - others.length;
      parts.push(
        `   다른 위치: offset=${others.join(" / ")}${more > 0 ? ` (외 ${ko(more)}건)` : ""}`
      );
    }
    parts.push("");
  }

  parts.push("> 위 → 줄을 그대로 호출하면 해당 대목부터 읽습니다.");

  return parts.join("\n");
}

/**
 * Render one window of a section's text, keeping the header visible and always
 * saying where the window sits so the rest stays reachable.
 */
function renderBody(
  headerText: string,
  body: string,
  offset: number,
  maxChars: number,
  hint: string
): string {
  const page = paginate(body, offset, maxChars);

  if (page.beyondEnd) {
    return [
      headerText,
      "",
      `⚠️ offset=${ko(offset)}이 전체 길이를 넘었습니다. 이 텍스트는 ${ko(page.totalChars)}자입니다. / offset is past the end (total ${ko(page.totalChars)} chars).`,
    ].join("\n");
  }

  const parts = [headerText, "", page.text || "(빈 섹션 / empty section)"];

  if (page.hasMore || page.start > 0) {
    parts.push(
      "",
      "---",
      `⚠️ **잘렸습니다 (truncated)**: 전체 ${ko(page.totalChars)}자 중 ${ko(page.start + 1)}–${ko(page.end)}자를 표시했습니다.`
    );
    if (page.hasMore) {
      parts.push(`> 이어서 보려면 offset=${page.end} (같은 인자에 offset만 추가)`);
      parts.push(hint);
    }
  }

  return parts.join("\n");
}

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "opendart_get_document",
    {
      title: "공시 원문 조회 (Disclosure Document)",
      description: `원문 정독용. 재무 수치(매출·영업이익·자산·비율 등)만 필요하면
이 도구가 아니라 financial_accounts 또는 financial_index를 쓸 것.
원문 조회는 '뭘 찾을지 모르는 상태에서 훑을 때' 쓴다.

Read the original text of a DART filing (사업보고서, 주요사항보고서, etc.) by receipt number.
Get rcept_no from opendart_search_disclosure first.

Filings are large (often several MB), so this tool is paged:
  1. mode="toc" (default) — list section titles with their sizes. START HERE.
  2. mode="find" — locate a keyword anywhere in the filing. Each hit reports the
     section and offset to read it, so the result is the next call to make.
  3. mode="section" — return one section's text, by TOC number or title keyword.
  4. mode="full" — the whole document as text. Only for short filings.

A filing's archive holds the report plus its attachments (감사보고서, 연결감사보고서 …).
mode="toc" lists them; use attachment to read one.

Filings disagree on how notes are structured. Large caps title each note
("15. 충당부채"), so mode="section" reaches it. Smaller ones put every note under
one title as plain paragraphs — there mode="section" with a note name finds
NOTHING even though the text is present. Use mode="find" whenever a keyword
isn't a section title in the TOC; do not page through with offset looking for it.

When a response is truncated it reports the offset to continue from; pass it back
as offset to read on.

Output is plain text with XML markup stripped; tables render as pipe-separated rows.
Responses are capped at max_chars and clearly marked when truncated.

Args:
  - rcept_no: 14-digit receipt number (접수번호, e.g. "20240312000736")
  - mode (optional): "toc" | "find" | "section" | "full" (default: "toc")
  - section (required when mode="section"): TOC number (e.g. "3") or title keyword (e.g. "사업의 내용"). Optional with mode="find" to limit the search.
  - query (required when mode="find"): keyword to locate, e.g. "충당부채"
  - attachment (optional): which document in the filing — number (e.g. "2") or name (e.g. "감사보고서"). Defaults to the main report.
  - offset (optional): Start this many characters into the text (default: 0). Use the offset a truncated response reports.
  - max_chars (optional): Response character cap (default: ${DEFAULT_MAX_CHARS}, max: ${HARD_MAX_CHARS})
  - api_key (optional): Override the server's OpenDART API key`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14-digit receipt number (접수번호)"),
        mode: z.enum(["toc", "section", "full", "find"]).default("toc").describe("toc: section list, find: locate a keyword, section: one section, full: whole document"),
        section: z.string().optional().describe('TOC number or title keyword, e.g. "3" or "사업의 내용". With mode="find", narrows the search to that section.'),
        query: z.string().optional().describe('Keyword to search for (required when mode="find"), e.g. "충당부채"'),
        attachment: z.string().optional().describe('Document within the filing: number or name, e.g. "2" or "감사보고서". Omit for the main report.'),
        offset: z.number().int().min(0).default(0).describe("Start reading this many characters in. Use the offset the previous truncated response reported."),
        max_chars: z.number().int().min(1000).max(HARD_MAX_CHARS).default(DEFAULT_MAX_CHARS).describe("Max characters to return"),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ rcept_no, mode, section, query, attachment, offset, max_chars, api_key }) => {
      try {
        const key = resolveApiKey(api_key);

        const cap = effectiveMaxChars(max_chars);

        if (mode === "section" && !section?.trim()) {
          return err('mode="section" requires the section argument (TOC number or title keyword). Call mode="toc" first to see the options. / mode="section"에는 section 인자가 필요합니다. 먼저 mode="toc"로 목차를 확인하세요.');
        }

        if (mode === "find" && !query?.trim()) {
          return err('mode="find" requires the query argument (keyword to search for). / mode="find"에는 query 인자(찾을 키워드)가 필요합니다.');
        }

        const bundle = await fetchDocumentBundle(rcept_no, key);

        let entry: BundleEntry;
        if (attachment?.trim()) {
          const found = findEntry(bundle, attachment);
          if (!found) {
            const available = bundle.entries
              .map((e) => `  ${e.index}. ${e.docName}`)
              .join("\n");
            return err(`문서를 찾지 못했습니다: "${attachment}" / Attachment not found.\n\n이 접수번호의 문서 (available):\n${available}`);
          }
          entry = found;
        } else {
          entry = bundle.entries[0];
        }

        // Decode failed even after the encoding fallback: warn instead of
        // streaming a wall of U+FFFD. TOC still works — titles are ASCII-ish
        // structure — so only the text-bearing modes are short-circuited.
        if (entry.garbleRatio > UNREADABLE_THRESHOLD && mode !== "toc") {
          return ok(garbleWarning(entry, rcept_no));
        }

        const doc = getParsed(entry);

        if (mode === "toc") {
          return ok(renderToc(bundle, entry, doc));
        }

        if (mode === "find") {
          // section is optional here: it narrows the search to one subtree
          const within = section?.trim() ? findSection(doc, section) ?? undefined : undefined;
          if (section?.trim() && !within) {
            return err(`검색 범위로 지정한 섹션을 찾지 못했습니다: "${section}" / Section not found. mode="toc"로 목차를 확인하세요.`);
          }

          const result = findInDocument(doc, query!, MAX_FIND_GROUPS, within);
          const rendered = renderFind(header(entry, doc, rcept_no), query!, result, attachment);
          return ok(truncate(rendered, cap).text);
        }

        if (mode === "full") {
          const text = renderBody(
            header(entry, doc, rcept_no),
            extractText(doc.raw),
            offset,
            cap,
            '> 또는 mode="toc"로 목차를 확인한 뒤 mode="section"으로 필요한 섹션만 조회하세요.'
          );
          return ok(text);
        }

        const target = findSection(doc, section!);
        if (!target) {
          const available = doc.sections
            .slice(0, 30)
            .map((s) => `  ${s.index}. ${s.title}`)
            .join("\n");
          return err(`섹션을 찾지 못했습니다: "${section}" / Section not found.\n\n사용 가능한 섹션 (available):\n${available || "  (none)"}`);
        }

        const text = renderBody(
          `${header(entry, doc, rcept_no)}\n\n### ${target.index}. ${target.title}`,
          getSectionText(doc, target),
          offset,
          cap,
          `> 또는 하위 섹션을 개별 조회하거나 max_chars를 늘리세요 (최대 ${ko(HARD_MAX_CHARS)}).`
        );
        return ok(text);
      } catch (error) {
        return err(formatApiError(error));
      }
    }
  );
}
