import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getJson, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError, isNoData } from "@/lib/opendart/errors";
import { formatGenericTableMd } from "@/lib/opendart/formatters";

const periodicParams = {
  corp_code: z.string().length(8).describe("8-digit company code"),
  bsns_year: z.string().regex(/^\d{4}$/).describe("Business year (YYYY)"),
  reprt_code: z.enum(["11011", "11012", "11013", "11014"]).describe(
    "11011=Annual, 11012=Semi-annual, 11013=Q1, 11014=Q3"
  ),
  api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
};

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function registerPeriodicTool(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  endpoint: string,
  columns: Array<{ key: string; label: string }>
) {
  server.registerTool(
    name,
    { title, description, inputSchema: periodicParams, annotations },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);
        const data = await getJson(endpoint, {
          corp_code: params.corp_code,
          bsns_year: params.bsns_year,
          reprt_code: params.reprt_code,
        }, key);

        if (isNoData(data.status as string)) {
          return { content: [{ type: "text" as const, text: `No data found. / 데이터 없음 (${endpoint})` }] };
        }

        const items = data.list as Array<Record<string, unknown>>;
        const md = formatGenericTableMd(items, title, columns);
        return { content: [{ type: "text" as const, text: md }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}

export function registerDisclosureTools(server: McpServer) {
  registerPeriodicTool(server,
    "opendart_largest_shareholder", "최대주주 현황 (Largest Shareholder)",
    "Get largest shareholder status including name, ownership ratio, and relationship.\nArgs: corp_code, bsns_year, reprt_code",
    "hyslrSttus",
    [{ key: "nm", label: "성명" }, { key: "relate", label: "관계" }, { key: "stock_knd", label: "주식종류" },
     { key: "bsis_posesn_stock_co", label: "기초주식수" }, { key: "trmend_posesn_stock_co", label: "기말주식수" },
     { key: "trmend_posesn_stock_qota_rt", label: "지분율(%)" }]
  );

  registerPeriodicTool(server,
    "opendart_largest_shareholder_change", "최대주주 변동 (Shareholder Change)",
    "Get changes in the largest shareholder.\nArgs: corp_code, bsns_year, reprt_code",
    "hyslrChgSttus",
    [{ key: "change_on", label: "변동일" }, { key: "mxmm_shrholdr_nm", label: "최대주주명" },
     { key: "posesn_stock_co", label: "소유주식수" }, { key: "qota_rt", label: "지분율(%)" },
     { key: "change_cause", label: "변동사유" }]
  );

  registerPeriodicTool(server,
    "opendart_executive_status", "임원 현황 (Executive Status)",
    "Get executive/director roster with positions and compensation.\nArgs: corp_code, bsns_year, reprt_code",
    "exctvSttus",
    [{ key: "nm", label: "성명" }, { key: "sexdstn", label: "성별" }, { key: "birth_ym", label: "출생년월" },
     { key: "ofcps", label: "직위" }, { key: "rgist_exctv_at", label: "등기여부" },
     { key: "fte_at", label: "상근여부" }, { key: "chrg_job", label: "담당업무" }]
  );

  registerPeriodicTool(server,
    "opendart_employee_status", "직원 현황 (Employee Status)",
    "Get employee headcount, average tenure, and average salary.\nArgs: corp_code, bsns_year, reprt_code",
    "empSttus",
    [{ key: "fo_bbm", label: "사업부문" }, { key: "sexdstn", label: "성별" },
     { key: "reform_bfe_emp_co_rgllbr", label: "정규직" }, { key: "reform_bfe_emp_co_cnttk", label: "계약직" },
     { key: "rgllbr_co", label: "합계" }, { key: "avrg_cnwk_sdytrn", label: "평균근속(년)" },
     { key: "jan_salary_am", label: "연간급여총액" }, { key: "sm_avrg_salary_am", label: "1인평균급여" }]
  );

  registerPeriodicTool(server,
    "opendart_top5_compensation", "보수 상위 5인 (Top 5 Compensation)",
    "Get individual compensation for top 5 highest-paid executives (500M+ KRW).\nArgs: corp_code, bsns_year, reprt_code",
    "indvdlByPay",
    [{ key: "nm", label: "성명" }, { key: "ofcps", label: "직위" }, { key: "mendng_totamt", label: "보수총액" },
     { key: "mendng_totamt_ct_incls_mendng", label: "근로소득포함" }]
  );

  registerPeriodicTool(server,
    "opendart_total_shares", "주식 총수 (Total Shares)",
    "Get total outstanding shares by type.\nArgs: corp_code, bsns_year, reprt_code",
    "stockTotqySttus",
    [{ key: "se", label: "구분" }, { key: "isu_stock_totqy", label: "발행주식총수" },
     { key: "now_to_isu_stock_totqy", label: "현재상장주식수" },
     { key: "now_to_dcrs_stock_co", label: "현재감소주식수" }]
  );

  registerPeriodicTool(server,
    "opendart_auditor_opinion", "감사인/감사의견 (Auditor Opinion)",
    "Get external auditor name and audit opinion.\nArgs: corp_code, bsns_year, reprt_code",
    "accnutAdtorNmNdAdtOpinion",
    [{ key: "bsns_year", label: "사업연도" }, { key: "adtor", label: "감사인" },
     { key: "adt_opinion", label: "감사의견" }, { key: "adt_reprt_spcmnt_matter", label: "특기사항" }]
  );

  registerPeriodicTool(server,
    "opendart_treasury_stock", "자기주식 (Treasury Stock)",
    "Get treasury stock acquisition and disposal status.\nArgs: corp_code, bsns_year, reprt_code",
    "tesstkAcqsDspsSttus",
    [{ key: "acqs_mth1", label: "취득방법" }, { key: "stock_knd", label: "주식종류" },
     { key: "bsis_qy", label: "기초수량" }, { key: "change_qy_acqs", label: "취득수량" },
     { key: "change_qy_dsps", label: "처분수량" }, { key: "change_qy_incnr", label: "소각수량" },
     { key: "trmend_qy", label: "기말수량" }]
  );
}
