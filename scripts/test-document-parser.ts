/**
 * Parser checks against a DART-shaped sample filing. No API key needed.
 *
 * Usage: npm run test:document
 */
import {
  parseDocument,
  findSection,
  getSectionText,
  extractText,
  truncate,
} from "../lib/opendart/document-parser";

const SAMPLE = `<?xml version="1.0" encoding="euc-kr"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="11011">사업보고서</DOCUMENT-NAME>
<FORMULA-VERSION ADATE="20230101">4.0</FORMULA-VERSION>
<COMPANY-NAME AREGCIK="00126380">삼성전자</COMPANY-NAME>
<BODY>
<LIBRARY>
<PART ATOC="Y" AASSOCNOTE="D-0-2-0-0">
<TITLE ATOC="Y" AASSOCNOTE="D-0-2-0-0">I. 회사의 개요</TITLE>
<SECTION-1 ACLASS="MULTI">
<TITLE ATOC="Y">1. 회사의 개요</TITLE>
<P>당사는 <SPAN>1969년</SPAN> 설립되었습니다.</P>
<P>본점 소재지는 경기도 수원시입니다. R&amp;D 센터를 운영합니다.</P>
</SECTION-1>
<SECTION-1>
<TITLE ATOC="Y">2. 회사의 연혁</TITLE>
<TABLE BORDER="1">
<TBODY>
<TR><TD><P>연도</P></TD><TD><P>내용</P></TD></TR>
<TR><TD><P>1969</P></TD><TD><P>설립</P></TD></TR>
<TR><TD><P>1975</P></TD><TD><P>상장</P></TD></TR>
</TBODY>
</TABLE>
</SECTION-1>
</PART>
<PART ATOC="Y">
<TITLE ATOC="Y">III. 재무에 관한 사항</TITLE>
<SECTION-1>
<TITLE ATOC="Y">15. 충당부채</TITLE>
<TABLE-GROUP ACLASS="COVER" ADELETETABLE="N">
<TABLE ACLASS="NORMAL" BORDER="1">
<THEAD>
<TR><TH ENG="Warranty">판매보증</TH><TH ENG="Disclosed Amount">공시금액</TH></TR>
</THEAD>
<TBODY>
<TR>
<TE ENG="provisions at beginning of period" VALIGN="MIDDLE">기초 충당부채</TE>
<TE ACODE="ifrs-full_OtherProvisions" ACONTEXT="PFY2024eFY" ADECIMAL="-6" ANEGATED="N" ALIGN="RIGHT">2,734,501</TE>
</TR>
<TR>
<TD CLASS="NORMAL" ENG="Fiscal year">사업연도</TD>
<TU CLASS="NORMAL" AUNIT="PERIODFROM" AUNITVALUE="20250101">2025년 01월 01일</TU>
</TR>
<TR><TE VALIGN="MIDDLE">　</TE><TE ALIGN="RIGHT">1,234</TE></TR>
</TBODY>
</TABLE>
</TABLE-GROUP>
</SECTION-1>
</PART>
<PART ATOC="Y">
<TITLE ATOC="Y">II. 사업의 내용</TITLE>
<SECTION-1>
<TITLE ATOC="Y">1. 사업의 개요</TITLE>
<P>반도체 &lt;DS&gt; 부문과 DX 부문으로 구성됩니다.</P>
<!-- internal comment should vanish -->
</SECTION-1>
<SECTION-1>
<TITLE ATOC="Y">2. 주요 제품</TITLE>
<P>메모리, 시스템LSI</P>
</SECTION-1>
</PART>
</LIBRARY>
</BODY>
</DOCUMENT>`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${e}\n      actual:   ${a}`);
}

const doc = parseDocument(SAMPLE);

console.log("--- metadata ---");
check("docName", doc.docName, "사업보고서");
check("companyName", doc.companyName, "삼성전자");

console.log("\n--- TOC ---");
for (const s of doc.sections) {
  console.log(`  ${"  ".repeat(s.depth)}${s.index}. ${s.title}  [depth=${s.depth}]`);
}
check("section count", doc.sections.length, 8);
check(
  "titles",
  doc.sections.map((s) => s.title),
  [
    "I. 회사의 개요",
    "1. 회사의 개요",
    "2. 회사의 연혁",
    "III. 재무에 관한 사항",
    "15. 충당부채",
    "II. 사업의 내용",
    "1. 사업의 개요",
    "2. 주요 제품",
  ]
);
check("depths differ parent<child", doc.sections[0].depth < doc.sections[1].depth, true);
check("top-level depth normalized to 0", doc.sections[0].depth, 0);
check("child depth", doc.sections[1].depth, 1);

console.log("\n--- find by index ---");
const byIndex = findSection(doc, "7");
check("index 7 title", byIndex?.title, "1. 사업의 개요");
console.log(getSectionText(doc, byIndex!));
check("entity decode &lt;DS&gt;", getSectionText(doc, byIndex!).includes("반도체 <DS> 부문"), true);
check("comment stripped", getSectionText(doc, byIndex!).includes("internal comment"), false);
check("next section title excluded", getSectionText(doc, byIndex!).includes("주요 제품"), false);
check("leaf section is exactly its body", getSectionText(doc, byIndex!), "반도체 <DS> 부문과 DX 부문으로 구성됩니다.");

console.log("\n--- find by keyword ---");
const byKeyword = findSection(doc, "사업의 내용");
check("keyword -> parent section", byKeyword?.title, "II. 사업의 내용");
const parentText = getSectionText(doc, byKeyword!);
console.log(parentText);
check("parent includes children", parentText.includes("메모리, 시스템LSI"), true);
check("parent stops before next part", parentText.includes("1969년"), false);

console.log("\n--- table rendering ---");
const table = findSection(doc, "2. 회사의 연혁");
const tableText = getSectionText(doc, table!);
console.log(tableText);
check("table row pipes", tableText.includes("연도 | 내용"), true);
check("table data row", tableText.includes("1969 | 설립"), true);

console.log("\n--- XBRL note table (TE/TU cells, TABLE-GROUP wrapper) ---");
const note = findSection(doc, "충당부채");
const noteText = getSectionText(doc, note!);
console.log(noteText);
check("TH header row", noteText.includes("판매보증 | 공시금액"), true);
check("TE value cell (the reported bug)", noteText.includes("기초 충당부채 | 2,734,501"), true);
check("TU value cell", noteText.includes("사업연도 | 2025년 01월 01일"), true);
check("empty TE keeps column position", noteText.includes("| 1,234"), true);
check("TABLE-GROUP not mistaken for a table", noteText.includes("TABLE-GROUP"), false);

console.log("\n--- keyword case/space insensitivity ---");
check("spaces ignored", findSection(doc, "주요제품")?.index, 8);

// Real filings use LIBRARY + SECTION-n and no PART at all, and they open a
// fresh nested LIBRARY between sibling sections. Counting LIBRARY as a level
// made every later title look one deeper, so 요약재무정보 swallowed the whole
// 재무 chapter (4.4M chars in 삼성전자's filing).
console.log("\n--- nested LIBRARY must not create a heading level ---");
const LIBRARY_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="11011">사업보고서</DOCUMENT-NAME>
<BODY>
<LIBRARY>
<SECTION-1 ACLASS="MANDATORY">
<TITLE ATOC="Y">III. 재무에 관한 사항</TITLE>
<SECTION-2 ACLASS="MANDATORY">
<TITLE ATOC="Y">1. 요약재무정보</TITLE>
<P>요약재무정보 본문.</P>
</SECTION-2><LIBRARY>
<SECTION-2 ACLASS="MANDATORY">
<TITLE ATOC="Y">2. 연결재무제표</TITLE>
<P>연결재무제표 본문.</P>
</SECTION-2>
</LIBRARY>
</SECTION-1>
</LIBRARY>
</BODY>
</DOCUMENT>`;

const lib = parseDocument(LIBRARY_SAMPLE);
for (const s of lib.sections) console.log(`  ${"  ".repeat(s.depth)}${s.index}. ${s.title} [d${s.depth}]`);
const summary = findSection(lib, "요약재무정보")!;
const consolidated = findSection(lib, "연결재무제표")!;
check("chapter at depth 0", lib.sections[0].depth, 0);
check("siblings share a depth", summary.depth, consolidated.depth);
check("sibling depth is 1", summary.depth, 1);
check("summary body is its own", getSectionText(lib, summary), "요약재무정보 본문.");
check("summary does not swallow the next section", getSectionText(lib, summary).includes("연결재무제표 본문"), false);
check("next section still readable", getSectionText(lib, consolidated), "연결재무제표 본문.");

console.log("\n--- misc ---");
check("no match -> null", findSection(doc, "존재하지않는섹션"), null);
check("entity &amp;", extractText("<P>R&amp;D</P>"), "R&D");
check("truncate marks", truncate("abcdef", 3), { text: "abc", truncated: true, totalChars: 6 });
check("truncate passthrough", truncate("ab", 5), { text: "ab", truncated: false, totalChars: 2 });

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
