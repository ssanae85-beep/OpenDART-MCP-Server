import { CORP_CLS_MAP, REPORT_CODES } from "./types";

export function formatNumber(val: string | number | undefined): string {
  if (val === undefined || val === null || val === "" || val === "-") return "-";
  const num = typeof val === "string" ? parseInt(val.replace(/,/g, ""), 10) : val;
  if (isNaN(num)) return String(val);
  return num.toLocaleString("ko-KR");
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

export interface FinancialContext {
  bsns_year?: string;
  reprt_code?: string;
  fs_div?: string;
}

export interface FinancialTableOptions {
  groupByFsDiv?: boolean;
  /** Request params — the response alone can't say which report it came from */
  context?: FinancialContext;
  /** corp_code → name, for responses covering several companies */
  corpNames?: Record<string, string>;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "2025.01.01 ~ 2025.09.30" → {sy,sm,ey,em}; "2025.09.30 현재" → null */
function parseRange(dt: unknown): { sy: number; sm: number; ey: number; em: number } | null {
  const m = str(dt).match(/(\d{4})\.(\d{2})\.(\d{2})\s*~\s*(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  return { sy: +m[1], sm: +m[2], ey: +m[4], em: +m[5] };
}

function spanLabel(sy: number, sm: number, ey: number, em: number): string {
  return sy === ey ? `${sy}.${pad2(sm)}~${pad2(em)}` : `${sy}.${pad2(sm)}~${ey}.${pad2(em)}`;
}

/**
 * The three-month window a quarterly thstrm_amount covers.
 *
 * Derived from the END of thstrm_dt, never from reprt_code: a March-closing
 * company's Q3 is Oct–Dec, so mapping 11014 to "7~9월" would be wrong. Walking
 * back from the range's end works whatever the fiscal year start.
 */
function quarterLabel(dt: unknown): string | null {
  const r = parseRange(dt);
  if (!r) return null;
  let sm = r.em - 2;
  let sy = r.ey;
  if (sm <= 0) {
    sm += 12;
    sy -= 1;
  }
  return spanLabel(sy, sm, r.ey, r.em);
}

/** The full period thstrm_dt describes — for quarterlies this is the cumulative range. */
function cumulativeLabel(dt: unknown): string | null {
  const r = parseRange(dt);
  if (!r) return null;
  return spanLabel(r.sy, r.sm, r.ey, r.em);
}

interface AmountColumn {
  key: string;
  label: string;
}

/**
 * Columns are chosen from the fields actually present, because the endpoints
 * disagree: fnlttSinglAcnt has thstrm_dt but fnlttSinglAcntAll doesn't, and only
 * the latter carries frmtrm_q_amount. Anything present gets a column; nothing
 * the API sent is dropped.
 */
function buildColumns(rows: Array<Record<string, unknown>>): AmountColumn[] {
  const has = (k: string) => rows.some((r) => str(r[k]) !== "");

  // A cumulative figure alongside the current one means the current one is the
  // quarter alone (proven by Q1 filings, where the two are equal).
  const quarterly = has("thstrm_add_amount");
  const cols: AmountColumn[] = [];

  if (has("thstrm_amount")) {
    cols.push({ key: "thstrm_amount", label: quarterly ? "당기 3개월" : "당기" });
  }
  if (has("thstrm_add_amount")) {
    cols.push({ key: "thstrm_add_amount", label: "당기 누계" });
  }
  if (has("frmtrm_q_amount")) {
    cols.push({ key: "frmtrm_q_amount", label: "전기 분기" });
  }
  if (has("frmtrm_amount")) {
    cols.push({
      key: "frmtrm_amount",
      label: has("frmtrm_add_amount") ? "전기 3개월" : "전기",
    });
  }
  if (has("frmtrm_add_amount")) {
    cols.push({ key: "frmtrm_add_amount", label: "전기 누계" });
  }
  if (has("bfefrmtrm_amount")) {
    cols.push({ key: "bfefrmtrm_amount", label: "전전기" });
  }

  return cols;
}

/** Spell out what each period column covers, so "당기" is never ambiguous. */
function periodLines(rows: Array<Record<string, unknown>>): string[] {
  const first = rows[0];
  const lines: string[] = [];

  const describe = (nmKey: string, dtKey: string, addKey: string, label: string) => {
    const nm = str(first[nmKey]);
    const dt = str(first[dtKey]);
    if (!nm && !dt) return;

    const parts: string[] = [];
    if (nm) parts.push(nm);

    const hasAdd = rows.some((r) => str(r[addKey]) !== "");
    if (hasAdd) {
      const q = quarterLabel(dt);
      const c = cumulativeLabel(dt);
      if (q) parts.push(`3개월 ${q}`);
      if (c) parts.push(`누계 ${c}`);
    } else if (dt) {
      const c = cumulativeLabel(dt);
      parts.push(c ?? dt);
    }

    if (parts.length > 0) lines.push(`- ${label}: ${parts.join(" · ")}`);
  };

  describe("thstrm_nm", "thstrm_dt", "thstrm_add_amount", "당기");
  describe("frmtrm_nm", "frmtrm_dt", "frmtrm_add_amount", "전기");

  const bfeNm = str(first.bfefrmtrm_nm);
  if (bfeNm) lines.push(`- 전전기: ${bfeNm}${str(first.bfefrmtrm_dt) ? ` · ${cumulativeLabel(first.bfefrmtrm_dt) ?? str(first.bfefrmtrm_dt)}` : ""}`);

  return lines;
}

function renderGroup(
  rows: Array<Record<string, unknown>>,
  heading: string,
  corpNames?: Record<string, string>
): string {
  const cols = buildColumns(rows);
  const companies = [...new Set(rows.map((r) => str(r.corp_code)).filter(Boolean))];
  const showCorp = companies.length > 1;

  const lines = [`### ${heading}`];

  const periods = periodLines(rows);
  if (periods.length > 0) lines.push(...periods);
  lines.push("");

  const header = [...(showCorp ? ["회사"] : []), "계정명", ...cols.map((c) => c.label)];
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);

  for (const row of rows) {
    const cells: string[] = [];
    if (showCorp) {
      const code = str(row.corp_code);
      const name = corpNames?.[code];
      const stock = str(row.stock_code);
      cells.push(name ? `${name}${stock ? ` (${stock})` : ""}` : code);
    }
    cells.push(str(row.account_nm) || "-");
    for (const c of cols) cells.push(formatNumber(row[c.key] as string));
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

/** One table per statement type: only 손익계산서 rows carry a cumulative column. */
function renderByStatement(
  rows: Array<Record<string, unknown>>,
  corpNames?: Record<string, string>
): string[] {
  const order: string[] = [];
  const groups = new Map<string, Array<Record<string, unknown>>>();

  for (const row of rows) {
    const key = str(row.sj_div) || str(row.sj_nm) || "기타";
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }

  // Blank line between tables: a heading straight after a table row doesn't
  // render as a heading.
  return order.flatMap((key, i) => {
    const g = groups.get(key)!;
    const name = str(g[0].sj_nm) || key;
    const table = renderGroup(g, `${name} (${key})`, corpNames);
    return i === 0 ? [table] : ["", table];
  });
}

export function formatFinancialTableMd(
  items: Array<Record<string, unknown>>,
  title: string,
  options: FinancialTableOptions = {}
): string {
  if (!items || items.length === 0) {
    return `## ${title}\nNo data available. / 데이터가 없습니다.`;
  }

  const { groupByFsDiv = true, context, corpNames } = options;
  const first = items[0];

  const meta: string[] = [];
  const year = context?.bsns_year ?? str(first.bsns_year);
  const code = context?.reprt_code ?? str(first.reprt_code);
  if (year && code) meta.push(`${year}년 ${formatReportCode(code)}`);
  else if (year) meta.push(`${year}년`);
  const currency = str(first.currency);
  if (currency) meta.push(`단위: ${currency}`);

  const sections = [`## ${title}`];
  if (meta.length > 0) sections.push(meta.join(" · "));

  if (groupByFsDiv) {
    const cfs = items.filter((i) => i.fs_div === "CFS");
    const ofs = items.filter((i) => i.fs_div === "OFS");

    if (cfs.length > 0 && ofs.length > 0) {
      sections.push("", "## 연결재무제표 (Consolidated)", ...renderByStatement(cfs, corpNames));
      sections.push("", "## 별도재무제표 (Separate)", ...renderByStatement(ofs, corpNames));
      return sections.join("\n");
    }

    const fsNm = str(first.fs_nm) || (context?.fs_div === "OFS" ? "별도재무제표" : context?.fs_div === "CFS" ? "연결재무제표" : "");
    if (fsNm) sections[sections.length - 1] += ` · ${fsNm}`;
  }

  sections.push("", ...renderByStatement(items, corpNames));
  return sections.join("\n");
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
