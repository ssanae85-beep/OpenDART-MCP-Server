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
  /**
   * fnlttSinglAcntAll output: drop 자본변동표 and blank/duplicate rows, tell
   * same-named accounts apart by account_id, and give a quarterly 현금흐름표
   * cumulative columns only.
   */
  fullStatement?: boolean;
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
  /** Read the cell some other way than row[key] */
  get?: (row: Record<string, unknown>) => unknown;
}

const firstFilled = (row: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (str(row[k]) !== "") return row[k];
  return undefined;
};

/**
 * Quarterly cash flow statements are filed cumulative only (1~6월 for a 반기),
 * so a CF table gets 누계 columns and nothing that could pass for three months.
 * fnlttSinglAcntAll puts the cumulative figure in thstrm_amount and the prior
 * year's in frmtrm_q_amount; prefer an explicit *_add_amount if one is sent.
 */
const CF_CUMULATIVE_COLUMNS: AmountColumn[] = [
  { key: "thstrm_add_amount", label: "당기 누계", get: (r) => firstFilled(r, ["thstrm_add_amount", "thstrm_amount"]) },
  { key: "frmtrm_add_amount", label: "전기 누계", get: (r) => firstFilled(r, ["frmtrm_add_amount", "frmtrm_q_amount", "frmtrm_amount"]) },
];

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
    cols.push({ key: "frmtrm_q_amount", label: "전기 3개월" });
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

interface GroupRender {
  cols?: AmountColumn[];
  nameOf?: (row: Record<string, unknown>) => string;
  notes?: string[];
}

function renderGroup(
  rows: Array<Record<string, unknown>>,
  heading: string,
  corpNames?: Record<string, string>,
  how: GroupRender = {}
): string {
  const cols = how.cols ?? buildColumns(rows);
  const companies = [...new Set(rows.map((r) => str(r.corp_code)).filter(Boolean))];
  const showCorp = companies.length > 1;

  const lines = [`### ${heading}`];

  const periods = periodLines(rows);
  if (periods.length > 0) lines.push(...periods);
  if (how.notes) lines.push(...how.notes);
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
    cells.push((how.nameOf ? how.nameOf(row) : str(row.account_nm)) || "-");
    for (const c of cols) cells.push(formatNumber((c.get ? c.get(row) : row[c.key]) as string));
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

/** Plain-language tags for account_ids that share a Korean name in IS/CIS. */
const ATTRIBUTION: Record<string, string> = {
  ProfitLossAttributableToOwnersOfParent: "당기순이익 귀속",
  ProfitLossAttributableToNoncontrollingInterests: "당기순이익 귀속",
  ComprehensiveIncomeAttributableToOwnersOfParent: "총포괄손익 귀속",
  ComprehensiveIncomeAttributableToNoncontrollingInterests: "총포괄손익 귀속",
};

/** "ifrs-full_ProfitLossAttributableToOwnersOfParent" → "ProfitLossAttributableToOwnersOfParent" */
const bareId = (id: string) => id.replace(/^(ifrs-full|ifrs|dart|k-ifrs)_/, "");

/**
 * Statements whose rows a reader compares directly. 손익계산서 and 포괄손익계산서
 * share one scope: both carry a "지배기업 소유주지분" line, one for 당기순이익 and
 * one for 총포괄손익, and reading the wrong one is the classic mistake.
 */
const nameScope = (row: Record<string, unknown>) => {
  const sj = str(row.sj_div);
  return sj === "IS" || sj === "CIS" ? "IS+CIS" : sj;
};

/**
 * Row label that stays unique: an account name used by more than one
 * account_id within its scope gets the id appended, and the 지배/비지배 귀속
 * lines always say whether they split 당기순이익 or 총포괄손익.
 */
function accountNamer(rows: Array<Record<string, unknown>>) {
  const ids = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = `${nameScope(r)}|${str(r.account_nm).trim()}`;
    if (!ids.has(k)) ids.set(k, new Set());
    ids.get(k)!.add(str(r.account_id));
  }
  return (r: Record<string, unknown>) => {
    const nm = str(r.account_nm).trim();
    const id = bareId(str(r.account_id));
    const what = ATTRIBUTION[id];
    // The attribution lines are tagged even when unique: a lone "지배기업 소유주지분"
    // in 포괄손익계산서 is still 총포괄손익, not 순이익.
    if (!what && (ids.get(`${nameScope(r)}|${nm}`)?.size ?? 0) < 2) return nm;
    return `${nm} [${id}${what ? ` · ${what}` : ""}]`;
  };
}

const AMOUNT_KEYS = ["thstrm_amount", "thstrm_add_amount", "frmtrm_amount", "frmtrm_q_amount", "frmtrm_add_amount", "bfefrmtrm_amount"];

/** Drop 자본변동표, rows without an account name, and exact repeats. */
function cleanFullStatement(rows: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (str(r.sj_div) === "SCE") return false;
    if (str(r.account_nm).trim() === "") return false;
    const k = [r.corp_code, r.fs_div, r.sj_div, r.account_id, str(r.account_nm).trim(), r.account_detail, ...AMOUNT_KEYS.map((a) => r[a])].map(str).join("\u0001");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * fnlttSinglAcntAll fills a quarterly CF line that shares its account_id with
 * the income statement (반기순이익 = ifrs-full_ProfitLoss) with the IS three-month
 * figure, not the cumulative one the cash flow statement is built on: 삼성전자
 * 2026 반기 CF 반기순이익 comes back 71.6조 (Q2 alone) while the statement
 * reconciles to OCF only with 118.8조 (H1). Where a CF value equals the IS
 * 3-month figure and not its 누계, the IS 누계 is shown instead — and said so.
 */
function fixCfCumulative(cf: Array<Record<string, unknown>>, all: Array<Record<string, unknown>>) {
  const pl = new Map<string, Record<string, unknown>>();
  for (const r of all) {
    const sj = str(r.sj_div), id = str(r.account_id);
    if ((sj === "IS" || sj === "CIS") && id.includes("_") && !pl.has(id)) pl.set(id, r);
  }
  const notes: string[] = [];
  const rows = cf.map((r) => {
    const is = pl.get(str(r.account_id));
    if (!is) return r;
    const swap = (cfKey: string, qKey: string, addKey: string) => {
      const v = str(r[cfKey]), q = str(is[qKey]), add = str(is[addKey]);
      return v !== "" && v === q && add !== "" && add !== q ? is[addKey] : undefined;
    };
    const cur = swap("thstrm_amount", "thstrm_amount", "thstrm_add_amount");
    const prev = swap("frmtrm_q_amount", "frmtrm_q_amount", "frmtrm_add_amount");
    if (cur === undefined && prev === undefined) return r;
    const which = [cur !== undefined ? "당기" : "", prev !== undefined ? "전기" : ""].filter(Boolean).join("·");
    notes.push(`- ${str(r.account_nm).trim()}: API가 손익계산서 3개월 값(${formatNumber(r.thstrm_amount as string)})을 줘서 ${which}를 손익계산서 누계로 표시`);
    return {
      ...r,
      ...(cur !== undefined ? { thstrm_add_amount: cur } : {}),
      ...(prev !== undefined ? { frmtrm_add_amount: prev } : {}),
      _fixed: true,
    };
  });
  return { rows, notes };
}

const amount = (v: unknown): number | null => {
  const t = str(v).replace(/,/g, "").trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
};

/**
 * 지배기업 귀속 당기순이익 must equal 당기순이익 − 비지배 귀속 당기순이익. Some filings
 * break that by copying the 총포괄손익 귀속 figure into the 당기순이익 귀속 line —
 * 티앤엘 2025 반기 files 75.9억 there against 당기순이익 78.3억 with 비지배 0 — and
 * the API passes it through. In each column where the identity fails, the line
 * shows 당기순이익 − 비지배 instead, and the filed value is stated.
 */
function fixParentProfit(rows: Array<Record<string, unknown>>) {
  const pick = (id: string) => rows.find((r) => (str(r.sj_div) === "IS" || str(r.sj_div) === "CIS") && bareId(str(r.account_id)) === id);
  const pl = pick("ProfitLoss"), nci = pick("ProfitLossAttributableToNoncontrollingInterests");
  const parent = pick("ProfitLossAttributableToOwnersOfParent"), ci = pick("ComprehensiveIncomeAttributableToOwnersOfParent");
  const notes = new Map<string, string[]>();
  if (!pl || !nci || !parent) return { rows, notes };

  const patch: Record<string, string> = {};
  const filed: string[] = [];
  let copiedCi = true;
  for (const k of AMOUNT_KEYS) {
    const p = amount(pl[k]), n = amount(nci[k]), o = amount(parent[k]);
    if (p == null || n == null || o == null || o + n === p) continue;
    patch[k] = String(p - n);
    filed.push(formatNumber(str(parent[k])));
    if (!ci || amount(ci[k]) !== o) copiedCi = false;
  }
  if (filed.length === 0) return { rows, notes };

  notes.set(str(parent.sj_div), [
    `- ${str(parent.account_nm).trim()}: 원문 값(${filed.join(" / ")})이 당기순이익 − 비지배 귀속과 맞지 않아 당기순이익 − 비지배로 표시` +
      (copiedCi ? " (원문 값은 총포괄손익 귀속과 같은 값)" : ""),
  ]);
  return { rows: rows.map((r) => (r === parent ? { ...r, ...patch, _fixed: true } : r)), notes };
}

interface FullStatementRender {
  quarterly: boolean;
  nameOf: (row: Record<string, unknown>) => string;
}

/** One table per statement type: only 손익계산서 rows carry a cumulative column. */
function renderByStatement(
  rows: Array<Record<string, unknown>>,
  corpNames?: Record<string, string>,
  full?: FullStatementRender
): string[] {
  let notesBySj = new Map<string, string[]>();
  if (full) ({ rows, notes: notesBySj } = fixParentProfit(rows));
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
    let g = groups.get(key)!;
    const name = str(g[0].sj_nm) || key;
    const how: GroupRender = full
      ? { nameOf: (r) => `${full.nameOf(r)}${r._fixed ? " ※" : ""}`, notes: [...(notesBySj.get(key) ?? [])] }
      : {};
    if (full?.quarterly && key === "CF") {
      const fixed = fixCfCumulative(g, rows);
      g = fixed.rows;
      how.cols = CF_CUMULATIVE_COLUMNS;
      how.notes = ["- 현금흐름표는 누계로만 공시된다 — 3개월 열 없음", ...fixed.notes, ...(how.notes ?? [])];
    }
    const table = renderGroup(g, `${name} (${key})`, corpNames, how);
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

  const { groupByFsDiv = true, context, corpNames, fullStatement = false } = options;
  let full: FullStatementRender | undefined;
  let droppedSce = false;
  if (fullStatement) {
    const dropped = items.some((i) => str(i.sj_div) === "SCE");
    items = cleanFullStatement(items);
    if (items.length === 0) return `## ${title}\nNo data available. / 데이터가 없습니다.`;
    const code = context?.reprt_code ?? str(items[0].reprt_code);
    full = {
      quarterly: (code !== "" && code !== "11011") || items.some((i) => str(i.thstrm_add_amount) !== ""),
      nameOf: accountNamer(items),
    };
    droppedSce = dropped;
  }
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
  if (droppedSce) sections.push("자본변동표(SCE)는 기본 출력에서 제외");

  if (groupByFsDiv) {
    const cfs = items.filter((i) => i.fs_div === "CFS");
    const ofs = items.filter((i) => i.fs_div === "OFS");

    if (cfs.length > 0 && ofs.length > 0) {
      sections.push("", "## 연결재무제표 (Consolidated)", ...renderByStatement(cfs, corpNames, full));
      sections.push("", "## 별도재무제표 (Separate)", ...renderByStatement(ofs, corpNames, full));
      return sections.join("\n");
    }

    const fsNm = str(first.fs_nm) || (context?.fs_div === "OFS" ? "별도재무제표" : context?.fs_div === "CFS" ? "연결재무제표" : "");
    if (fsNm) sections[sections.length - 1] += ` · ${fsNm}`;
  }

  sections.push("", ...renderByStatement(items, corpNames, full));
  return sections.join("\n");
}

/**
 * stockTotqySttus by field name. Rows are what is counted, columns are the
 * share class, so "발행할 주식의 총수" (authorized, isu_stock_totqy) can't be
 * read as "발행주식의 총수" (issued, istc_totqy) the way a positional table let it.
 */
const SHARE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "isu_stock_totqy", label: "발행할 주식의 총수" },
  { key: "istc_totqy", label: "발행주식의 총수" },
  { key: "tesstk_co", label: "자기주식수" },
  { key: "distb_stock_co", label: "유통주식수" },
];

/** se comes as "보통주" or "의결권 있는 주식\n(보통주)"; 비고 rows carry footnotes, not counts */
function shareClass(se: string): "common" | "preferred" | "total" | null {
  const s = se.replace(/\s+/g, "");
  if (s.includes("합계")) return "total";
  if (s.includes("비고")) return null;
  if (s.includes("보통")) return "common";
  if (s.includes("우선") || s.includes("종류")) return "preferred";
  return null;
}

const shareCount = (v: unknown): number | null => {
  const t = str(v).replace(/,/g, "").trim();
  if (t === "" || t === "-") return 0;
  return /^-?\d+$/.test(t) ? Number(t) : null;
};

export function formatTotalSharesMd(items: Array<Record<string, unknown>>, title: string): string {
  if (!items || items.length === 0) {
    return `## ${title}\nNo data available. / 데이터가 없습니다.`;
  }
  const by = { common: [] as Array<Record<string, unknown>>, preferred: [] as Array<Record<string, unknown>>, total: [] as Array<Record<string, unknown>> };
  const unknown: string[] = [];
  for (const r of items) {
    const c = shareClass(str(r.se));
    if (c) by[c].push(r);
    else if (!str(r.se).replace(/\s+/g, "").includes("비고")) unknown.push(str(r.se).replace(/\s+/g, " ").trim());
  }

  // One class may come as several rows (1우선주·2우선주): shown summed, and said so
  const cell = (rows: Array<Record<string, unknown>>, key: string): { text: string; n: number | null } => {
    if (rows.length === 0) return { text: "-", n: 0 };
    if (rows.length === 1) return { text: formatNumber(str(rows[0][key])), n: shareCount(rows[0][key]) };
    const ns = rows.map((r) => shareCount(r[key]));
    if (ns.some((n) => n == null)) return { text: rows.map((r) => str(r[key])).join(" / "), n: null };
    const sum = (ns as number[]).reduce((a, b) => a + b, 0);
    return { text: formatNumber(sum), n: sum };
  };

  const stlm = str(items[0].stlm_dt);
  const lines = [`## ${title}`];
  if (stlm) lines.push(`기준일: ${stlm}`);
  lines.push("", "| 항목 | 보통주 | 우선주 | 합계 | 비고 |", "| --- | --- | --- | --- | --- |");

  for (const f of SHARE_FIELDS) {
    const c = cell(by.common, f.key), p = cell(by.preferred, f.key);
    const t = by.total.length ? { text: formatNumber(str(by.total[0][f.key])), n: shareCount(by.total[0][f.key]) } : { text: "-", n: null };
    const notes: string[] = [];
    if (t.n != null && c.n != null && p.n != null && by.total.length && t.n !== c.n + p.n) notes.push("원문 합계 불일치");
    if (by.preferred.length > 1) notes.push(`우선주 ${by.preferred.length}종 합산`);
    lines.push(`| ${f.label} (${f.key}) | ${c.text} | ${p.text} | ${t.text} | ${notes.join(", ")} |`);
  }
  if (unknown.length) lines.push("", `분류하지 못한 구분: ${unknown.join(", ")}`);
  return lines.join("\n");
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
