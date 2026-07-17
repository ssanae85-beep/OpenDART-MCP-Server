import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";
import { fetchDocument } from "@/lib/opendart/document-cache";
import {
  findSection,
  getSectionText,
  extractText,
  truncate,
  type ParsedDocument,
} from "@/lib/opendart/document-parser";

const DEFAULT_MAX_CHARS = 20000;
const HARD_MAX_CHARS = 50000;

function header(doc: ParsedDocument, rceptNo: string): string {
  const name = doc.docName || "공시 원문";
  const company = doc.companyName ? ` — ${doc.companyName}` : "";
  return `## ${name}${company}\n접수번호: ${rceptNo}`;
}

function renderToc(doc: ParsedDocument, rceptNo: string): string {
  if (doc.sections.length === 0) {
    return [
      header(doc, rceptNo),
      "",
      "이 문서에서 목차(섹션 제목)를 찾지 못했습니다. mode=\"full\"로 원문을 직접 확인하세요.",
      "No section titles found. Use mode=\"full\" to read the raw text.",
    ].join("\n");
  }

  const lines = [header(doc, rceptNo), "", `총 ${doc.sections.length}개 섹션`, ""];

  for (const s of doc.sections) {
    const indent = "  ".repeat(s.depth);
    const size = s.end - s.start;
    lines.push(`${indent}${s.index}. ${s.title} (~${Math.round(size / 1000)}k자)`);
  }

  lines.push(
    "",
    '> 본문을 보려면 mode="section"에 위 번호 또는 제목을 넘기세요.',
    '> e.g. mode="section", section="3" / section="사업의 내용"'
  );

  return lines.join("\n");
}

function withTruncationNotice(
  body: string,
  maxChars: number,
  hint: string
): string {
  const { text, truncated, totalChars } = truncate(body, maxChars);
  if (!truncated) return text;

  return [
    text,
    "",
    "---",
    `⚠️ **잘렸습니다 (truncated)**: 전체 ${totalChars.toLocaleString("ko-KR")}자 중 앞 ${maxChars.toLocaleString("ko-KR")}자만 표시했습니다.`,
    hint,
  ].join("\n");
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

Output is plain text with XML markup stripped; tables render as pipe-separated rows.
Responses are capped at max_chars and clearly marked when truncated.

Args:
  - rcept_no: 14-digit receipt number (접수번호, e.g. "20240312000736")
  - mode (optional): "toc" | "section" | "full" (default: "toc")
  - section (required when mode="section"): TOC number (e.g. "3") or title keyword (e.g. "사업의 내용")
  - max_chars (optional): Response character cap (default: ${DEFAULT_MAX_CHARS}, max: ${HARD_MAX_CHARS})
  - api_key (optional): Override the server's OpenDART API key`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14-digit receipt number (접수번호)"),
        mode: z.enum(["toc", "section", "full"]).default("toc").describe("toc: section list, section: one section, full: whole document"),
        section: z.string().optional().describe('TOC number or title keyword, e.g. "3" or "사업의 내용"'),
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
    async ({ rcept_no, mode, section, max_chars, api_key }) => {
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

        const doc = await fetchDocument(rcept_no, key);

        if (mode === "toc") {
          return { content: [{ type: "text" as const, text: renderToc(doc, rcept_no) }] };
        }

        if (mode === "full") {
          const body = extractText(doc.raw);
          const text = withTruncationNotice(
            `${header(doc, rcept_no)}\n\n${body}`,
            max_chars,
            '> 나머지를 보려면 mode="toc"로 목차를 확인한 뒤 mode="section"으로 필요한 섹션만 조회하세요.'
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

        const body = getSectionText(doc, target);
        const text = withTruncationNotice(
          `${header(doc, rcept_no)}\n\n### ${target.index}. ${target.title}\n\n${body || "(빈 섹션 / empty section)"}`,
          max_chars,
          `> 하위 섹션을 개별 조회하거나 max_chars를 늘리세요 (최대 ${HARD_MAX_CHARS.toLocaleString("ko-KR")}).`
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
