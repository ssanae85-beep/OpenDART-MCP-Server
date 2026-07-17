/**
 * Financial formatter checks. Fixtures are verbatim rows from the live API
 * (삼성전자 00126380), so the shapes are real. No API key needed.
 *
 * Usage: npm run test:financial
 */
import { formatFinancialTableMd } from "../lib/opendart/formatters";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

/** fnlttSinglAcnt, bsns_year=2025 reprt_code=11014 (Q3) — verbatim */
const Q3_ROWS = [
  {
    rcept_no: "20251114002447", reprt_code: "11014", bsns_year: "2025", corp_code: "00126380",
    stock_code: "005930", fs_div: "CFS", fs_nm: "연결재무제표", sj_div: "BS", sj_nm: "재무상태표",
    account_nm: "유동자산",
    thstrm_nm: "제 57 기3분기말", thstrm_dt: "2025.09.30 현재", thstrm_amount: "229,440,881,000,000",
    frmtrm_nm: "제 56 기말", frmtrm_dt: "2024.12.31 현재", frmtrm_amount: "227,062,266,000,000",
    ord: "1", currency: "KRW",
  },
  {
    rcept_no: "20251114002447", reprt_code: "11014", bsns_year: "2025", corp_code: "00126380",
    stock_code: "005930", fs_div: "CFS", fs_nm: "연결재무제표", sj_div: "IS", sj_nm: "손익계산서",
    account_nm: "매출액",
    thstrm_nm: "제 57 기3분기", thstrm_dt: "2025.01.01 ~ 2025.09.30", thstrm_amount: "86,061,747,000,000",
    frmtrm_nm: "제 56 기3분기", frmtrm_dt: "2024.01.01 ~ 2024.09.30", frmtrm_amount: "79,098,731,000,000",
    ord: "19", currency: "KRW",
    thstrm_add_amount: "239,768,567,000,000",
    frmtrm_add_amount: "225,082,634,000,000",
  },
];

/** fnlttSinglAcnt, bsns_year=2024 reprt_code=11011 (annual) — no cumulative fields */
const ANNUAL_ROWS = [
  {
    reprt_code: "11011", bsns_year: "2024", corp_code: "00126380", fs_div: "CFS", fs_nm: "연결재무제표",
    sj_div: "IS", sj_nm: "손익계산서", account_nm: "매출액",
    thstrm_nm: "제 56 기", thstrm_dt: "2024.01.01 ~ 2024.12.31", thstrm_amount: "300,870,903,000,000",
    frmtrm_nm: "제 55 기", frmtrm_dt: "2023.01.01 ~ 2023.12.31", frmtrm_amount: "258,935,494,000,000",
    bfefrmtrm_nm: "제 54 기", bfefrmtrm_dt: "2022.01.01 ~ 2022.12.31", bfefrmtrm_amount: "302,231,360,000,000",
    currency: "KRW",
  },
];

console.log("=== Q3: the reported bug ===");
const q3 = formatFinancialTableMd(Q3_ROWS, "단일회사 주요계정", {
  context: { bsns_year: "2025", reprt_code: "11014", fs_div: "CFS" },
});
console.log(q3);
console.log();

check("names the report", q3.includes("2025년 3분기보고서 (Q3)"), true);
check("names the statement type", q3.includes("연결재무제표"), true);
check("states the currency", q3.includes("단위: KRW"), true);

check("keeps the cumulative figure the API sent", q3.includes("239,768,567,000,000"), true);
check("labels current column as 3-month", q3.includes("당기 3개월"), true);
check("labels the cumulative column", q3.includes("당기 누계"), true);
check("labels prior columns too", q3.includes("전기 3개월") && q3.includes("전기 누계"), true);

// The trap: thstrm_dt is the CUMULATIVE range, so it must not label the 3-month column
check("3-month span derived, not copied from dt", q3.includes("3개월 2025.07~09"), true);
check("cumulative span shown", q3.includes("누계 2025.01~09"), true);
check("prior 3-month span", q3.includes("3개월 2024.07~09"), true);

// 재무상태표 has no cumulative — it must not grow the column
const bsTable = q3.split("### ")[1];
const isTable = q3.split("### ")[2];
check("BS table exists", bsTable.startsWith("재무상태표"), true);
check("IS table exists", isTable.startsWith("손익계산서"), true);
check("BS has no cumulative column", bsTable.includes("누계"), false);
check("BS keeps a plain 당기 column", bsTable.includes("| 당기 | 전기 |"), true);
check("BS shows its as-of date", bsTable.includes("2025.09.30 현재"), true);
check("IS has the cumulative column", isTable.includes("당기 누계"), true);

console.log("\n=== Annual: no cumulative fields exist ===");
const annual = formatFinancialTableMd(ANNUAL_ROWS, "단일회사 주요계정", {
  context: { bsns_year: "2024", reprt_code: "11011", fs_div: "CFS" },
});
console.log(annual);
console.log();

check("names the report", annual.includes("2024년 사업보고서 (Annual)"), true);
check("no cumulative column invented", annual.includes("누계"), false);
check("current column stays 당기", annual.includes("| 당기 |") || annual.includes("| 당기 | 전기 |"), true);
check("no 3-month label on an annual figure", annual.includes("3개월"), false);
check("full-year span shown", annual.includes("2024.01~12"), true);
check("pre-prior column kept", annual.includes("전전기") && annual.includes("302,231,360,000,000"), true);

console.log("\n=== March-closing company: quarter must not be assumed from reprt_code ===");
// Q3 for a March-closing filer covers Oct–Dec, not Jul–Sep
const MARCH_CLOSE = [{
  ...Q3_ROWS[1],
  thstrm_nm: "제 30 기3분기", thstrm_dt: "2025.04.01 ~ 2025.12.31",
  frmtrm_nm: "제 29 기3분기", frmtrm_dt: "2024.04.01 ~ 2024.12.31",
}];
const march = formatFinancialTableMd(MARCH_CLOSE, "단일회사 주요계정", {
  context: { bsns_year: "2025", reprt_code: "11014" },
});
check("derives Oct–Dec from the range end", march.includes("3개월 2025.10~12"), true);
check("does not assume Jul–Sep", march.includes("2025.07~09"), false);
check("cumulative reflects the fiscal year", march.includes("누계 2025.04~12"), true);

console.log("\n=== Multi-company: rows must say which company ===");
const MULTI = [
  { ...Q3_ROWS[1], corp_code: "00126380", stock_code: "005930" },
  { ...Q3_ROWS[1], corp_code: "00164779", stock_code: "000660", thstrm_amount: "22,000,000,000,000" },
];
const multi = formatFinancialTableMd(MULTI, "다중회사 주요계정", {
  context: { bsns_year: "2025", reprt_code: "11014" },
  corpNames: { "00126380": "삼성전자", "00164779": "SK하이닉스" },
});
console.log(multi);
check("company column added", multi.includes("| 회사 |"), true);
check("resolves names", multi.includes("삼성전자 (005930)") && multi.includes("SK하이닉스 (000660)"), true);

const single = formatFinancialTableMd(Q3_ROWS, "단일회사 주요계정", {});
check("single company gets no company column", single.includes("| 회사 |"), false);

console.log("\n=== fnlttSinglAcntAll shape: no fs_div, no thstrm_dt, has frmtrm_q_amount ===");
const ALL_ROWS = [{
  reprt_code: "11014", bsns_year: "2025", corp_code: "00126380",
  sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_Revenue", account_nm: "수익(매출액)",
  thstrm_nm: "제 57 기 3분기", thstrm_amount: "86,061,747,000,000",
  thstrm_add_amount: "239,768,567,000,000",
  frmtrm_q_nm: "제 56 기 3분기", frmtrm_q_amount: "79,098,731,000,000",
  frmtrm_nm: "제 56 기 3분기", frmtrm_amount: "79,098,731,000,000",
  frmtrm_add_amount: "225,082,634,000,000",
  currency: "KRW",
}];
const all = formatFinancialTableMd(ALL_ROWS, "전체 재무제표", {
  context: { bsns_year: "2025", reprt_code: "11014", fs_div: "CFS" },
});
console.log(all);
check("survives missing thstrm_dt", all.includes("수익(매출액)"), true);
check("keeps 전기 분기 column", all.includes("전기 분기"), true);
check("keeps cumulative", all.includes("239,768,567,000,000"), true);
check("no span label when dt is absent", all.includes("3개월 2025"), false);
check("still names the period", all.includes("제 57 기 3분기"), true);

console.log("\n=== empty ===");
check("empty list handled", formatFinancialTableMd([], "제목", {}).includes("데이터가 없습니다"), true);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
