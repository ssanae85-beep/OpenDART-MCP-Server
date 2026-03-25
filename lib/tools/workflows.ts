import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatApiError } from "@/lib/opendart/errors";
import { searchCompanies, getCacheDiagnostics } from "@/lib/opendart/cache";

export function registerWorkflowTools(server: McpServer) {
  // Search company by name
  server.registerTool(
    "opendart_search_company",
    {
      title: "회사 검색 (Search Company)",
      description: `Search for companies by Korean/English name or stock code.
Returns matching companies with their corp_code (needed for other tools), stock_code, and listing status.
This is the recommended first step - find the corp_code, then use it with other tools.

Examples:
  - query="삼성전자" → finds Samsung Electronics
  - query="005930" → finds by stock code
  - query="카카오" → finds Kakao and related companies

Args:
  - query: Company name (Korean/English) or 6-digit stock code
  - limit: Max results (default: 10)`,
      inputSchema: {
        query: z.string().min(1).describe("Company name or stock code to search"),
        limit: z.number().int().min(1).max(30).default(10).describe("Max results"),
        api_key: z.string().optional().describe("Optional: your own API key"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const results = await searchCompanies(params.query, params.api_key, params.limit);

        if (results.length === 0) {
          const diag = getCacheDiagnostics();
          const diagInfo = diag.loaded
            ? `\n\n[Debug] Cache: ${diag.entryCount} entries. Samples: ${diag.sampleNames.join(", ")}\n[XML] ${diag.xmlPreview}`
            : "\n\n[Debug] Cache not loaded.";
          return { content: [{ type: "text" as const, text: `No companies found for "${params.query}". / "${params.query}"에 대한 검색 결과가 없습니다.${diagInfo}` }] };
        }

        const lines = [
          `## 회사 검색 결과 (Company Search Results) - "${params.query}"`,
          "",
          "| 회사명 (Company) | 고유번호 (Corp Code) | 종목코드 (Stock) | 시장 (Market) |",
          "|------------------|---------------------|------------------|---------------|",
        ];

        for (const r of results) {
          const market = r.stock_code ? "상장" : "비상장";
          lines.push(`| ${r.corp_name} | ${r.corp_code} | ${r.stock_code || "-"} | ${market} |`);
        }

        lines.push("", `> Use corp_code with other opendart tools to get detailed information.`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
