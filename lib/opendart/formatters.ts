import { CORP_CLS_MAP, REPORT_CODES } from "./types";

export type AmountUnit = "won" | "eok" | "jo" | "auto";

export function formatNumber(val: string | number | undefined): string {
  if (val === undefined || val === null || val === "" || val === "-") return "-";
  const num = typeof val === "string" ? parseInt(val.replace(/,/g, ""), 10) : val;
  if (isNaN(num)) return String(val);
  return num.toLocaleString("ko-KR");
}

export function formatAmount(val: string | number | undefined, unit: AmountUnit = "auto"): string {
  if (val === undefined || val === null || val === "" || val === "-") return "-";
  const num = typeof val === "string" ? parseInt(val.replace(/,/g, ""), 10) : val;
  if (isNaN(num)) return String(val);

  if (unit === "auto") {
    const abs = Math.abs(num);
    if (abs >= 1_000_000_000_000) return (num / 1_000_000_000_000).toFixed(1) + "조";
    if (abs >= 100_000_000) return Math.round(num / 100_000_000).toLocaleString("ko-KR") + "억";
    if (abs >= 10_000) return Math.round(num / 10_000).toLocaleString("ko-KR") + "만";
    return num.toLocaleString("ko-KR");
  }

  const divisors: Record<string, number> = { won: 1, eok: 100_000_000, jo: 1_000_000_000_000 };
  const labels: Record<string, string> = { won: "", eok: "억", jo: "조" };
  const result = num / divisors[unit];
  return result.toLocaleString("ko-KR", { maximumFractionDigits: unit === "won" ? 0 : 1 }) + labels[unit];
}

export function getAmountUnitLabel(unit: AmountUnit): string {
  const labels: Record<AmountUnit, string> = {
    auto: "자동 (조/억/만)",
    won: "원",
    eok: "억원",
    jo: "조원",
  };
  return labels[unit];
}

export function formatCorpCls(cls: string): string {
  return CORP_CLS_MAP[cls] || cls;
}

export function formatReportCode(code: string): string {
  return REPORT_CODES[code] || code;
}

export function formatCompanyInfoMd(info: Record<string, unknown>): string {
  const lines = [
    `## ${info.corp_name} (${info.corp_name_eng || ""})`,
    "",
    `| 항목 | 내용 |`,
    `|------|------|`,
    `| 종목코드 (Stock Code) | ${info.stock_code || "비상장"} |`,
    `| 시장 (Market) | ${formatCorpCls(String(info.corp_cls || ""))} |`,
    `| 대표이사 (CEO) | ${info.ceo_nm || "-"} |`,
    `| 법인등록번호 | ${info.jurir_no || "-"} |`,
    `| 사업자등록번호 | ${info.bizr_no || "-"} |`,
    `| 주소 (Address) | ${info.adres || "-"} |`,
    `| 홈페이지 | ${info.hm_url || "-"} |`,
    `| 전화번호 | ${info.phn_no || "-"} |`,
    `| 업종코드 | ${info.induty_code || "-"} |`,
    `| 설립일 (Est.) | ${info.est_dt || "-"} |`,
    `| 결산월 (Fiscal) | ${info.acc_mt || "-"}월 |`,
  ];
  return lines.join("\n");
}

export function formatDisclosureListMd(
  items: Array<Record<string, unknown>>,
  totalCount: number,
  page: number,
  totalPage: number
): string {
  if (!items || items.length === 0) {
    return "No disclosures found. / 조회된 공시가 없습니다.";
  }

  const lines = [
    `## 공시 검색 결과 (Disclosure Search Results)`,
    `총 ${totalCount}건 중 ${page}/${totalPage} 페이지`,
    "",
    `| 날짜 | 회사명 | 보고서명 | 접수번호 |`,
    `|------|--------|----------|----------|`,
  ];

  for (const item of items) {
    lines.push(
      `| ${item.rcept_dt} | ${item.corp_name} (${formatCorpCls(String(item.corp_cls))}) | ${item.report_nm} | ${item.rcept_no} |`
    );
  }

  return lines.join("\n");
}

export interface FinancialTableOptions {
  groupByFsDiv?: boolean;
  amountUnit?: AmountUnit;
}

function renderFinancialRows(
  items: Array<Record<string, unknown>>,
  title: string,
  unit: AmountUnit
): string {
  const first = items[0];
  const hasThreeTerms = first.bfefrmtrm_amount !== undefined;
  const fmt = (v: string | number | undefined) => formatAmount(v, unit);

  const lines = [`### ${title}`, ""];

  if (hasThreeTerms) {
    lines.push(
      `| 재무제표 | 계정명 | 당기 (${first.thstrm_nm || "Current"}) | 전기 (${first.frmtrm_nm || "Prior"}) | 전전기 (${first.bfefrmtrm_nm || "Pre-Prior"}) |`,
      `|----------|--------|------|------|--------|`
    );
    for (const item of items) {
      lines.push(
        `| ${item.sj_nm} | ${item.account_nm} | ${fmt(item.thstrm_amount as string)} | ${fmt(item.frmtrm_amount as string)} | ${fmt(item.bfefrmtrm_amount as string)} |`
      );
    }
  } else {
    lines.push(
      `| 재무제표 | 계정명 | 당기 | 전기 |`,
      `|----------|--------|------|------|`
    );
    for (const item of items) {
      lines.push(
        `| ${item.sj_nm} | ${item.account_nm} | ${fmt(item.thstrm_amount as string)} | ${fmt(item.frmtrm_amount as string)} |`
      );
    }
  }

  lines.push("", `> 금액 단위: ${getAmountUnitLabel(unit)}`);
  return lines.join("\n");
}

export function formatFinancialTableMd(
  items: Array<Record<string, unknown>>,
  title: string,
  options: FinancialTableOptions = {}
): string {
  if (!items || items.length === 0) {
    return `## ${title}\nNo data available. / 데이터가 없습니다.`;
  }

  const { groupByFsDiv = true, amountUnit = "auto" } = options;

  if (groupByFsDiv) {
    const cfs = items.filter(i => i.fs_div === "CFS");
    const ofs = items.filter(i => i.fs_div === "OFS");

    // 둘 다 있으면 분리 출력
    if (cfs.length > 0 && ofs.length > 0) {
      const sections = [`## ${title}`];
      sections.push("", renderFinancialRows(cfs, "연결재무제표 (Consolidated)", amountUnit));
      sections.push("", renderFinancialRows(ofs, "별도재무제표 (Separate)", amountUnit));
      return sections.join("\n");
    }
  }

  // 한 종류만 있거나 그룹핑 비활성 시
  return `## ${title}\n\n${renderFinancialRows(items, title, amountUnit)}`;
}

export function formatGenericTableMd(
  items: Array<Record<string, unknown>>,
  title: string,
  columns: Array<{ key: string; label: string }>
): string {
  if (!items || items.length === 0) {
    return `## ${title}\nNo data available. / 데이터가 없습니다.`;
  }

  const header = columns.map((c) => c.label).join(" | ");
  const separator = columns.map(() => "------").join(" | ");

  const lines = [
    `## ${title}`,
    "",
    `| ${header} |`,
    `| ${separator} |`,
  ];

  for (const item of items) {
    const row = columns.map((c) => String(item[c.key] ?? "-")).join(" | ");
    lines.push(`| ${row} |`);
  }

  return lines.join("\n");
}

export function formatPagination(page: number, totalCount: number, totalPage: number): string {
  return `\n---\nPage ${page}/${totalPage} (Total: ${totalCount})`;
}
