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
check("section count", doc.sections.length, 6);
check(
  "titles",
  doc.sections.map((s) => s.title),
  ["I. 회사의 개요", "1. 회사의 개요", "2. 회사의 연혁", "II. 사업의 내용", "1. 사업의 개요", "2. 주요 제품"]
);
check("depths differ parent<child", doc.sections[0].depth < doc.sections[1].depth, true);
check("top-level depth normalized to 0", doc.sections[0].depth, 0);
check("child depth", doc.sections[1].depth, 1);

console.log("\n--- find by index ---");
const byIndex = findSection(doc, "5");
check("index 5 title", byIndex?.title, "1. 사업의 개요");
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

console.log("\n--- keyword case/space insensitivity ---");
check("spaces ignored", findSection(doc, "주요제품")?.index, 6);

console.log("\n--- misc ---");
check("no match -> null", findSection(doc, "존재하지않는섹션"), null);
check("entity &amp;", extractText("<P>R&amp;D</P>"), "R&D");
check("truncate marks", truncate("abcdef", 3), { text: "abc", truncated: true, totalChars: 6 });
check("truncate passthrough", truncate("ab", 5), { text: "ab", truncated: false, totalChars: 2 });

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
