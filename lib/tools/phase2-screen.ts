/**
 * opendart_phase2_screen — 2국면 전환 판정 도구
 *
 * 목적
 *   여러 종목의 TTM 매출액·영업이익을 서버 안에서 계산해
 *   "직전 분기 2국면 불성립 → 대상 분기 성립" 여부를 회사당 한 줄로 반환한다.
 *   원자료(재무상태표·연결/별도 전체)를 모델 컨텍스트에 싣지 않는 것이 핵심.
 *
 * 판정 정의
 *   TTM(Y,q)      = FY(Y-1) + 누계(Y,q) − 누계(Y-1,q)        (q=4이면 FY(Y), 즉 Q4 = 연간 − 3Q 누계)
 *   OPM(t)        = TTM 영업이익 합계 ÷ TTM 매출 합계        (분기 OPM 평균 아님)
 *   2국면(t)      = OPM(t) > OPM(t−4)   엄격 부등호, 반올림 전 값 비교
 *   신규 전환      = 2국면(t) 성립 & 2국면(t−1) 불성립   (2국면(t−1) = OPM(t−1) > OPM(t−5))
 *   판정 불가      = 필요한 TTM 중 하나라도 결측이거나 TTM 매출 ≤ 0 (비고 결측/매출≤0)
 *                   대상 분기는 되는데 직전 분기만 안 되면 "판정 불가(전기)".
 *                   적자 영업이익은 그대로 쓴다 — 절댓값·0 클램프 없음.
 *   비교는 언제나 4분기 전 TTM과만 한다 (직전 분기 TTM과 직접 비교하지 않음).
 *   기준           = 연결이 대상 분기 TTM(t, t−4)을 갖추면 연결, 못 갖출 때만 별도(비고 "별도").
 *                   한 종목 안에서 t와 t−1의 기준을 섞지 않는다 — 연결로 t−1이 안 되면
 *                   별도로 바꾸지 않고 "판정 불가(전기)".
 *
 * DART 호출량
 *   fnlttMultiAcnt(100개사/회) × 필요한 보고서 5종 × ceil(N/100)
 *   예) 444개사, 26Q2 판정 → 5종 × 5묶음 = 25회
 *
 * 이 저장소에 맞춘 차이
 *   - API 키: DART_API_KEY 대신 resolveApiKey — 커넥터 URL(?opendart_key=),
 *     set_api_key, OPENDART_API_KEY를 모두 인식한다. DART_API_KEY만 읽으면
 *     URL로 키를 넘기는 배포본에서 모든 호출이 "키가 없습니다"로 끝난다.
 *   - 종목 인덱스: 요청마다 corpCode.xml(3.4MB)을 받지 않고, CI가 매주
 *     갱신하는 data/corp-codes.json을 쓴다(60초 예산 보호).
 *   - DART 호출: getJson 경유. 013(보고서 미제출)만 "데이터 없음"으로 보고,
 *     키 오류·한도 초과(010/020/800 등)는 에러로 올린다. 원본처럼 000이
 *     아니면 빈 결과로 넘기면, 한도 초과가 전 종목 "보고서/계정 누락"
 *     판정으로 둔갑해 틀린 스크리닝 결과가 정상처럼 보인다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getJson, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError, isNoData } from "@/lib/opendart/errors";
import { getListedCorpIndex, type ListedCorpIndex } from "@/lib/opendart/cache";

export type RC = "11013" | "11012" | "11014" | "11011";
const RC_OF_Q: Record<number, RC> = { 1: "11013", 2: "11012", 3: "11014", 4: "11011" };

export interface Amt { th: number | null; thCum: number | null; fr: number | null; frCum: number | null }
export interface Stmt { rev?: Amt; op?: Amt }
export interface CorpRep { CFS: Stmt; OFS: Stmt }
/** key: `${year}-${reprt_code}` → corp_code → 계정값 */
export type Store = Map<string, Map<string, CorpRep>>;

const REV_NAMES = new Set(["매출액", "영업수익", "수익(매출액)", "매출"]);
const OP_NAMES = new Set(["영업이익", "영업이익(손실)"]);

const num = (s?: string | null): number | null => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

// ───────────────────────── 기간 계산 (순수 함수) ─────────────────────────

export const prevQuarter = (y: number, q: number): [number, number] => (q === 1 ? [y - 1, 4] : [y, q - 1]);

/** (Y,q)의 TTM과 YoY 기저 계산에 필요한 보고서 목록 */
export function reportsFor(y: number, q: number): Array<[number, RC]> {
  if (q === 4) return [[y, "11011"]];
  return [[y - 1, "11011"], [y, RC_OF_Q[q]], [y - 1, RC_OF_Q[q]]];
}

const cumTh = (a?: Amt) => (a ? a.thCum ?? a.th : null);
const cumFr = (a?: Amt) => (a ? a.frCum ?? a.fr : null);
const add = (...xs: Array<number | null>) => (xs.some((x) => x == null) ? null : (xs as number[]).reduce((s, x) => s + x, 0));

/** TTM(Y,q)와 TTM(Y-1,q). 전기 누계는 최신 보고서의 비교표시값을 사용(재작성 반영) */
export function ttmPair(get: (y: number, rc: RC) => Stmt | undefined, y: number, q: number, key: "rev" | "op") {
  if (q === 4) {
    const A = get(y, "11011")?.[key];
    return { cur: A?.th ?? null, base: A?.fr ?? null };
  }
  const rc = RC_OF_Q[q];
  const A = get(y - 1, "11011")?.[key];
  const R = get(y, rc)?.[key];
  const R1 = get(y - 1, rc)?.[key];
  const cur = add(A?.th ?? null, cumTh(R), cumFr(R) == null ? null : -(cumFr(R) as number));
  const base = add(A?.fr ?? null, cumFr(R), cumFr(R1) == null ? null : -(cumFr(R1) as number));
  return { cur, base };
}

export type Note = "" | "결측" | "매출≤0";

/**
 * 2국면 = OPM(t) > OPM(t−4). OPM은 TTM 합계끼리 나눈 값.
 * 결측이나 TTM 매출 ≤ 0이면 불성립이 아니라 판정 불가(ok=null)다.
 */
export function phase2(revBase: number | null, opBase: number | null, revCur: number | null, opCur: number | null) {
  if (![revBase, opBase, revCur, opCur].every((x) => x != null && Number.isFinite(x)))
    return { ok: null, opmBase: null, opm: null, note: "결측" as Note };
  if ((revBase as number) <= 0 || (revCur as number) <= 0)
    return { ok: null, opmBase: null, opm: null, note: "매출≤0" as Note };
  const opmBase = (opBase as number) / (revBase as number), opm = (opCur as number) / (revCur as number);
  return { ok: opm > opmBase, opmBase, opm, note: "" as Note };
}

export type Status = "NEW" | "CONTINUE" | "LOST" | "NONE" | "NA_PREV" | "NA";

export interface Verdict {
  corp: string; name: string; fs: "CFS" | "OFS" | "-";
  /** OPM(t−4), OPM(t), OPM(t−5), OPM(t−1) — 비율(0.1 = 10%) */
  opmBase: number | null; opm: number | null; prevOpmBase: number | null; prevOpm: number | null;
  ttmRev: number | null; ttmOp: number | null;
  /** 결측/매출≤0, 별도 기준이면 앞에 "별도" */
  status: Status; note: string;
}

export function judge(store: Store, corp: string, name: string, y: number, q: number): Verdict {
  const [py, pq] = prevQuarter(y, q);
  const blank: Verdict = { corp, name, fs: "-", opmBase: null, opm: null, prevOpmBase: null, prevOpm: null,
    ttmRev: null, ttmOp: null, status: "NA", note: "결측" };

  // 기준은 대상 분기만 보고 고른다: 연결이 TTM(t)·TTM(t−4)를 갖추면 연결, 아니면 별도.
  // 직전 분기는 고른 기준으로만 계산한다 — 연결로 안 된다고 별도로 바꾸지 않는다.
  const basis = (fs: "CFS" | "OFS") => {
    const get = (yy: number, rc: RC) => store.get(`${yy}-${rc}`)?.get(corp)?.[fs];
    const r = ttmPair(get, y, q, "rev"), o = ttmPair(get, y, q, "op");
    return [r.cur, r.base, o.cur, o.base].every((x) => x != null) ? { fs, get, rC: r, oC: o } : null;
  };
  const b = basis("CFS") ?? basis("OFS");
  if (!b) return blank;

  const { fs, get, rC, oC } = b;
  const rP = ttmPair(get, py, pq, "rev"), oP = ttmPair(get, py, pq, "op");
  const now = phase2(rC.base, oC.base, rC.cur, oC.cur);
  const before = phase2(rP.base, oP.base, rP.cur, oP.cur);
  const note = (n: Note) => [fs === "OFS" ? "별도" : "", n].filter(Boolean).join(", ");
  const v: Verdict = { ...blank, fs, note: note(""),
    opmBase: now.opmBase, opm: now.opm, prevOpmBase: before.opmBase, prevOpm: before.opm,
    ttmRev: rC.cur, ttmOp: oC.cur };

  if (now.ok == null) return { ...v, status: "NA", note: note(now.note) };
  if (before.ok == null) return { ...v, status: "NA_PREV", note: note(before.note) };
  v.status = now.ok ? (before.ok ? "CONTINUE" : "NEW") : (before.ok ? "LOST" : "NONE");
  return v;
}

// ───────────────────────── DART I/O ─────────────────────────

interface MultiAcntRow {
  corp_code?: string; stock_code?: string; sj_div?: string; account_nm?: string; fs_div?: string;
  thstrm_amount?: string; thstrm_add_amount?: string; frmtrm_amount?: string; frmtrm_add_amount?: string;
}

/**
 * One fnlttMultiAcnt call for up to 100 companies. 013 (report not filed) is an
 * empty result; every other non-000 status throws through getJson, so a key
 * error or rate limit surfaces instead of posing as missing reports.
 */
async function fetchMulti(key: string, corps: string[], y: number, rc: RC, idx: ListedCorpIndex) {
  const out = new Map<string, CorpRep>();
  const j = await getJson("fnlttMultiAcnt", { corp_code: corps.join(","), bsns_year: String(y), reprt_code: rc }, key);
  if (isNoData(j.status as string)) return out;
  for (const it of (j.list ?? []) as MultiAcntRow[]) {
    if (it.sj_div !== "IS") continue;
    const corp = it.corp_code ?? (it.stock_code ? idx.byStock.get(it.stock_code) : undefined);
    if (!corp) continue;
    const k = it.account_nm && REV_NAMES.has(it.account_nm) ? "rev" : it.account_nm && OP_NAMES.has(it.account_nm) ? "op" : null;
    if (!k) continue;
    const fs = it.fs_div === "CFS" ? "CFS" : "OFS";
    const rep = out.get(corp) ?? { CFS: {}, OFS: {} };
    if (!rep[fs][k]) rep[fs][k] = { th: num(it.thstrm_amount), thCum: num(it.thstrm_add_amount),
      fr: num(it.frmtrm_amount), frCum: num(it.frmtrm_add_amount) };
    out.set(corp, rep);
  }
  return out;
}

async function pool<T>(tasks: Array<() => Promise<T>>, n = 4) {
  const res: T[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; res[k] = await tasks[k](); } }));
  return res;
}

// ───────────────────────── 출력 ─────────────────────────

/** 음수는 ASCII "-" (U+2212 아님) */
const opmPct = (x: number | null) => (x == null ? "-" : (x * 100).toFixed(1));
const dPp = (a: number | null, b: number | null) => {
  if (a == null || b == null) return "-";
  const d = (b - a) * 100;
  return `${d > 0 ? "+" : d < 0 ? "-" : ""}${Math.abs(d).toFixed(1)}`;
};
const eok = (x: number | null) => (x == null ? "-" : Math.round(x / 1e8).toLocaleString("ko-KR"));
const ORDER: Status[] = ["NEW", "CONTINUE", "LOST", "NONE", "NA_PREV", "NA"];
const LABEL: Record<Status, string> = { NEW: "신규 전환", CONTINUE: "지속", LOST: "이탈", NONE: "미성립",
  NA_PREV: "판정 불가(전기)", NA: "판정 불가" };

export function render(vs: Verdict[], y: number, q: number, output: "new" | "all", unresolved: string[]) {
  const [py, pq] = prevQuarter(y, q);
  const cnt = (s: Status) => vs.filter((v) => v.status === s).length;
  const lines = [
    `2국면 전환 판정 · ${py}Q${pq} → ${y}Q${q} · 2국면 = TTM OPM(t) > OPM(t−4) · [1차] DART fnlttMultiAcnt`,
    `대상 ${vs.length} | ${ORDER.map((s) => `${LABEL[s]} ${cnt(s)}`).join(" | ")}`,
  ];
  if (unresolved.length) lines.push(`코드 변환 실패: ${unresolved.join(", ")}`);
  const rows = vs.filter((v) => output === "all" || v.status === "NEW")
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  lines.push("", `| 종목 | 기준 | 판정 | OPM(t−4)(%) | OPM(t)(%) | ΔOPM(%p) | TTM매출(억) | TTM영익(억) | 비고 |`,
    `|---|---|---|---|---|---|---|---|---|`);
  for (const v of rows)
    lines.push(`| ${v.name} | ${v.fs} | ${LABEL[v.status]} | ${opmPct(v.opmBase)} | ${opmPct(v.opm)} | ${dPp(v.opmBase, v.opm)} | ${eok(v.ttmRev)} | ${eok(v.ttmOp)} | ${v.note} |`);
  if (output === "new") {
    for (const s of ["NA_PREV", "NA"] as const) {
      const na = vs.filter((v) => v.status === s);
      if (na.length) lines.push("", `${LABEL[s]}: ${na.map((v) => `${v.name}(${v.note})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

// ───────────────────────── MCP 등록 ─────────────────────────

export function registerPhase2Screen(server: McpServer) {
  server.registerTool(
    "opendart_phase2_screen",
    {
      title: "2국면 전환 판정 (Phase-2 Screen)",
      description:
        "여러 종목의 2국면(TTM OPM이 4분기 전 TTM 대비 상승) 성립과 신규 전환 여부를 서버에서 계산해 회사당 한 줄로 반환한다. " +
        "items에 종목명·6자리 종목코드·8자리 corp_code를 섞어 넣을 수 있다(최대 500). 원자료 재무표를 가져오지 않으므로 대량 스크리닝은 반드시 이 도구를 쓴다.",
      inputSchema: {
        items: z.string().describe("쉼표/줄바꿈 구분. 종목명(정확 일치), 종목코드 6자리, corp_code 8자리 혼용 가능"),
        year: z.number().int().describe("대상 분기의 연도 (예: 2026)"),
        quarter: z.number().int().min(1).max(4).describe("대상 분기 (1~4). 2국면은 4분기 전 TTM과 비교하고, 신규 전환은 직전 분기의 2국면 상태와 비교해 판정한다."),
        output: z.enum(["new", "all"]).default("new").describe("new=신규 전환 종목만 표로, all=전 종목"),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const key = resolveApiKey(a.api_key);
        const idx = getListedCorpIndex();

        const corps: string[] = [], unresolved: string[] = [];
        for (const raw of a.items.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
          const c = /^\d{8}$/.test(raw) ? raw : /^[0-9A-Z]{6}$/.test(raw) ? idx.byStock.get(raw)
            : (idx.byName.get(raw)?.length === 1 ? idx.byName.get(raw)![0] : undefined);
          if (c && idx.byCorp.has(c)) { if (!corps.includes(c)) corps.push(c); }
          else unresolved.push(raw);
        }
        if (corps.length > 500) return { content: [{ type: "text" as const, text: "한 번에 최대 500개까지 처리합니다." }] };

        const [py, pq] = prevQuarter(a.year, a.quarter);
        const reports = [...reportsFor(a.year, a.quarter), ...reportsFor(py, pq)]
          .filter(([y, rc], i, arr) => arr.findIndex(([y2, rc2]) => y2 === y && rc2 === rc) === i);
        const batches = Array.from({ length: Math.ceil(corps.length / 100) }, (_, i) => corps.slice(i * 100, i * 100 + 100));

        const store: Store = new Map();
        const tasks = reports.flatMap(([y, rc]) => batches.map((b) => async () => {
          const m = await fetchMulti(key, b, y, rc, idx);
          const k = `${y}-${rc}`; const s = store.get(k) ?? new Map<string, CorpRep>(); m.forEach((v, c) => s.set(c, v)); store.set(k, s);
        }));
        await pool(tasks, 4);

        const verdicts = corps.map((c) => judge(store, c, idx.byCorp.get(c)!.name, a.year, a.quarter));
        return { content: [{ type: "text" as const, text: render(verdicts, a.year, a.quarter, a.output, unresolved) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    },
  );
}
