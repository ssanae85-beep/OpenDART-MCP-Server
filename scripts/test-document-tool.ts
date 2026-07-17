/**
 * End-to-end check of opendart_get_document through a real MCP client/server
 * pair, with fetch stubbed to serve a DART-shaped ZIP. No API key needed.
 *
 * Usage: npm run test:document
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync, strToU8 } from "fflate";
import { registerAllTools } from "../lib/tools";

process.env.OPENDART_API_KEY = "test-key-not-real";

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="11011">사업보고서</DOCUMENT-NAME>
<COMPANY-NAME AREGCIK="00126380">삼성전자</COMPANY-NAME>
<BODY><LIBRARY>
<PART ATOC="Y">
<TITLE ATOC="Y">I. 회사의 개요</TITLE>
<SECTION-1><TITLE>1. 회사의 개요</TITLE><P>당사는 1969년 설립되었습니다.</P></SECTION-1>
<SECTION-1><TITLE>2. 회사의 연혁</TITLE>
<TABLE><TBODY>
<TR><TD><P>연도</P></TD><TD><P>내용</P></TD></TR>
<TR><TD><P>1969</P></TD><TD><P>설립</P></TD></TR>
</TBODY></TABLE>
</SECTION-1>
</PART>
<PART ATOC="Y">
<TITLE ATOC="Y">II. 사업의 내용</TITLE>
<SECTION-1><TITLE>1. 사업의 개요</TITLE><P>${"반도체 부문. ".repeat(400)}</P></SECTION-1>
</PART>
</LIBRARY></BODY>
</DOCUMENT>`;

const ERROR_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<result><status>013</status><message>조회된 데이타가 없습니다.</message></result>`;

/** Response's typings don't accept a bare Uint8Array view; hand it the buffer. */
function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let requestCount = 0;
let lastUrl = "";
let serveError = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  lastUrl = String(input);
  requestCount++;
  if (serveError) {
    return new Response(toBody(strToU8(ERROR_BODY)), { status: 200 });
  }
  const zipped = zipSync({ "20240312000736.xml": strToU8(SAMPLE) });
  return new Response(toBody(zipped), { status: 200 });
}) as typeof realFetch;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

async function main() {
  const server = new McpServer({ name: "test", version: "0" });
  registerAllTools(server);

  const client = new Client({ name: "test-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  console.log("--- registration ---");
  const { tools } = await client.listTools();
  const doc = tools.find((t) => t.name === "opendart_get_document");
  check("tool registered", !!doc, true);
  check("tool count", tools.length, 84);
  check(
    "params",
    Object.keys(doc!.inputSchema.properties ?? {}).sort(),
    ["api_key", "max_chars", "mode", "rcept_no", "section"]
  );

  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "opendart_get_document", arguments: args });
    const content = r.content as Array<{ text: string }>;
    return { text: content[0].text, isError: !!r.isError };
  };

  console.log("\n--- mode=toc (default) ---");
  const toc = await call({ rcept_no: "20240312000736" });
  console.log(toc.text);
  check("no error", toc.isError, false);
  check("endpoint url", lastUrl.includes("/api/document.xml?"), true);
  check("rcept_no passed", lastUrl.includes("rcept_no=20240312000736"), true);
  check("doc name in header", toc.text.includes("사업보고서 — 삼성전자"), true);
  check("lists sections", toc.text.includes("1. I. 회사의 개요"), true);
  check("toc has no body text", toc.text.includes("1969년 설립"), false);

  console.log("\n--- caching ---");
  check("one fetch so far", requestCount, 1);
  await call({ rcept_no: "20240312000736", mode: "section", section: "2" });
  check("second call served from cache", requestCount, 1);

  console.log("\n--- mode=section by keyword ---");
  const sec = await call({ rcept_no: "20240312000736", mode: "section", section: "회사의 연혁" });
  console.log(sec.text);
  check("table rendered", sec.text.includes("1969 | 설립"), true);

  console.log("\n--- mode=section truncation ---");
  const trunc = await call({ rcept_no: "20240312000736", mode: "section", section: "사업의 개요", max_chars: 1000 });
  check("truncation flagged", trunc.text.includes("잘렸습니다"), true);
  check("respects cap (plus notice)", trunc.text.length < 1400, true);
  console.log(trunc.text.slice(-260));

  console.log("\n--- mode=section not found ---");
  const missing = await call({ rcept_no: "20240312000736", mode: "section", section: "없는섹션" });
  check("isError", missing.isError, true);
  check("suggests options", missing.text.includes("사용 가능한 섹션"), true);

  console.log("\n--- mode=section without section arg ---");
  const noArg = await call({ rcept_no: "20240312000736", mode: "section" });
  check("isError", noArg.isError, true);

  console.log("\n--- mode=full ---");
  const full = await call({ rcept_no: "20240312000736", mode: "full" });
  check("includes body", full.text.includes("1969년 설립"), true);
  check("truncated by default cap", full.text.includes("잘렸습니다"), false);

  console.log("\n--- bad rcept_no rejected by schema ---");
  const bad = await call({ rcept_no: "123" });
  check("isError", bad.isError, true);

  console.log("\n--- OpenDART error body (013) ---");
  serveError = true;
  const err = await call({ rcept_no: "20240312000999" });
  console.log(err.text);
  check("isError", err.isError, true);
  check("maps status 013", err.text.includes("013"), true);
  check("friendly message", err.text.includes("조회된 데이터가 없습니다"), true);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CRASH:", err);
  process.exit(1);
});
