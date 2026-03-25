import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getJson, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError, isNoData } from "@/lib/opendart/errors";
import { searchCompanies } from "@/lib/opendart/cache";
import { formatCompanyInfoMd, formatAmount, formatCorpCls, getAmountUnitLabel, type AmountUnit } from "@/lib/opendart/formatters";

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
          return { content: [{ type: "text" as const, text: `No companies found for "${params.query}". / "${params.query}"에 대한 검색 결과가 없습니다.` }] };
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

  // Financial summary
  server.registerTool(
    "opendart_financial_summary",
    {
      title: "재무 요약 (Financial Summary)",
      description: `Get a comprehensive financial summary for a company.
Combines company info + key accounts + financial indicators into one formatted overview.
Shows revenue, operating profit, net income, total assets, total equity, and key ratios.

Args:
  - corp_code: 8-digit company code
  - bsns_year: Business year (e.g., "2024")
  - reprt_code: Report type (11011=Annual recommended)
  - fs_div: CFS=Consolidated (default), OFS=Individual`,
      inputSchema: {
        corp_code: z.string().length(8).describe("8-digit company code"),
        bsns_year: z.string().regex(/^\d{4}$/).describe("Business year"),
        reprt_code: z.enum(["11011", "11012", "11013", "11014"]).default("11011"),
        fs_div: z.enum(["OFS", "CFS"]).default("CFS"),
        amount_unit: z.enum(["auto", "won", "eok", "jo"]).default("auto").describe(
          "금액 표시 단위. auto=자동(조/억/만), won=원, eok=억원, jo=조원"
        ),
        api_key: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);
        const unit = (params.amount_unit || "auto") as AmountUnit;

        // Fetch company info and financial data in parallel
        const [companyData, accountsData, indexData] = await Promise.all([
          getJson("company", { corp_code: params.corp_code }, key).catch(() => null),
          getJson("fnlttSinglAcnt", {
            corp_code: params.corp_code,
            bsns_year: params.bsns_year,
            reprt_code: params.reprt_code,
            fs_div: params.fs_div,
          }, key).catch(() => null),
          getJson("fnlttSinglIndx", {
            corp_code: params.corp_code,
            bsns_year: params.bsns_year,
            reprt_code: params.reprt_code,
            fs_div: params.fs_div,
          }, key).catch(() => null),
        ]);

        const sections: string[] = [];

        // Company info section
        if (companyData && !isNoData(companyData.status as string)) {
          sections.push(formatCompanyInfoMd(companyData));
        }

        // Key accounts section — CFS/OFS 분리 출력
        if (accountsData && !isNoData(accountsData.status as string)) {
          const items = (accountsData.list || []) as Array<Record<string, unknown>>;
          if (items.length > 0) {
            const cfs = items.filter(i => i.fs_div === "CFS");
            const ofs = items.filter(i => i.fs_div === "OFS");

            const renderAccountsTable = (rows: Array<Record<string, unknown>>, label: string) => {
              const first = rows[0];
              sections.push("");
              sections.push(`### ${label} - ${params.bsns_year}`);
              sections.push("");
              sections.push(`| 재무제표 | 계정명 | 당기 (${first.thstrm_nm}) | 전기 (${first.frmtrm_nm}) | 전전기 (${first.bfefrmtrm_nm}) |`);
              sections.push("|----------|--------|------|------|--------|");
              for (const item of rows) {
                sections.push(
                  `| ${item.sj_nm} | ${item.account_nm} | ${formatAmount(item.thstrm_amount as string, unit)} | ${formatAmount(item.frmtrm_amount as string, unit)} | ${formatAmount(item.bfefrmtrm_amount as string, unit)} |`
                );
              }
              sections.push("", `> 금액 단위: ${getAmountUnitLabel(unit)}`);
            };

            if (cfs.length > 0 && ofs.length > 0) {
              renderAccountsTable(cfs, "연결재무제표 (Consolidated)");
              renderAccountsTable(ofs, "별도재무제표 (Separate)");
            } else {
              renderAccountsTable(items, "주요 재무정보 (Key Financials)");
            }
          }
        }

        // Financial indicators section
        if (indexData && !isNoData(indexData.status as string)) {
          const items = (indexData.list || []) as Array<Record<string, unknown>>;
          if (items.length > 0) {
            sections.push("");
            sections.push("### 주요 재무지표 (Key Indicators)");
            sections.push("");
            sections.push("| 분류 | 지표명 | 값 |");
            sections.push("|------|--------|-----|");

            for (const item of items) {
              sections.push(`| ${item.idx_cl_nm} | ${item.idx_nm} | ${item.idx_val} |`);
            }
          }
        }

        if (sections.length === 0) {
          return { content: [{ type: "text" as const, text: "No financial data found for the given parameters." }] };
        }

        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );

  // Compare companies
  server.registerTool(
    "opendart_compare_companies",
    {
      title: "기업 비교 (Compare Companies)",
      description: `Compare financial metrics across 2-5 companies side by side.
Returns a comparison table with key accounts and financial indicators.

Args:
  - corp_codes: Comma-separated 8-digit codes (2-5 companies)
  - bsns_year: Business year
  - reprt_code: Report type
  - fs_div: CFS or OFS`,
      inputSchema: {
        corp_codes: z.string().describe("Comma-separated 8-digit codes (e.g., '00126380,00164779')"),
        bsns_year: z.string().regex(/^\d{4}$/),
        reprt_code: z.enum(["11011", "11012", "11013", "11014"]).default("11011"),
        fs_div: z.enum(["OFS", "CFS"]).default("CFS"),
        amount_unit: z.enum(["auto", "won", "eok", "jo"]).default("auto").describe(
          "금액 표시 단위. auto=자동(조/억/만), won=원, eok=억원, jo=조원"
        ),
        api_key: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);
        const unit = (params.amount_unit || "auto") as AmountUnit;

        const [accountsData, indexData] = await Promise.all([
          getJson("fnlttMultiAcnt", {
            corp_code: params.corp_codes,
            bsns_year: params.bsns_year,
            reprt_code: params.reprt_code,
            fs_div: params.fs_div,
          }, key).catch(() => null),
          getJson("fnlttCmpnyIndx", {
            corp_code: params.corp_codes,
            bsns_year: params.bsns_year,
            reprt_code: params.reprt_code,
            fs_div: params.fs_div,
          }, key).catch(() => null),
        ]);

        const sections: string[] = [`## 기업 비교 (Company Comparison) - ${params.bsns_year}`, ""];

        if (accountsData && !isNoData(accountsData.status as string)) {
          const items = (accountsData.list || []) as Array<Record<string, unknown>>;

          // Group by company
          const byCompany = new Map<string, Array<Record<string, unknown>>>();
          for (const item of items) {
            const name = item.corp_name as string;
            if (!byCompany.has(name)) byCompany.set(name, []);
            byCompany.get(name)!.push(item);
          }

          const companies = Array.from(byCompany.keys());
          sections.push("### 주요계정 비교 (Key Accounts)");
          sections.push("");
          sections.push(`| 계정명 | ${companies.join(" | ")} |`);
          sections.push(`| ------ | ${companies.map(() => "------").join(" | ")} |`);

          // Get unique account names
          const accountNames = new Set<string>();
          for (const item of items) accountNames.add(item.account_nm as string);

          for (const acct of accountNames) {
            const values = companies.map((co) => {
              const entry = byCompany.get(co)?.find((i) => i.account_nm === acct);
              return entry ? formatAmount(entry.thstrm_amount as string, unit) : "-";
            });
            sections.push(`| ${acct} | ${values.join(" | ")} |`);
          }

          sections.push("", `> 금액 단위: ${getAmountUnitLabel(unit)}`);
        }

        if (indexData && !isNoData(indexData.status as string)) {
          const items = (indexData.list || []) as Array<Record<string, unknown>>;

          const byCompany = new Map<string, Array<Record<string, unknown>>>();
          for (const item of items) {
            const name = item.corp_name as string;
            if (!byCompany.has(name)) byCompany.set(name, []);
            byCompany.get(name)!.push(item);
          }

          const companies = Array.from(byCompany.keys());
          sections.push("");
          sections.push("### 재무지표 비교 (Financial Indicators)");
          sections.push("");
          sections.push(`| 지표명 | ${companies.join(" | ")} |`);
          sections.push(`| ------ | ${companies.map(() => "------").join(" | ")} |`);

          const idxNames = new Set<string>();
          for (const item of items) idxNames.add(item.idx_nm as string);

          for (const idx of idxNames) {
            const values = companies.map((co) => {
              const entry = byCompany.get(co)?.find((i) => i.idx_nm === idx);
              return entry ? String(entry.idx_val) : "-";
            });
            sections.push(`| ${idx} | ${values.join(" | ")} |`);
          }
        }

        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );

  // Recent disclosures
  server.registerTool(
    "opendart_recent_disclosures",
    {
      title: "최근 공시 요약 (Recent Disclosures)",
      description: `Get recent disclosures for a company with a readable summary.
Combines disclosure search with company info for context.

Args:
  - corp_code: 8-digit company code
  - days: Number of days to look back (default: 30, max: 365)
  - page_count: Items per page (default: 20)`,
      inputSchema: {
        corp_code: z.string().length(8).describe("8-digit company code"),
        days: z.number().int().min(1).max(365).default(30).describe("Days to look back"),
        page_count: z.number().int().min(1).max(100).default(20),
        api_key: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);

        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - params.days);

        const bgn_de = startDate.toISOString().slice(0, 10).replace(/-/g, "");
        const end_de = endDate.toISOString().slice(0, 10).replace(/-/g, "");

        const [companyData, disclosureData] = await Promise.all([
          getJson("company", { corp_code: params.corp_code }, key).catch(() => null),
          getJson("list", {
            corp_code: params.corp_code,
            bgn_de,
            end_de,
            page_count: String(params.page_count),
          }, key),
        ]);

        const sections: string[] = [];

        const companyName = companyData?.corp_name || params.corp_code;
        sections.push(`## ${companyName} - 최근 공시 (Recent ${params.days} days)`);
        sections.push("");

        if (isNoData(disclosureData.status as string)) {
          sections.push("No recent disclosures found. / 최근 공시가 없습니다.");
        } else {
          const items = (disclosureData.list || []) as Array<Record<string, unknown>>;
          const totalCount = disclosureData.total_count as number;

          sections.push(`총 ${totalCount}건의 공시`);
          sections.push("");
          sections.push("| 날짜 | 보고서명 | 제출인 | 비고 |");
          sections.push("|------|----------|--------|------|");

          for (const item of items) {
            sections.push(
              `| ${item.rcept_dt} | ${item.report_nm} | ${item.flr_nm} | ${item.rm || ""} |`
            );
          }

          if (totalCount > params.page_count) {
            sections.push("");
            sections.push(`> Showing ${items.length} of ${totalCount} total disclosures. Use opendart_search_disclosure for pagination.`);
          }
        }

        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
