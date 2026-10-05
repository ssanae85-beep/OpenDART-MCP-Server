/**
 * Financial formatter checks. Fixtures are verbatim rows from the live API
 * (삼성전자 00126380), so the shapes are real. No API key needed.
 *
 * Usage: npm run test:financial
 */
import { formatFinancialTableMd, formatTotalSharesMd } from "../lib/opendart/formatters";

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
check("prior-quarter column says 3개월", all.includes("전기 3개월") && !all.includes("전기 분기"), true);
check("keeps cumulative", all.includes("239,768,567,000,000"), true);
check("no span label when dt is absent", all.includes("3개월 2025"), false);
check("still names the period", all.includes("제 57 기 3분기"), true);

console.log("\n=== full statement (fnlttSinglAcntAll), 반기 ===");
// Row shapes and values verbatim from 삼성전자 2026 반기 CFS, trimmed to the lines
// that matter. The CF 반기순이익 row is the API's own: its thstrm_amount is the
// IS 3-month figure (71.6조), not the H1 cumulative (118.8조) the CF uses.
const H = { reprt_code: "11012", bsns_year: "2026", corp_code: "00126380", currency: "KRW", account_detail: "-" };
const isRow = (sj: string, id: string, nm: string, th: string, add: string, fq: string, fadd: string) =>
  ({ ...H, sj_div: sj, sj_nm: sj === "IS" ? "손익계산서" : "포괄손익계산서", account_id: id, account_nm: nm,
    thstrm_nm: "제 58 기 반기", thstrm_amount: th, thstrm_add_amount: add, frmtrm_q_nm: "제 57 기 반기", frmtrm_q_amount: fq, frmtrm_add_amount: fadd });
const cfRow = (id: string, nm: string, th: string, fq: string) =>
  ({ ...H, sj_div: "CF", sj_nm: "현금흐름표", account_id: id, account_nm: nm, thstrm_nm: "제 58 기 반기", thstrm_amount: th, frmtrm_q_nm: "제 57 기 반기", frmtrm_q_amount: fq });
const FULL_H1 = [
  { ...H, sj_div: "BS", sj_nm: "재무상태표", account_id: "ifrs-full_Assets", account_nm: "자산총계", thstrm_nm: "제 58 기 반기말", thstrm_amount: "759480516000000", frmtrm_nm: "제 57 기말", frmtrm_amount: "566942110000000" },
  isRow("IS", "ifrs-full_ProfitLoss", "반기순이익", "71624461000000", "118849733000000", "5116435000000", "13339313000000"),
  isRow("IS", "ifrs-full_ProfitLossAttributableToOwnersOfParent", "지배기업 소유주지분", "71269468000000", "118370658000000", "4934034000000", "12962441000000"),
  isRow("CIS", "ifrs-full_ComprehensiveIncomeAttributableToOwnersOfParent", "지배기업 소유주지분", "84149027000000", "143613296000000", "-3571805000000", "5740518000000"),
  isRow("CIS", "ifrs-full_ComprehensiveIncomeAttributableToOwnersOfParent", "지배기업 소유주지분", "84149027000000", "143613296000000", "-3571805000000", "5740518000000"), // exact repeat
  isRow("CIS", "ifrs-full_OtherComprehensiveIncome", "  ", "1", "2", "3", "4"), // blank name
  cfRow("ifrs-full_CashFlowsFromUsedInOperatingActivities", "영업활동현금흐름", "145355192000000", "33941002000000"),
  cfRow("ifrs-full_ProfitLoss", "반기순이익", "71624461000000", "5116435000000"),
  { ...H, sj_div: "SCE", sj_nm: "자본변동표", account_id: "ifrs-full_Equity", account_nm: "자본총계", thstrm_amount: "1" },
];
const fullH1 = formatFinancialTableMd(FULL_H1, "전체 재무제표", { context: { bsns_year: "2026", reprt_code: "11012", fs_div: "CFS" }, fullStatement: true });
console.log(fullH1);
const tableOf = (md: string, heading: string) => md.split("\n### ").find((t) => t.startsWith(heading)) ?? "";
const cfT = tableOf(fullH1, "현금흐름표"), isT = tableOf(fullH1, "손익계산서"), cisT = tableOf(fullH1, "포괄손익계산서");
check("SCE left out, and said so", !fullH1.includes("자본변동표 (SCE)") && fullH1.includes("자본변동표(SCE)는 기본 출력에서 제외"), true);
check("IS headers name 3개월 and 누계", isT.includes("| 계정명 | 당기 3개월 | 당기 누계 | 전기 3개월 | 전기 누계 |"), true);
check("CF has 누계 columns only", cfT.includes("| 계정명 | 당기 누계 | 전기 누계 |") && !cfT.includes("3개월 |"), true);
check("OCF read from the CF 누계 column", cfT.includes("| 영업활동현금흐름 | 145,355,192,000,000 | 33,941,002,000,000 |"), true);
check("CF 순이익 is the H1 cumulative, not the API's Q2 figure", cfT.includes("| 반기순이익 ※ | 118,849,733,000,000 | 13,339,313,000,000 |"), true);
check("…and the substitution is stated", cfT.includes("API가 손익계산서 3개월 값(71,624,461,000,000)을 줘서"), true);
check("IS 순이익 누계 = CF 순이익 누계", isT.includes("| 반기순이익 | 71,624,461,000,000 | 118,849,733,000,000 |"), true);
check("parent net income tagged 당기순이익 귀속", isT.includes("| 지배기업 소유주지분 [ProfitLossAttributableToOwnersOfParent · 당기순이익 귀속] | 71,269,468,000,000 | 118,370,658,000,000 |"), true);
check("parent comprehensive income tagged 총포괄손익 귀속", cisT.includes("| 지배기업 소유주지분 [ComprehensiveIncomeAttributableToOwnersOfParent · 총포괄손익 귀속] |"), true);
check("exact repeat row removed", cisT.split("\n").filter((l) => l.includes("총포괄손익 귀속")).length, 1);
check("blank-name row removed", fullH1.includes("|  |") || fullH1.includes("| - | 1 |"), false);

// The graded case: one 포괄손익계산서 carries both 귀속 lines under one name
console.log("\n=== same name, two account_ids in one statement ===");
const ONE_CIS = [
  { ...H, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLossAttributableToOwnersOfParent", account_nm: "지배기업의 소유주", thstrm_amount: "3000000000", thstrm_add_amount: "7830000000" },
  { ...H, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ComprehensiveIncomeAttributableToOwnersOfParent", account_nm: "지배기업의 소유주", thstrm_amount: "2900000000", thstrm_add_amount: "7590000000" },
  { ...H, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "dart_OtherA", account_nm: "기타", thstrm_amount: "1", thstrm_add_amount: "1" },
  { ...H, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "dart_OtherB", account_nm: "기타", thstrm_amount: "2", thstrm_add_amount: "2" },
];
const oneCis = formatFinancialTableMd(ONE_CIS, "전체 재무제표", { context: { reprt_code: "11012" }, fullStatement: true });
check("78.3억 row reads 당기순이익 귀속", oneCis.includes("| 지배기업의 소유주 [ProfitLossAttributableToOwnersOfParent · 당기순이익 귀속] | 3,000,000,000 | 7,830,000,000 |"), true);
check("75.9억 row reads 총포괄손익 귀속", oneCis.includes("| 지배기업의 소유주 [ComprehensiveIncomeAttributableToOwnersOfParent · 총포괄손익 귀속] | 2,900,000,000 | 7,590,000,000 |"), true);
check("other duplicate names get their id", oneCis.includes("| 기타 [OtherA] |") && oneCis.includes("| 기타 [OtherB] |"), true);

// 티앤엘 2025 반기 (rcept 20250814002863), verbatim: the filing's own 지배기업 귀속
// 당기순이익 line repeats the 총포괄손익 귀속 figure (75.9억) while 당기순이익 is
// 78.3억 and 비지배 is 0.
console.log("\n=== 지배 귀속 당기순이익 ≠ 당기순이익 − 비지배 (filing copied 총포괄) ===");
const TNL = { ...H, corp_code: "00608440", bsns_year: "2025" };
const tnlRow = (id: string, nm: string, a: string[]) => ({ ...TNL, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: id, account_nm: nm,
  thstrm_amount: a[0], thstrm_add_amount: a[1], frmtrm_q_amount: a[2], frmtrm_add_amount: a[3] });
const TNL_ROWS = [
  tnlRow("ifrs-full_ProfitLoss", "당기순이익(손실)", ["7833700170", "23686388514", "17320048873", "24419440011"]),
  tnlRow("ifrs-full_ProfitLossAttributableToNoncontrollingInterests", "비지배지분에 귀속되는 당기순이익(손실)", ["0", "0", "0", "0"]),
  tnlRow("ifrs-full_ProfitLossAttributableToOwnersOfParent", "지배기업의 소유주에게 귀속되는 당기순이익(손실)", ["7593343939", "23405017660", "17367217971", "24537177129"]),
  tnlRow("ifrs-full_ComprehensiveIncomeAttributableToOwnersOfParent", "포괄손익, 지배기업의 소유주에게 귀속되는 지분", ["7593343939", "23405017660", "17367217971", "24537177129"]),
];
const tnl = formatFinancialTableMd(TNL_ROWS, "전체 재무제표", { context: { reprt_code: "11012" }, fullStatement: true });
console.log(tnl);
check("지배 귀속 당기순이익 3개월 = 78.3억, not 총포괄 75.9억", tnl.includes("| 지배기업의 소유주에게 귀속되는 당기순이익(손실) [ProfitLossAttributableToOwnersOfParent · 당기순이익 귀속] ※ | 7,833,700,170 | 23,686,388,514 | 17,320,048,873 | 24,419,440,011 |"), true);
check("filed value stated, and that it equals 총포괄 귀속", tnl.includes("원문 값(7,593,343,939 / 23,405,017,660 / 17,367,217,971 / 24,537,177,129)") && tnl.includes("(원문 값은 총포괄손익 귀속과 같은 값)"), true);
check("총포괄손익 귀속 line untouched", tnl.includes("[ComprehensiveIncomeAttributableToOwnersOfParent · 총포괄손익 귀속] | 7,593,343,939 |"), true);
check("consistent filing (삼성전자) is not touched", fullH1.includes("※ | 71,269,468,000,000") || fullH1.includes("원문 값("), false);

// ─── trigger conditions, pinned ───
// Verbatim rows (live API, trimmed to the lines the two corrections read).
const tnlQ1 = { reprt_code: "11013", bsns_year: "2026", corp_code: "00608440" };
const TNL_Q1 = [
  { ...tnlQ1, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLoss", account_nm: "당기순이익(손실)", thstrm_nm: "제 29 기 1분기", thstrm_amount: "16441189305", thstrm_add_amount: "16441189305", frmtrm_q_nm: "제 28 기 1분기", frmtrm_q_amount: "15852688344", frmtrm_add_amount: "15852688344" },
  { ...tnlQ1, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLossAttributableToNoncontrollingInterests", account_nm: "비지배지분에 귀속되는 당기순이익(손실)", thstrm_nm: "제 29 기 1분기", thstrm_amount: "0", thstrm_add_amount: "0", frmtrm_q_nm: "제 28 기 1분기", frmtrm_q_amount: "0", frmtrm_add_amount: "0" },
  { ...tnlQ1, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLossAttributableToOwnersOfParent", account_nm: "지배기업의 소유주에게 귀속되는 당기순이익(손실)", thstrm_nm: "제 29 기 1분기", thstrm_amount: "16441189305", thstrm_add_amount: "16441189305", frmtrm_q_nm: "제 28 기 1분기", frmtrm_q_amount: "15852688344", frmtrm_add_amount: "15852688344" },
  { ...tnlQ1, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities", account_nm: "영업활동현금흐름", thstrm_nm: "제 29 기 1분기", thstrm_amount: "8778547393", frmtrm_q_nm: "제 28 기 1분기", frmtrm_q_amount: "7842723131" },
  { ...tnlQ1, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_ProfitLoss", account_nm: "당기순이익(손실)", thstrm_nm: "제 29 기 1분기", thstrm_amount: "16441189305", frmtrm_q_nm: "제 28 기 1분기", frmtrm_q_amount: "15852688344" },
];
const tnlFy = { reprt_code: "11011", bsns_year: "2025", corp_code: "00608440" };
const TNL_FY = [
  { ...tnlFy, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLoss", account_nm: "당기순이익(손실)", thstrm_nm: "제 28 기", thstrm_amount: "38074883027", thstrm_add_amount: "", frmtrm_nm: "제 27 기", frmtrm_amount: "46407511867", bfefrmtrm_nm: "제 26 기", bfefrmtrm_amount: "27438682343" },
  { ...tnlFy, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLossAttributableToNoncontrollingInterests", account_nm: "비지배지분에 귀속되는 당기순이익(손실)", thstrm_nm: "제 28 기", thstrm_amount: "0", thstrm_add_amount: "", frmtrm_nm: "제 27 기", frmtrm_amount: "0", bfefrmtrm_nm: "제 26 기", bfefrmtrm_amount: "0" },
  { ...tnlFy, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLossAttributableToOwnersOfParent", account_nm: "지배기업의 소유주에게 귀속되는 당기순이익(손실)", thstrm_nm: "제 28 기", thstrm_amount: "38074883027", thstrm_add_amount: "", frmtrm_nm: "제 27 기", frmtrm_amount: "46407511867", bfefrmtrm_nm: "제 26 기", bfefrmtrm_amount: "27438682343" },
  { ...tnlFy, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities", account_nm: "영업활동현금흐름", thstrm_nm: "제 28 기", thstrm_amount: "37691797461", frmtrm_nm: "제 27 기", frmtrm_amount: "46569584536", bfefrmtrm_nm: "제 26 기", bfefrmtrm_amount: "32591101671" },
  { ...tnlFy, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_ProfitLoss", account_nm: "당기순이익(손실)", thstrm_nm: "제 28 기", thstrm_amount: "38074883027", frmtrm_nm: "제 27 기", frmtrm_amount: "46407511867", bfefrmtrm_nm: "제 26 기", bfefrmtrm_amount: "27438682343" },
];
// SYTS 2026 반기 연결: 지배 귀속 line present, no 비지배 line at all
const sy = { reprt_code: "11012", bsns_year: "2026", corp_code: "00127042" };
const SYTS_H1 = [
  { ...sy, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLoss", account_nm: "당기순이익", thstrm_nm: "제 66 기 반기", thstrm_amount: "6482148350", thstrm_add_amount: "9608693103", frmtrm_q_nm: "제 65 기 반기", frmtrm_q_amount: "5203145938", frmtrm_add_amount: "8411708703" },
  { ...sy, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_ProfitLossAttributableToOwnersOfParent", account_nm: "지배기업의 소유주에게 귀속되는 당기순이익", thstrm_nm: "제 66 기 반기", thstrm_amount: "6482148350", thstrm_add_amount: "9608693103", frmtrm_q_nm: "제 65 기 반기", frmtrm_q_amount: "5203145938", frmtrm_add_amount: "8411708703" },
  { ...sy, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities", account_nm: "영업활동으로 인한 현금흐름", thstrm_nm: "제 66 기 반기", thstrm_amount: "16986083100", frmtrm_q_nm: "제 65 기 반기", frmtrm_q_amount: "9665116455" },
  { ...sy, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_ProfitLoss", account_nm: "당기순이익", thstrm_nm: "제 66 기 반기", thstrm_amount: "6482148350", frmtrm_q_nm: "제 65 기 반기", frmtrm_q_amount: "5203145938" },
];
const render = (rows: Array<Record<string, unknown>>, reprt_code: string) =>
  formatFinancialTableMd(rows, "전체 재무제표", { context: { reprt_code, fs_div: "CFS" }, fullStatement: true });

console.log("\n=== CF 순이익 대체: 1분기 never (티앤엘 2026 1분기) ===");
const q1 = render(TNL_Q1, "11013");
check("no ※ anywhere", q1.includes("※"), false);
check("no substitution note", q1.includes("API가 손익계산서 3개월 값"), false);
check("CF 순이익 shown as filed", tableOf(q1, "현금흐름표").includes("| 당기순이익(손실) | 16,441,189,305 | 15,852,688,344 |"), true);
// Gate on the report code, not on the data: even a 1분기 whose IS 누계 differed
// from its 3개월 must not be touched.
// (지배 line forged alongside so 지배 + 비지배 = 당기순이익 still holds)
const q1Forged = render(TNL_Q1.map((r) => (r.sj_div === "CIS" && /_ProfitLoss$|_ProfitLossAttributableToOwnersOfParent$/.test(r.account_id) ? { ...r, thstrm_add_amount: "99999999999" } : r)), "11013");
check("1분기 stays untouched even if 3개월 ≠ 누계", q1Forged.includes("※") || q1Forged.includes("API가 손익계산서 3개월 값"), false);

console.log("\n=== CF 순이익 대체: 사업보고서 never (티앤엘 2025) ===");
const fy = render(TNL_FY, "11011");
check("no ※ anywhere", fy.includes("※"), false);
check("annual CF keeps 당기/전기/전전기 and the filed value", tableOf(fy, "현금흐름표").includes("| 당기순이익(손실) | 38,074,883,027 | 46,407,511,867 | 27,438,682,343 |"), true);
const fyForged = render(TNL_FY.map((r) => (r.sj_div === "CIS" && r.account_id === "ifrs-full_ProfitLoss" ? { ...r, thstrm_add_amount: "99999999999" } : r)), "11011");
check("사업보고서 stays untouched even with a stray 누계", fyForged.includes("※") || fyForged.includes("API가 손익계산서 3개월 값"), false);

console.log("\n=== CF 순이익 대체: 3분기 fires, other CF lines never ===");
const q3fix = render(SYTS_H1.map((r) => ({ ...r, reprt_code: "11014" })), "11014");
check("3분기 with CF = IS 3개월 ≠ 누계 → 누계 shown", tableOf(q3fix, "현금흐름표").includes("| 당기순이익 ※ | 9,608,693,103 | 8,411,708,703 |"), true);
const offByOne = render(SYTS_H1.map((r) => (r.sj_div === "CF" && r.account_id === "ifrs-full_ProfitLoss" ? { ...r, thstrm_amount: "6482148351", frmtrm_q_amount: "5203145939" } : r)), "11012");
check("CF 순이익 1원 off the IS 3개월 → no substitution", tableOf(offByOne, "현금흐름표").includes("| 당기순이익 | 6,482,148,351 | 5,203,145,939 |"), true);
const otherLine = render([
  ...SYTS_H1,
  { ...sy, sj_div: "CIS", sj_nm: "포괄손익계산서", account_id: "ifrs-full_IncomeTaxExpenseContinuingOperations", account_nm: "법인세비용", thstrm_amount: "100", thstrm_add_amount: "250", frmtrm_q_amount: "90", frmtrm_add_amount: "200" },
  { ...sy, sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_IncomeTaxExpenseContinuingOperations", account_nm: "법인세비용", thstrm_amount: "100", frmtrm_q_amount: "90" },
], "11012");
check("only the 순이익 line is ever substituted", tableOf(otherLine, "현금흐름표").includes("| 법인세비용 | 100 | 90 |"), true);

console.log("\n=== 지배 귀속 재계산: 비지배 행 없음 (SYTS 2026 반기) ===");
const sytsT = render(SYTS_H1, "11012");
console.log(sytsT);
const sytsCis = tableOf(sytsT, "포괄손익계산서");
check("filed value kept, no ※ on the parent line", sytsCis.includes("| 지배기업의 소유주에게 귀속되는 당기순이익 [ProfitLossAttributableToOwnersOfParent · 당기순이익 귀속] | 6,482,148,350 | 9,608,693,103 | 5,203,145,938 | 8,411,708,703 |"), true);
check("noted 비지배 행 없음 · 검산 불가", sytsCis.includes("- 지배기업의 소유주에게 귀속되는 당기순이익: 비지배 행 없음 · 검산 불가"), true);
check("no recalculation note", sytsCis.includes("당기순이익 − 비지배로 표시"), false);
check("its CF 순이익 (반기, = IS 3개월) is still corrected", tableOf(sytsT, "현금흐름표").includes("| 당기순이익 ※ | 9,608,693,103 | 8,411,708,703 |"), true);
check("consistent 지배+비지배 (티앤엘 1분기) → no recalculation", q1.includes("당기순이익 − 비지배로 표시") || q1.includes("검산 불가"), false);
const noPl = render(SYTS_H1.filter((r) => !(r.sj_div === "CIS" && r.account_id === "ifrs-full_ProfitLoss")), "11012");
check("no 당기순이익 line → neither recalculated nor noted", noPl.includes("당기순이익 − 비지배로 표시") || noPl.includes("검산 불가"), false);

console.log("\n=== full statement, annual: CF keeps plain 당기/전기 ===");
const fullFy = formatFinancialTableMd([
  { ...H, reprt_code: "11011", sj_div: "CF", sj_nm: "현금흐름표", account_id: "ifrs-full_CashFlowsFromUsedInOperatingActivities", account_nm: "영업활동현금흐름", thstrm_amount: "10", frmtrm_amount: "9", bfefrmtrm_amount: "8" },
], "전체 재무제표", { context: { reprt_code: "11011" }, fullStatement: true });
check("annual CF columns unchanged", fullFy.includes("| 계정명 | 당기 | 전기 | 전전기 |") && !fullFy.includes("누계"), true);

console.log("\n=== key accounts are not touched by full-statement cleanup ===");
check("fnlttSinglAcnt output keeps its rows", formatFinancialTableMd(Q3_ROWS, "단일회사 주요계정", {}).includes("| 유동자산 |"), true);

console.log("\n=== total shares (stockTotqySttus), mapped by field name ===");
const SH = { stlm_dt: "2026-06-30", now_to_isu_stock_totqy: "999", now_to_dcrs_stock_totqy: "999", redc: "-", profit_incnr: "-", rdmstk_repy: "-", etc: "-" };
const shares = formatTotalSharesMd([
  { ...SH, se: "의결권 있는 주식\n(보통주)", isu_stock_totqy: "30,000,000", istc_totqy: "8,128,000", tesstk_co: "128,000", distb_stock_co: "8,000,000" },
  { ...SH, se: "의결권 없는 주식\n(우선주)", isu_stock_totqy: "-", istc_totqy: "-", tesstk_co: "-", distb_stock_co: "-" },
  { ...SH, se: "합계", isu_stock_totqy: "30,000,000", istc_totqy: "8,128,000", tesstk_co: "128,000", distb_stock_co: "8,000,001" },
  { ...SH, se: "비고", isu_stock_totqy: "-", istc_totqy: "-", tesstk_co: "주1)", distb_stock_co: "-" },
], "주식 총수 (Total Shares)");
console.log(shares);
check("fixed class columns", shares.includes("| 항목 | 보통주 | 우선주 | 합계 | 비고 |"), true);
check("authorized ≠ issued: 발행할 주식의 총수 row", shares.includes("| 발행할 주식의 총수 (isu_stock_totqy) | 30,000,000 | - | 30,000,000 |  |"), true);
check("발행주식의 총수 = 8,128,000", shares.includes("| 발행주식의 총수 (istc_totqy) | 8,128,000 | - | 8,128,000 |  |"), true);
check("자기주식수 row", shares.includes("| 자기주식수 (tesstk_co) | 128,000 | - | 128,000 |  |"), true);
check("total kept as filed, mismatch flagged", shares.includes("| 유통주식수 (distb_stock_co) | 8,000,000 | - | 8,000,001 | 원문 합계 불일치 |"), true);
check("비고 row not shown as a class", shares.includes("주1)"), false);
check("positional fields not leaked", shares.includes("999"), false);
const twoPref = formatTotalSharesMd([
  { ...SH, se: "보통주", isu_stock_totqy: "100", istc_totqy: "50", tesstk_co: "-", distb_stock_co: "50" },
  { ...SH, se: "1우선주", isu_stock_totqy: "10", istc_totqy: "5", tesstk_co: "-", distb_stock_co: "5" },
  { ...SH, se: "2우선주", isu_stock_totqy: "10", istc_totqy: "4", tesstk_co: "-", distb_stock_co: "4" },
  { ...SH, se: "합계", isu_stock_totqy: "120", istc_totqy: "59", tesstk_co: "-", distb_stock_co: "59" },
], "주식 총수");
check("several preferred classes summed and said so", twoPref.includes("| 발행주식의 총수 (istc_totqy) | 50 | 9 | 59 | 우선주 2종 합산 |"), true);

console.log("\n=== empty ===");
check("empty list handled", formatFinancialTableMd([], "제목", {}).includes("데이터가 없습니다"), true);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
