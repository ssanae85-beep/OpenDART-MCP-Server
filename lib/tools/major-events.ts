import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getJson, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError, isNoData } from "@/lib/opendart/errors";
import { formatGenericTableMd } from "@/lib/opendart/formatters";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function registerEventTool(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  endpoint: string,
  columns: Array<{ key: string; label: string }>
) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        corp_code: z.string().length(8).describe("8-digit company code"),
        api_key: z.string().optional().describe("Optional: your own API key"),
      },
      annotations,
    },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);
        const data = await getJson(endpoint, { corp_code: params.corp_code }, key);

        if (isNoData(data.status as string)) {
          return { content: [{ type: "text" as const, text: `No ${title} data found. / 데이터 없음` }] };
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

export function registerMajorEventTools(server: McpServer) {
  registerEventTool(server,
    "opendart_capital_increase", "유상증자 결정 (Capital Increase)",
    "Get paid-in capital increase decision reports.\nArgs: corp_code",
    "piicDecsn",
    [{ key: "rcept_no", label: "접수번호" }, { key: "rcept_dt", label: "접수일" },
     { key: "nstk_ostk_cnt", label: "신주보통주수" }, { key: "nstk_estk_cnt", label: "신주우선주수" },
     { key: "fv_ps", label: "액면가" }, { key: "bfic_tisstk_ostk", label: "증자전보통주총수" },
     { key: "fdpp_fclt", label: "자금조달목적-시설" }, { key: "fdpp_bsninh", label: "자금조달목적-운영" }]
  );

  registerEventTool(server,
    "opendart_capital_decrease", "감자 결정 (Capital Decrease)",
    "Get capital reduction decision reports.\nArgs: corp_code",
    "crDecsn",
    [{ key: "rcept_no", label: "접수번호" }, { key: "rcept_dt", label: "접수일" },
     { key: "crstk_ostk_cnt", label: "감소보통주수" }, { key: "crstk_estk_cnt", label: "감소우선주수" },
     { key: "cr_re", label: "감자사유" }, { key: "cr_std_dt", label: "감자기준일" }]
  );

  registerEventTool(server,
    "opendart_merger", "합병 결정 (Merger Decision)",
    "Get merger decision reports.\nArgs: corp_code",
    "mgDecsn",
    [{ key: "rcept_no", label: "접수번호" }, { key: "rcept_dt", label: "접수일" },
     { key: "mgnm", label: "합병상대방" }, { key: "mgsc", label: "합병비율" },
     { key: "mghlsc", label: "합병형태" }, { key: "mgmthn", label: "합병방법" },
     { key: "mg_pp", label: "합병목적" }]
  );

  registerEventTool(server,
    "opendart_stock_dividend", "주식배당 결정 (Stock Dividend)",
    "Get stock dividend decision reports.\nArgs: corp_code",
    "stDecsn",
    [{ key: "rcept_no", label: "접수번호" }, { key: "rcept_dt", label: "접수일" },
     { key: "stk_knd", label: "주식종류" }, { key: "stk_co", label: "주식수" },
     { key: "stk_fv", label: "액면가" }, { key: "stk_std_dt", label: "배당기준일" }]
  );

  registerEventTool(server,
    "opendart_disposal_treasury_stock", "자기주식 처분 결정 (Treasury Stock Disposal)",
    "Get treasury stock disposal decision reports.\nArgs: corp_code",
    "tsstDpDecsn",
    [{ key: "rcept_no", label: "접수번호" }, { key: "rcept_dt", label: "접수일" },
     { key: "dp_stk_knd", label: "주식종류" }, { key: "dp_stk_cnt", label: "처분주식수" },
     { key: "dp_prc", label: "처분가격" }, { key: "dp_pp", label: "처분목적" }]
  );
}
