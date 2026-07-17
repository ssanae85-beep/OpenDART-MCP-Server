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
  getSectionText,
  extractText,
  paginate,
  type ParsedDocument,
} from "@/lib/opendart/document-parser";

const DEFAULT_MAX_CHARS = 20000;
const HARD_MAX_CHARS = 50000;

function header(entry: BundleEntry, doc: ParsedDocument, rceptNo: string): string {
  const name = entry.docName || doc.docName || "공시 원문";
  const company = doc.companyName ? ` — ${doc.companyName}` : "";
  return `## ${name}${company}\n접수번호: ${rceptNo}`;
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
      description: `Read the original text of a DART filing (사업보고서, 주요사항보고서, etc.) by receipt number.
Get rcept_no from opendart_search_disclosure first.

Filings are large (often several MB), so this tool is paged by section:
  1. mode="toc" (default) — list section titles with their sizes. START HERE.
  2. mode="section" — return one section's text, chosen by TOC number or title keyword.
  3. mode="full" — the whole document as text. Only for short filings; long ones get truncated.

A filing's archive holds the report plus its attachments (감사보고서, 연결감사보고서 …).
mode="toc" lists them; use attachment to read one.

Not every filing splits its notes into titled sections. Large caps tag each note
separately ("15. 충당부채"); smaller ones put all of them under a single title as
plain paragraphs. When a section is too long for one response, it is truncated
and reports the offset to continue from — pass it back as offset to read on.
Repeat until nothing is truncated; that is the only way to reach the tail of an
untitled notes blob.

Output is plain text with XML markup stripped; tables render as pipe-separated rows.
Responses are capped at max_chars and clearly marked when truncated.

Args:
  - rcept_no: 14-digit receipt number (접수번호, e.g. "20240312000736")
  - mode (optional): "toc" | "section" | "full" (default: "toc")
  - section (required when mode="section"): TOC number (e.g. "3") or title keyword (e.g. "사업의 내용")
  - attachment (optional): which document in the filing — number (e.g. "2") or name (e.g. "감사보고서"). Defaults to the main report.
  - offset (optional): Start this many characters into the text (default: 0). Use the offset a truncated response reports.
  - max_chars (optional): Response character cap (default: ${DEFAULT_MAX_CHARS}, max: ${HARD_MAX_CHARS})
  - api_key (optional): Override the server's OpenDART API key`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14-digit receipt number (접수번호)"),
        mode: z.enum(["toc", "section", "full"]).default("toc").describe("toc: section list, section: one section, full: whole document"),
        section: z.string().optional().describe('TOC number or title keyword, e.g. "3" or "사업의 내용"'),
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
    async ({ rcept_no, mode, section, attachment, offset, max_chars, api_key }) => {
      try {
        const key = resolveApiKey(api_key);

        if (mode === "section" && !section?.trim()) {
          return {
            content: [{
              type: "text" as const,
              text: 'mode="section" requires the section argument (TOC number or title keyword). Call mode="toc" first to see the options. / mode="section"에는 section 인자가 필요합니다. 먼저 mode="toc"로 목차를 확인하세요.',
            }],
            isError: true,
          };
        }

        const bundle = await fetchDocumentBundle(rcept_no, key);

        let entry: BundleEntry;
        if (attachment?.trim()) {
          const found = findEntry(bundle, attachment);
          if (!found) {
            const available = bundle.entries
              .map((e) => `  ${e.index}. ${e.docName}`)
              .join("\n");
            return {
              content: [{
                type: "text" as const,
                text: `문서를 찾지 못했습니다: "${attachment}" / Attachment not found.\n\n이 접수번호의 문서 (available):\n${available}`,
              }],
              isError: true,
            };
          }
          entry = found;
        } else {
          entry = bundle.entries[0];
        }

        const doc = getParsed(entry);

        if (mode === "toc") {
          return { content: [{ type: "text" as const, text: renderToc(bundle, entry, doc) }] };
        }

        if (mode === "full") {
          const text = renderBody(
            header(entry, doc, rcept_no),
            extractText(doc.raw),
            offset,
            max_chars,
            '> 또는 mode="toc"로 목차를 확인한 뒤 mode="section"으로 필요한 섹션만 조회하세요.'
          );
          return { content: [{ type: "text" as const, text }] };
        }

        const target = findSection(doc, section!);
        if (!target) {
          const available = doc.sections
            .slice(0, 30)
            .map((s) => `  ${s.index}. ${s.title}`)
            .join("\n");
          return {
            content: [{
              type: "text" as const,
              text: `섹션을 찾지 못했습니다: "${section}" / Section not found.\n\n사용 가능한 섹션 (available):\n${available || "  (none)"}`,
            }],
            isError: true,
          };
        }

        const text = renderBody(
          `${header(entry, doc, rcept_no)}\n\n### ${target.index}. ${target.title}`,
          getSectionText(doc, target),
          offset,
          max_chars,
          `> 또는 하위 섹션을 개별 조회하거나 max_chars를 늘리세요 (최대 ${ko(HARD_MAX_CHARS)}).`
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
