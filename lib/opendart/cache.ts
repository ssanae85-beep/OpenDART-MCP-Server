import { unzipSync } from "fflate";
import { getBinary, resolveApiKey } from "./client";
import type { CorpCodeEntry } from "./types";

interface CorpCodeCache {
  entries: CorpCodeEntry[];
  byCorpCode: Map<string, CorpCodeEntry>;
  byStockCode: Map<string, CorpCodeEntry>;
  updatedAt: number;
}

let cache: CorpCodeCache | null = null;
let loadingPromise: Promise<CorpCodeCache> | null = null;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function parseCorpCodeXml(xml: string): CorpCodeEntry[] {
  const entries: CorpCodeEntry[] = [];
  const regex = /<list>\s*<corp_code>([^<]*)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>\s*<stock_code>([^<]*)<\/stock_code>\s*<modify_date>([^<]*)<\/modify_date>\s*<\/list>/g;

  let match;
  while ((match = regex.exec(xml)) !== null) {
    entries.push({
      corp_code: match[1].trim(),
      corp_name: match[2].trim(),
      stock_code: match[3].trim(),
      modify_date: match[4].trim(),
    });
  }
  return entries;
}

export async function loadCorpCodes(apiKey?: string): Promise<CorpCodeCache> {
  if (cache && Date.now() - cache.updatedAt < TTL_MS) {
    return cache;
  }

  // 이미 로딩 중이면 같은 Promise 반환 (중복 다운로드 방지)
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const key = resolveApiKey(apiKey);
      const buffer = await getBinary("corpCode", {}, key);
      const uint8 = new Uint8Array(buffer);

      const unzipped = unzipSync(uint8);
      const xmlFileName = Object.keys(unzipped)[0];
      const rawBytes = unzipped[xmlFileName];

      // Detect encoding from XML declaration (OpenDART may use EUC-KR)
      const asciiPreview = new TextDecoder("ascii").decode(rawBytes.slice(0, 200));
      const encMatch = asciiPreview.match(/encoding=["']([^"']+)["']/i);
      const detectedEnc = encMatch?.[1].toLowerCase() ?? "";
      const decoder = new TextDecoder(
        detectedEnc === "euc-kr" || detectedEnc === "cp949" ? "euc-kr" : "utf-8"
      );
      const xml = decoder.decode(rawBytes);

      const entries = parseCorpCodeXml(xml);
      const byCorpCode = new Map<string, CorpCodeEntry>();
      const byStockCode = new Map<string, CorpCodeEntry>();

      for (const entry of entries) {
        byCorpCode.set(entry.corp_code, entry);
        if (entry.stock_code) {
          byStockCode.set(entry.stock_code, entry);
        }
      }

      cache = { entries, byCorpCode, byStockCode, updatedAt: Date.now() };
      return cache;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

export async function searchCompanies(
  query: string,
  apiKey?: string,
  limit: number = 10
): Promise<CorpCodeEntry[]> {
  const c = await loadCorpCodes(apiKey);
  const q = query.toLowerCase().replace(/\s/g, "");

  if (!q) return [];

  // Try exact stock code match first
  const byStock = c.byStockCode.get(query.trim());
  if (byStock) return [byStock];

  // Try exact corp code match
  const byCode = c.byCorpCode.get(query.trim());
  if (byCode) return [byCode];

  // Fuzzy search by name
  const exactMatches: CorpCodeEntry[] = [];
  const prefixMatches: CorpCodeEntry[] = [];
  const containsMatches: CorpCodeEntry[] = [];

  for (const entry of c.entries) {
    const name = entry.corp_name.toLowerCase().replace(/\s/g, "");
    if (name === q) {
      exactMatches.push(entry);
    } else if (name.startsWith(q)) {
      prefixMatches.push(entry);
    } else if (name.includes(q)) {
      containsMatches.push(entry);
    }

    if (exactMatches.length + prefixMatches.length + containsMatches.length >= limit * 3) {
      break;
    }
  }

  // Prioritize listed companies (with stock_code)
  const sorted = [...exactMatches, ...prefixMatches, ...containsMatches].sort((a, b) => {
    const aListed = a.stock_code ? 0 : 1;
    const bListed = b.stock_code ? 0 : 1;
    return aListed - bListed;
  });

  return sorted.slice(0, limit);
}

export async function getCorpCodeByName(
  name: string,
  apiKey?: string
): Promise<CorpCodeEntry | null> {
  const results = await searchCompanies(name, apiKey, 1);
  return results[0] || null;
}

/** Returns cache diagnostic info for debugging search failures */
export function getCacheDiagnostics(): {
  loaded: boolean;
  entryCount: number;
  sampleNames: string[];
} {
  if (!cache) return { loaded: false, entryCount: 0, sampleNames: [] };
  return {
    loaded: true,
    entryCount: cache.entries.length,
    sampleNames: cache.entries.slice(0, 5).map((e) => e.corp_name),
  };
}
