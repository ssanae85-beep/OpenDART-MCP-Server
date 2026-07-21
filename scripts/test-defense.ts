/**
 * Tests for the three post-incident defenses:
 *   1. unknown-parameter rejection (guard.ts + the low-level wrapper)
 *   2. server-side response ceiling (document.ts)
 *   3. encoding fallback + garble warning (zip.ts)
 *
 * fetch is stubbed with a generated ZIP; no API key, no network.
 *
 * Usage: npm run test:defense
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync, strToU8 } from "fflate";
import { registerAllTools } from "../lib/tools";
import { checkParams, suggestKey, buildAllowlist } from "../lib/opendart/guard";
import { decodeXmlChecked, replacementRatio } from "../lib/opendart/zip";
import { extractText } from "../lib/opendart/document-parser";
import { capResponse, effectiveMaxChars, MAX_RESPONSE_CHARS } from "../lib/tools/document";

process.env.OPENDART_API_KEY = "test-key";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// ---- fixtures -------------------------------------------------------------

// Body deliberately far exceeds the 50k ceiling so capping is observable.
const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT>
<DOCUMENT-NAME ACODE="11011">사업보고서</DOCUMENT-NAME>
<COMPANY-NAME>삼성전자</COMPANY-NAME>
<BODY><LIBRARY>
<SECTION-1><TITLE>1. 회사의 개요</TITLE><P>${"가나다라마바사아자차 ".repeat(8000)}</P></SECTION-1>
</LIBRARY></BODY>
</DOCUMENT>`;

// Verified EUC-KR byte sequences (brute-forced against the euc-kr decoder).
const KR_SAMSUNG = new Uint8Array([0xbb, 0xef, 0xbc, 0xba, 0xc0, 0xfc, 0xc0, 0xda]); // 삼성전자
const KR_GA = new Uint8Array([0xb0, 0xa1]); // 가

// A real EUC-KR document that declares euc-kr — the pre-2020 shape.
function eucKrBytes(declaredEncoding: string): Uint8Array {
  const prolog = strToU8(`<?xml version="1.0" encoding="${declaredEncoding}"?><DOCUMENT-NAME>`);
  const close = strToU8("</DOCUMENT-NAME><P>");
  const body: Uint8Array[] = [];
  for (let i = 0; i < 600; i++) body.push(KR_GA); // valid EUC-KR filler
  const end = strToU8("</P>");
  return concat(prolog, KR_SAMSUNG, close, ...body, end);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// document-cache keys by rcept_no, so each fixture needs its own number to
// avoid serving a cached bundle from an earlier case.
const RCEPT_CLEAN = "20240312000001";
const RCEPT_GARBLED = "20180312000002"; // pre-2020, the garbled case

const byRcept: Record<string, Uint8Array> = {
  [RCEPT_CLEAN]: strToU8(SAMPLE),
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);

  // JSON endpoints (financial, shareholding, …): a valid "no data" body is
  // enough — these tests only care whether the guard let the call through.
  if (url.includes(".json")) {
    return new Response(JSON.stringify({ status: "013", message: "no data", list: [] }), { status: 200 });
  }

  // document.xml: a ZIP keyed by rcept_no.
  const rcept = url.match(/rcept_no=(\d+)/)?.[1] ?? RCEPT_CLEAN;
  const bytes = byRcept[rcept] ?? strToU8(SAMPLE);
  const zip = zipSync({ [`${rcept}.xml`]: bytes });
  const body = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
  return new Response(body, { status: 200 });
}) as typeof realFetch;

async function main() {
  const server = new McpServer({ name: "t", version: "0" });
  registerAllTools(server);
  const client = new Client({ name: "c", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "opendart_get_document", arguments: args });
    return { text: (r.content as Array<{ text: string }>)[0].text, isError: !!r.isError };
  };

  // ---- Defense 1: unknown parameters ------------------------------------
  console.log("=== 1. unknown-parameter rejection ===");

  // unit: suggestKey / checkParams
  check("suggestKey rcept_name→rcept_no", suggestKey("rcept_name", ["rcept_no", "mode"]), "rcept_no");
  check("suggestKey nonsense → null", suggestKey("zzzzzzzz", ["rcept_no", "mode"]), null);
  check("checkParams passes clean args", checkParams("opendart_get_document", { rcept_no: "x" }, ["rcept_no"]), null);
  check(
    "checkParams flags the unknown key",
    checkParams("opendart_get_document", { rcept_no: "x", rcept_name: "y" }, ["rcept_no", "mode"])?.unknownKeys,
    ["rcept_name"]
  );

  // integration: the exact incident call
  const incident = await call({ rcept_no: RCEPT_CLEAN, rcept_name: "삼성전자" });
  console.log(incident.text);
  check("incident call is rejected", incident.isError, true);
  check("names the bad key", incident.text.includes("rcept_name"), true);
  check("suggests the right key", incident.text.includes("did you mean 'rcept_no'"), true);
  check("did NOT run the tool (no document header)", incident.text.includes("사업보고서"), false);

  // a valid call still works and type validation still runs
  const good = await call({ rcept_no: RCEPT_CLEAN, mode: "toc" });
  check("valid call still works", good.isError, false);
  check("valid call returns the doc", good.text.includes("사업보고서"), true);

  const typeBad = await client.callTool({ name: "opendart_get_document", arguments: { rcept_no: 123 } });
  check("SDK type validation still fires", !!typeBad.isError, true);

  // guard is scoped: multiple unknowns all reported
  const multi = checkParams("opendart_get_document", { a: 1, b: 2, rcept_no: "x" },
    ["rcept_no", "mode", "section", "offset", "query", "attachment", "max_chars", "api_key"]);
  check("reports every unknown key", multi?.unknownKeys, ["a", "b"]);

  // undefined allowlist (unknown tool) is not guarded; empty allowlist is.
  check("unknown tool → not guarded", checkParams("nope", { x: 1 }, undefined), null);
  check("no-param tool rejects any key", checkParams("t", { x: 1 }, [])?.unknownKeys, ["x"]);

  // abbreviation hints that edit distance alone would miss
  check("business_year → bsns_year", suggestKey("business_year", ["bsns_year", "corp_code"]), "bsns_year");
  check("report_code → reprt_code", suggestKey("report_code", ["reprt_code", "corp_code"]), "reprt_code");

  // ---- the guard is universal, derived from each tool's schema ------------
  console.log("\n--- guard covers every tool, allowlist derived from schema ---");
  const allowlist = buildAllowlist((server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })._registeredTools);
  check("every registered tool has an allowlist", Object.keys(allowlist).length > 12, true);
  check("get_document allowlist matches its schema keys",
    allowlist["opendart_get_document"]?.sort(),
    ["api_key", "attachment", "max_chars", "mode", "offset", "query", "rcept_no", "section"]);
  check("no-param tool derives an empty allowlist", allowlist["get_api_key_status"], []);

  // Same incident, a *different* tool: business_year on a financial tool.
  const finTypo = await client.callTool({
    name: "opendart_single_financial_accounts",
    arguments: { corp_code: "00126380", business_year: "2025", reprt_code: "11014" },
  });
  const finText = (finTypo.content as Array<{ text: string }>)[0].text;
  check("financial tool rejects business_year", !!finTypo.isError, true);
  check("financial tool suggests bsns_year", finText.includes("did you mean 'bsns_year'"), true);

  // report_code on a shareholding tool — another tool family entirely.
  const shTypo = await client.callTool({
    name: "opendart_largest_shareholder",
    arguments: { corp_code: "00126380", bsns_year: "2025", report_code: "11011" },
  });
  const shText = (shTypo.content as Array<{ text: string }>)[0].text;
  check("shareholding tool rejects report_code", !!shTypo.isError, true);
  check("shareholding tool suggests reprt_code", shText.includes("did you mean 'reprt_code'"), true);

  // a no-parameter tool rejects a stray key through the full stack
  const noParamCall = await client.callTool({ name: "get_api_key_status", arguments: { foo: "bar" } });
  check("no-param tool rejects a stray key end to end", !!noParamCall.isError, true);

  // and a correct call to another tool still passes the guard (data errors are fine)
  const finOk = await client.callTool({
    name: "opendart_single_financial_accounts",
    arguments: { corp_code: "00126380", bsns_year: "2025", reprt_code: "11014" },
  });
  const finOkText = (finOk.content as Array<{ text: string }>)[0].text;
  check("correct financial call passes the guard", finOkText.includes("Unknown parameter"), false);

  // ---- Defense 2: server-side ceiling -----------------------------------
  console.log("\n=== 2. server-side response ceiling ===");
  check("body genuinely exceeds the ceiling", extractText(SAMPLE).length > 50000, true);

  // Normal path: the header pushes total just over 50k, so capResponse — the
  // last line, independent of renderBody's paging — trims it and says so.
  const full = await call({ rcept_no: RCEPT_CLEAN, mode: "full", max_chars: 50000 });
  check("full response within the ceiling", full.text.length <= 50000 + 300, true);
  check("ceiling notice present", full.text.includes("서버 상한"), true);

  const capped = await call({ rcept_no: RCEPT_CLEAN, mode: "section", section: "1", max_chars: 50000 });
  check("section response within ceiling", capped.text.length <= 50000 + 300, true);

  // The ceiling is enforced by capResponse regardless of the requested value —
  // unit-test it directly, independent of the schema's own max_chars limit.
  check("effectiveMaxChars clamps above the ceiling", effectiveMaxChars(10_000_000), MAX_RESPONSE_CHARS);
  check("effectiveMaxChars leaves smaller values alone", effectiveMaxChars(5000), 5000);
  const over = capResponse("x".repeat(MAX_RESPONSE_CHARS + 10_000));
  check("capResponse trims to the ceiling", over.length <= MAX_RESPONSE_CHARS + 300, true);
  check("capResponse announces the trim", over.includes("서버 상한"), true);
  check("capResponse leaves a short response untouched", capResponse("짧은 응답"), "짧은 응답");

  // ---- Defense 3: encoding -----------------------------------------------
  console.log("\n=== 3. encoding fallback & garble warning ===");

  // unit: replacementRatio
  check("replacementRatio counts U+FFFD", Math.round(replacementRatio("ab�d") * 100), 25);
  check("replacementRatio of clean text", replacementRatio("정상텍스트"), 0);

  // unit: a correctly-declared EUC-KR document decodes cleanly.
  const euc = decodeXmlChecked(eucKrBytes("euc-kr"));
  check("EUC-KR decodes to a low garble ratio", euc.garbleRatio < 0.05, true);
  check("EUC-KR recovers the Korean text", euc.text.includes("삼성전자"), true);

  // unit: the incident's second bug — EUC-KR bytes that mislabel as utf-8.
  // primary=utf-8 garbles heavily, fallback=euc-kr is cleaner and wins.
  const mislabeled = eucKrBytes("utf-8");
  const fixed = decodeXmlChecked(mislabeled);
  check("mislabeled EUC-KR is recovered via fallback", fixed.text.includes("삼성전자"), true);
  check("fallback picked euc-kr", fixed.encoding, "euc-kr");
  check("recovered text is clean", fixed.garbleRatio < 0.05, true);

  // integration: a document that stays garbled after fallback → warning, not a wall of �.
  // Bytes invalid in BOTH utf-8 and euc-kr stay as U+FFFD.
  const junk = new Uint8Array(2000).fill(0xff);
  byRcept[RCEPT_GARBLED] = concat(
    strToU8('<?xml version="1.0" encoding="utf-8"?><DOCUMENT-NAME>깨진문서</DOCUMENT-NAME><P>'),
    junk,
    strToU8("</P>")
  );
  const garbled = await call({ rcept_no: RCEPT_GARBLED, mode: "full" });
  console.log(garbled.text.slice(0, 300));
  check("garbled doc returns a warning", garbled.text.includes("인코딩 문제로 텍스트 추출이 불가능"), true);
  check("warning is short, not a wall of U+FFFD", garbled.text.length < 500, true);
  check("warning does not stream the replacement chars", (garbled.text.match(/�/g) ?? []).length < 10, true);

  // toc still works on a garbled doc (structure is ASCII-ish)
  const garbledToc = await call({ rcept_no: RCEPT_GARBLED, mode: "toc" });
  check("toc still responds on a garbled doc", garbledToc.isError, false);

  globalThis.fetch = realFetch;
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("CRASH:", e); process.exit(1); });
