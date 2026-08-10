/**
 * Is a filing's document.xml archive available on the day it was received?
 *
 * Calls the OpenDART REST API directly (raw fetch, no MCP wrapper, no retries)
 * so the server's own status/message reaches the report unaltered.
 *
 * Re-run tomorrow by changing only the end date:
 *   npm run probe:doc                          # 7 business days ending today
 *   npm run probe:doc -- --end 2026-08-12
 *   npm run probe:doc -- --end 2026-08-12 --days 5 --samples 2 --market Y
 *
 * Reads OPENDART_API_KEY from the environment (or .env). The key is never printed.
 *
 * Budget: 1 list call + <samples> document calls per date, hard-capped at
 * --budget (default 30) and spaced by --delay ms. A failed call is data, so
 * nothing is retried.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------- env & args

const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API_KEY = process.env.OPENDART_API_KEY;
if (!API_KEY) {
  console.error("Error: OPENDART_API_KEY is required (environment or .env).");
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const END_DATE = arg("end") ?? new Date().toISOString().slice(0, 10);
const DAYS = Number(arg("days") ?? 7);
const SAMPLES = Number(arg("samples") ?? 3);
const MARKET = arg("market") ?? "K"; // K=KOSDAQ, Y=KOSPI
const BUDGET = Number(arg("budget") ?? 30);
const DELAY_MS = Number(arg("delay") ?? 600);
const OUT_JSON = arg("out");

if (!/^\d{4}-\d{2}-\d{2}$/.test(END_DATE)) {
  console.error(`Error: --end must be YYYY-MM-DD (got "${END_DATE}")`);
  process.exit(1);
}

// ---------------------------------------------------------------- primitives

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let callsUsed = 0;
function spend(label: string): void {
  if (callsUsed >= BUDGET) {
    throw new Error(`Call budget (${BUDGET}) exhausted before: ${label}`);
  }
  callsUsed++;
}

/** YYYYMMDD strings for the last `count` weekdays ending at `endIso` (inclusive). */
function businessDays(endIso: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${endIso}T00:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push(
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/** Filing route encoded in the receipt number's 6-digit sequence. */
function route(rceptNo: string): string {
  return `${rceptNo.slice(8, 9)}00계열`;
}

/** The sequence itself — a proxy for submission order within the day. */
function seq(rceptNo: string): number {
  return Number(rceptNo.slice(8));
}

const redact = (url: string) => url.replace(/crtfc_key=[^&]*/, "crtfc_key=***");

// ------------------------------------------------------------------- probing

interface DocProbe {
  /** The date whose list this row came from */
  date: string;
  /** Date encoded in the receipt number — the actual receipt date, which is
   *  what a D+n boundary must be measured against. These differ for notices
   *  that reference an earlier filing (효력발생안내 etc.). */
  rceptDate: string;
  rceptNo: string;
  corpName: string;
  reportNm: string;
  route: string;
  seq: number;
  seqRank: string;
  httpStatus: number;
  contentType: string;
  bytes: number;
  isZip: boolean;
  dartStatus: string | null;
  dartMessage: string | null;
  head200: string;
  ok: boolean;
  error?: string;
}

interface ListRow {
  rcept_no: string;
  corp_name: string;
  report_nm: string;
}

/** GET list.json for one date. Returns [] when the API reports no data. */
async function fetchList(date: string): Promise<{ rows: ListRow[]; status: string; message: string }> {
  const url = new URL("https://opendart.fss.or.kr/api/list.json");
  url.searchParams.set("crtfc_key", API_KEY!);
  url.searchParams.set("bgn_de", date);
  url.searchParams.set("end_de", date);
  url.searchParams.set("corp_cls", MARKET);
  url.searchParams.set("page_count", "100");
  url.searchParams.set("sort", "date");
  url.searchParams.set("sort_mth", "asc");

  spend(`list ${date}`);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const data = (await res.json()) as { status: string; message: string; list?: ListRow[] };
  return { rows: data.list ?? [], status: data.status, message: data.message };
}

/**
 * GET document.xml raw. Success is a ZIP (PK magic); failure is an XML body
 * whose <status>/<message> we surface verbatim rather than remapping.
 */
async function probeDocument(date: string, row: ListRow, seqRank: string): Promise<DocProbe> {
  const url = new URL("https://opendart.fss.or.kr/api/document.xml");
  url.searchParams.set("crtfc_key", API_KEY!);
  url.searchParams.set("rcept_no", row.rcept_no);

  const base = {
    date,
    rceptDate: row.rcept_no.slice(0, 8),
    rceptNo: row.rcept_no,
    corpName: row.corp_name,
    reportNm: row.report_nm,
    route: route(row.rcept_no),
    seq: seq(row.rcept_no),
    seqRank,
  };

  spend(`document ${row.rcept_no}`);
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(45000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 200));

    let dartStatus: string | null = null;
    let dartMessage: string | null = null;
    if (!isZip) {
      const whole = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 2000));
      dartStatus = whole.match(/<status>\s*([^<\s]+)\s*<\/status>/i)?.[1] ?? null;
      dartMessage = whole.match(/<message>\s*([\s\S]*?)\s*<\/message>/i)?.[1] ?? null;
    }

    return {
      ...base,
      httpStatus: res.status,
      contentType: res.headers.get("content-type") ?? "(none)",
      bytes: buf.byteLength,
      isZip,
      dartStatus,
      dartMessage,
      head200: head.replace(/\s+/g, " ").trim(),
      ok: isZip,
    };
  } catch (err) {
    // A transport failure is data too — record it, do not retry.
    return {
      ...base,
      httpStatus: 0,
      contentType: "(request failed)",
      bytes: 0,
      isZip: false,
      dartStatus: null,
      dartMessage: null,
      head200: "",
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

/**
 * Up to `n` filings per date, chosen to separate the confounders:
 * both receipt routes when present, and the earliest / latest sequence numbers
 * as a proxy for time of day (the list API exposes no submission time).
 */
function sample(rows: ListRow[], n: number): Array<{ row: ListRow; seqRank: string }> {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => seq(a.rcept_no) - seq(b.rcept_no));
  const picked: Array<{ row: ListRow; seqRank: string }> = [];
  const taken = new Set<string>();

  const take = (row: ListRow | undefined, rank: string) => {
    if (!row || taken.has(row.rcept_no) || picked.length >= n) return;
    taken.add(row.rcept_no);
    picked.push({ row, seqRank: rank });
  };

  take(sorted[0], "earliest");
  take(sorted[sorted.length - 1], "latest");
  // A different route than what we already hold, so route and time don't co-vary
  const haveRoutes = new Set(picked.map((p) => route(p.row.rcept_no)));
  take(sorted.find((r) => !haveRoutes.has(route(r.rcept_no))), "other-route");
  // Fill any remainder from the middle
  take(sorted[Math.floor(sorted.length / 2)], "middle");
  for (const r of sorted) take(r, "fill");

  return picked.slice(0, n);
}

// -------------------------------------------------------------------- report

/** Does lib/opendart/errors.ts know this status code, or does it fall back to 900? */
function wrapperKnows(code: string): { known: boolean; ko: string | null } {
  const p = join(process.cwd(), "lib", "opendart", "errors.ts");
  if (!existsSync(p)) return { known: false, ko: null };
  const src = readFileSync(p, "utf-8");
  const m = src.match(new RegExp(`"${code}":\\s*\\{[^}]*ko:\\s*"([^"]*)"`));
  return { known: !!m, ko: m?.[1] ?? null };
}

function pad(s: string, w: number): string {
  // Korean glyphs render double-width; count them twice so columns line up.
  const width = [...s].reduce((n, c) => n + (/[ᄀ-ᇿ㄰-㆏가-힣一-鿿]/.test(c) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, w - width));
}

/**
 * Single-receipt mode: probe one rcept_no and print the raw evidence.
 * Re-running this on a filing that previously failed distinguishes a permanent
 * "this filing has no archive" from a transient generation lag.
 */
async function probeOne(rceptNo: string) {
  console.log(`OpenDART document.xml single probe`);
  console.log(`  rcept_no : ${rceptNo}  (접수일 ${rceptNo.slice(0, 8)}, ${route(rceptNo)})`);
  console.log(`  실행 시각 : ${new Date().toISOString()}`);
  console.log();

  const p = await probeDocument(
    rceptNo.slice(0, 8),
    { rcept_no: rceptNo, corp_name: "(미조회)", report_nm: "(미조회)" },
    "single",
  );

  console.log(`HTTP         : ${p.httpStatus}`);
  console.log(`Content-Type : ${p.contentType}`);
  console.log(`bytes        : ${p.bytes.toLocaleString()}`);
  console.log(`ZIP 여부      : ${p.isZip ? "예 (성공)" : "아니오"}`);
  console.log(`앞 200바이트  : ${p.head200.slice(0, 200)}`);

  if (p.isZip) {
    console.log(`\n결과: 성공 — 원문 아카이브 존재.`);
    return;
  }

  const w = wrapperKnows(p.dartStatus ?? "");
  console.log(`\nstatus       : ${p.dartStatus ?? "(없음)"}`);
  console.log(`message      : "${p.dartMessage ?? p.error ?? "(없음)"}"`);
  console.log(
    `래퍼 매핑     : ${w.known ? `있음 → "${w.ko}"` : `★ 없음 → 900 폴백 "정의되지 않은 오류가 발생하였습니다"`}`,
  );
  console.log(`\n결과: 실패.`);
}

async function main() {
  // Re-render the report from a saved --out file. Costs no API calls, so the
  // reporting logic can be checked (and past runs re-analysed) without quota.
  const replay = arg("replay");
  if (replay) {
    const saved = JSON.parse(readFileSync(replay, "utf-8")) as {
      endDate: string;
      dates: string[];
      market: string;
      probes: DocProbe[];
    };
    // Files written before rceptDate existed have it undefined, which would
    // make every row look like a date mismatch. Derive it from the receipt
    // number, which is where it comes from anyway.
    const probes = saved.probes.map((p) => ({
      ...p,
      rceptDate: p.rceptDate ?? p.rceptNo.slice(0, 8),
    }));
    console.log(`replay: ${replay}  (${probes.length} probes, end ${saved.endDate})\n`);
    report(probes, saved.dates);
    return;
  }

  const single = arg("rcept");
  if (single) {
    if (!/^\d{14}$/.test(single)) {
      console.error(`Error: --rcept must be 14 digits (got "${single}")`);
      process.exit(1);
    }
    await probeOne(single);
    console.log(`\n사용한 호출 수: ${callsUsed}`);
    return;
  }

  const dates = businessDays(END_DATE, DAYS);
  const planned = dates.length * (1 + SAMPLES);

  console.log(`OpenDART document.xml availability probe`);
  console.log(`  end date : ${END_DATE}  (${DAYS} business days: ${dates.join(", ")})`);
  console.log(`  market   : ${MARKET === "K" ? "KOSDAQ" : MARKET === "Y" ? "KOSPI" : MARKET}`);
  console.log(`  samples  : ${SAMPLES} per date   delay: ${DELAY_MS}ms   budget: ${BUDGET}`);
  console.log(`  planned  : ${planned} calls${planned > BUDGET ? "  ⚠️ OVER BUDGET" : ""}`);
  console.log();

  const probes: DocProbe[] = [];
  const listNotes: string[] = [];

  for (const date of dates) {
    let listed;
    try {
      listed = await fetchList(date);
    } catch (err) {
      listNotes.push(`${date}: list call failed — ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    await sleep(DELAY_MS);

    if (listed.rows.length === 0) {
      listNotes.push(`${date}: no filings listed (status ${listed.status} "${listed.message}") — holiday or no data`);
      console.log(`${date}  목록 0건 (status ${listed.status})`);
      continue;
    }

    const picks = sample(listed.rows, SAMPLES);
    console.log(`${date}  목록 ${listed.rows.length}건 → ${picks.length}건 샘플링`);

    for (const { row, seqRank } of picks) {
      let p: DocProbe;
      try {
        p = await probeDocument(date, row, seqRank);
      } catch (err) {
        listNotes.push(`${date}: stopped — ${err instanceof Error ? err.message : String(err)}`);
        console.log(`  (예산 소진으로 중단)`);
        break;
      }
      probes.push(p);
      const verdict = p.ok
        ? `OK   ZIP ${(p.bytes / 1024).toFixed(0)}KB`
        : `FAIL status=${p.dartStatus ?? "?"} "${p.dartMessage ?? p.error ?? "?"}"`;
      console.log(`  ${p.rceptNo} ${pad(p.route, 10)} ${pad(p.seqRank, 12)} ${verdict}`);
      await sleep(DELAY_MS);
    }
  }

  report(probes, dates);

  console.log(`\n사용한 호출 수: ${callsUsed} / 예산 ${BUDGET}`);
  for (const n of listNotes) console.log(`  note: ${n}`);

  if (OUT_JSON) {
    writeFileSync(OUT_JSON, JSON.stringify({ endDate: END_DATE, dates, market: MARKET, probes }, null, 2));
    console.log(`\nraw 결과 저장: ${OUT_JSON}`);
  }
}

/** Renders sections [1]–[4]. Pure: takes probes, prints. Reused by --replay. */
function report(probes: DocProbe[], dates: string[]) {
  // ---- 1. date × route × result
  console.log(`\n${"=".repeat(78)}\n[1] 날짜 × 접수경로 × 결과\n${"=".repeat(78)}`);
  console.log(`${pad("날짜", 10)} ${pad("접수번호", 16)} ${pad("경로", 10)} ${pad("순번위치", 12)} ${pad("결과", 8)} 회사`);
  for (const p of probes) {
    console.log(
      `${pad(p.date, 10)} ${pad(p.rceptNo, 16)} ${pad(p.route, 10)} ${pad(p.seqRank, 12)} ${pad(p.ok ? "성공" : "실패", 8)} ${p.corpName}`,
    );
  }

  // Grouped by RECEIPT date, not list date. A notice can be listed on one day
  // while its receipt number carries the referenced filing's earlier date;
  // charging it to the list date would fake a boundary that isn't there.
  const byDate = new Map<string, { ok: number; fail: number }>();
  for (const p of probes) {
    const e = byDate.get(p.rceptDate) ?? { ok: 0, fail: 0 };
    p.ok ? e.ok++ : e.fail++;
    byDate.set(p.rceptDate, e);
  }

  const mismatched = probes.filter((p) => p.rceptDate !== p.date);
  if (mismatched.length > 0) {
    console.log(`\n⚠️ 접수번호 날짜 ≠ 목록 날짜 (아래 집계는 접수번호 날짜 기준)`);
    for (const p of mismatched) {
      console.log(`  ${p.rceptNo} 목록:${p.date} / 접수:${p.rceptDate} ${p.ok ? "성공" : "실패"} — ${p.reportNm}`);
    }
  }

  console.log(`\n날짜별 집계 (접수번호 날짜 기준)`);
  console.log(`${pad("날짜", 10)} ${pad("성공", 6)} ${pad("실패", 6)} 판정`);
  const seenDates = [...byDate.keys()].sort().reverse();
  for (const date of seenDates) {
    const e = byDate.get(date)!;
    const verdict = e.ok > 0 && e.fail === 0 ? "조회 가능" : e.ok === 0 && e.fail > 0 ? "조회 불가" : "혼재";
    console.log(`${pad(date, 10)} ${pad(String(e.ok), 6)} ${pad(String(e.fail), 6)} ${verdict}`);
  }

  // ---- 2. status → message, verbatim
  console.log(`\n${"=".repeat(78)}\n[2] status 코드별 실제 message 원문\n${"=".repeat(78)}`);
  const byStatus = new Map<string, { message: string; count: number; sample: DocProbe }>();
  for (const p of probes) {
    if (p.ok) continue;
    const key = p.dartStatus ?? `(transport) ${p.error ?? ""}`;
    const e = byStatus.get(key);
    if (e) e.count++;
    else byStatus.set(key, { message: p.dartMessage ?? p.error ?? "", count: 1, sample: p });
  }
  if (byStatus.size === 0) {
    console.log("실패한 호출 없음.");
  }
  for (const [status, e] of byStatus) {
    const w = wrapperKnows(status);
    console.log(`\nstatus=${status}  (${e.count}건)`);
    console.log(`  API message  : "${e.message}"`);
    console.log(`  Content-Type : ${e.sample.contentType}`);
    console.log(`  앞 200바이트 : ${e.sample.head200.slice(0, 200)}`);
    console.log(
      `  래퍼 매핑     : ${w.known ? `있음 → "${w.ko}"` : `★ 없음 → 900 폴백 "정의되지 않은 오류가 발생하였습니다"`}`,
    );
  }

  // ---- 3. confounders
  console.log(`\n${"=".repeat(78)}\n[3] 교란 변수\n${"=".repeat(78)}`);
  const group = (key: (p: DocProbe) => string) => {
    const m = new Map<string, { ok: number; fail: number }>();
    for (const p of probes) {
      const e = m.get(key(p)) ?? { ok: 0, fail: 0 };
      p.ok ? e.ok++ : e.fail++;
      m.set(key(p), e);
    }
    return m;
  };
  console.log(`접수경로별 (전체 기간)`);
  for (const [k, e] of group((p) => p.route)) {
    console.log(`  ${pad(k, 10)} 성공 ${e.ok} / 실패 ${e.fail}`);
  }
  console.log(`순번 위치별 (제출 시각 대리지표 — 목록 API는 시각을 제공하지 않음)`);
  for (const [k, e] of group((p) => p.seqRank)) {
    console.log(`  ${pad(k, 12)} 성공 ${e.ok} / 실패 ${e.fail}`);
  }
  const failures = probes.filter((p) => !p.ok);
  if (failures.length > 0) {
    console.log(`\n실패 건 전수 (보고서 유형이 날짜보다 잘 설명하는지 확인)`);
    for (const p of failures) {
      console.log(
        `  접수 ${p.rceptDate} ${p.rceptNo} ${pad(p.route, 10)} status=${p.dartStatus ?? "?"} — ${p.reportNm}`,
      );
    }
  }

  // ---- 4. conclusion
  console.log(`\n${"=".repeat(78)}\n[4] 결론\n${"=".repeat(78)}`);
  const okDates = seenDates.filter((d) => (byDate.get(d)?.ok ?? 0) > 0);
  const badDates = seenDates.filter((d) => byDate.get(d)!.ok === 0 && byDate.get(d)!.fail > 0);
  const newestOk = okDates.length ? okDates.reduce((a, b) => (a > b ? a : b)) : null;

  // A date-only model is too coarse: 014 has two causes that look identical.
  // Failures confined to the newest date point at generation lag (measured in
  // hours — later receipt numbers fail while earlier same-day ones succeed);
  // failures on older dates are filings that will never have an archive.
  const newestDate = seenDates[0];
  const staleBad = badDates.filter((d) => d !== newestDate);

  if (badDates.length === 0) {
    console.log(`실패 없음 — 표본 전체 조회 가능.`);
  } else {
    console.log(`조회 불가 날짜 : ${badDates.join(", ")}`);
    if (newestOk) console.log(`조회 가능 최신 : ${newestOk}`);

    if (badDates.includes(newestDate)) {
      const sameDay = probes.filter((p) => p.rceptDate === newestDate);
      const okSeq = sameDay.filter((p) => p.ok).map((p) => p.seq);
      const badSeq = sameDay.filter((p) => !p.ok).map((p) => p.seq);
      console.log(`→ 최신일(${newestDate}) 실패 있음: 접수 직후 아카이브 미생성 가능성.`);
      if (okSeq.length && badSeq.length) {
        console.log(
          `  같은 날 성공 순번 최대 ${Math.max(...okSeq)} / 실패 순번 최소 ${Math.min(...badSeq)} → 그 사이에 시각 경계.`,
        );
      }
      console.log(`  확인법: 내일 --rcept 로 재조회. 성공하면 지연, 여전히 014면 원문 없는 공시.`);
    }
    if (staleBad.length) {
      console.log(`→ 과거일(${staleBad.join(", ")}) 실패: 시간이 지나도 안 생기므로 원문 자체가 없는 공시.`);
      console.log(`  (효력발생안내·기타시장안내 등 안내성 공시는 목록에만 있고 원문이 없음)`);
    }
  }

  const unmapped = [...byStatus.keys()].filter((s) => /^\d{3}$/.test(s) && !wrapperKnows(s).known);
  console.log(
    `\n래퍼 코드-메시지 매핑이 틀렸는가: ${unmapped.length > 0 ? `예 — ${unmapped.join(", ")} 미매핑` : "아니오 — 관측된 코드가 모두 매핑돼 있음"}`,
  );
  if (unmapped.length > 0) {
    console.log(`  lib/opendart/errors.ts의 STATUS_MESSAGES에 없어 900 메시지로 대체 표시됨.`);
  }
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  console.error(`사용한 호출 수: ${callsUsed} / 예산 ${BUDGET}`);
  process.exit(1);
});
