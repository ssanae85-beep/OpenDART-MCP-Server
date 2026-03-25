import { unzipSync } from "fflate";
import { getBinary, resolveApiKey } from "./client";
import type { CorpCodeEntry } from "./types";

interface CorpCodeCache {
  entries: CorpCodeEntry[];
  byCorpCode: Map<string, CorpCodeEntry>;
  byStockCode: Map<string, CorpCodeEntry>;
  updatedAt: number;
  xmlPreview: string; // first 500 chars of XML for diagnostics
}

let cache: CorpCodeCache | null = null;
let loadingPromise: Promise<CorpCodeCache> | null = null;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function parseCorpCodeXml(xml: string): CorpCodeEntry[] {
  const entries: CorpCodeEntry[] = [];

  // Remove BOM if present
  const cleanXml = xml.replace(/^\uFEFF/, "");

  // Split-based parsing: more robust than single regex
  const chunks = cleanXml.split(/<\/list>/i);

  for (const chunk of chunks) {
    const corpCode = chunk.match(/<corp_code>\s*([^<]*?)\s*<\/corp_code>/i);
    const corpName = chunk.match(/<corp_name>\s*([^<]*?)\s*<\/corp_name>/i);
    const stockCode = chunk.match(/<stock_code>\s*([^<]*?)\s*<\/stock_code>/i);
    const modifyDate = chunk.match(/<modify_date>\s*([^<]*?)\s*<\/modify_date>/i);

    if (corpCode && corpName) {
      entries.push({
        corp_code: corpCode[1].trim(),
        corp_name: corpName[1].trim(),
        stock_code: stockCode?.[1]?.trim() || "",
        modify_date: modifyDate?.[1]?.trim() || "",
      });
    }
  }

  return entries;
}

export async function loadCorpCodes(apiKey?: string): Promise<CorpCodeCache> {
  if (cache && Date.now() - cache.updatedAt < TTL_MS) {
    return cache;
  }

  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const key = resolveApiKey(apiKey);
      const buffer = await getBinary("corpCode", {}, key);
      const uint8 = new Uint8Array(buffer);

      // Check if response is actually JSON (API error) instead of ZIP
      // ZIP files start with PK (0x50, 0x4B)
      if (uint8[0] !== 0x50 || uint8[1] !== 0x4B) {
        const text = new TextDecoder("utf-8").decode(uint8);
        let errorMsg = "corpCode API did not return a ZIP file.";
        try {
          const json = JSON.parse(text);
          errorMsg = `corpCode API error: ${json.message || json.status || text.slice(0, 200)}`;
        } catch {
          errorMsg = `corpCode API returned unexpected data: ${text.slice(0, 200)}`;
        }
        // Set cache with 0 entries but include error info in xmlPreview
        cache = {
          entries: [],
          byCorpCode: new Map(),
          byStockCode: new Map(),
          updatedAt: 0, // force retry on next call
          xmlPreview: errorMsg,
        };
        return cache;
      }

      const unzipped = unzipSync(uint8);
      const fileNames = Object.keys(unzipped);
      const xmlFileName = fileNames.find((f) => f.toLowerCase().endsWith(".xml")) || fileNames[0];

      if (!xmlFileName || !unzipped[xmlFileName]) {
        cache = {
          entries: [],
          byCorpCode: new Map(),
          byStockCode: new Map(),
          updatedAt: 0,
          xmlPreview: `ZIP contains no XML. Files: ${fileNames.join(", ")}`,
        };
        return cache;
      }

      const rawBytes = unzipped[xmlFileName];

      // Detect encoding from XML declaration
      const asciiPreview = new TextDecoder("ascii").decode(rawBytes.slice(0, 200));
      const encMatch = asciiPreview.match(/encoding=["']([^"']+)["']/i);
      const detectedEnc = encMatch?.[1].toLowerCase() ?? "";
      const decoder = new TextDecoder(
        detectedEnc === "euc-kr" || detectedEnc === "cp949" ? "euc-kr" : "utf-8"
      );
      const xml = decoder.decode(rawBytes);

      const xmlPreview = `[enc=${detectedEnc || "utf-8"}, file=${xmlFileName}, bytes=${rawBytes.length}] ${xml.slice(0, 500)}`;

      const entries = parseCorpCodeXml(xml);
      const byCorpCode = new Map<string, CorpCodeEntry>();
      const byStockCode = new Map<string, CorpCodeEntry>();

      for (const entry of entries) {
        byCorpCode.set(entry.corp_code, entry);
        if (entry.stock_code) {
          byStockCode.set(entry.stock_code, entry);
        }
      }

      cache = { entries, byCorpCode, byStockCode, updatedAt: Date.now(), xmlPreview };
      return cache;
    } catch (err) {
      // On error, set cache with error info but allow retry (updatedAt = 0)
      cache = {
        entries: [],
        byCorpCode: new Map(),
        byStockCode: new Map(),
        updatedAt: 0,
        xmlPreview: `Load error: ${err instanceof Error ? err.message : String(err)}`,
      };
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
  xmlPreview: string;
} {
  if (!cache) return { loaded: false, entryCount: 0, sampleNames: [], xmlPreview: "not loaded" };
  return {
    loaded: true,
    entryCount: cache.entries.length,
    sampleNames: cache.entries.slice(0, 5).map((e) => e.corp_name),
    xmlPreview: cache.xmlPreview,
  };
}
