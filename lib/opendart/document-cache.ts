import { getBinary } from "./client";
import { OpenDartError } from "./errors";
import { unzipMainXml, NotZipError } from "./zip";
import { parseDocument, type ParsedDocument } from "./document-parser";

/**
 * Timeout budget for document.xml.
 *
 * Vercel kills the function at 60s (vercel.json). Filings run to several MB, so
 * two attempts at 25s plus the 1s backoff (~51s) leaves room to unzip and parse.
 * The client defaults (55s x 4 attempts) would blow past the limit and the user
 * would see the function killed instead of a real error message.
 */
const DOC_TIMEOUT = 25000;
const DOC_RETRIES = 1;

const CACHE_TTL_MS = 10 * 60 * 1000;
/** Documents are multi-MB; keep only a few resident. */
const CACHE_MAX_ENTRIES = 3;

interface CacheEntry {
  doc: ParsedDocument;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(rceptNo: string): ParsedDocument | null {
  const entry = cache.get(rceptNo);
  if (!entry) return null;

  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(rceptNo);
    return null;
  }

  // Refresh LRU position
  cache.delete(rceptNo);
  cache.set(rceptNo, entry);
  return entry.doc;
}

function setCached(rceptNo: string, doc: ParsedDocument): void {
  cache.set(rceptNo, { doc, fetchedAt: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** OpenDART signals failure with an XML error body instead of a ZIP. */
function throwFromErrorBody(preview: string): never {
  const status = preview.match(/<status>\s*([^<\s]+)\s*</i)?.[1];
  if (status) throw new OpenDartError(status, "document");
  throw new Error(
    `[OpenDART] Unexpected non-ZIP response from document endpoint / 예상치 못한 응답: ${preview.slice(0, 200)}`
  );
}

/**
 * Fetch, unzip, and parse a disclosure document. Cached in memory so a toc
 * lookup followed by section reads costs one download.
 */
export async function fetchDocument(rceptNo: string, apiKey: string): Promise<ParsedDocument> {
  const cached = getCached(rceptNo);
  if (cached) return cached;

  const buffer = await getBinary("document", { rcept_no: rceptNo }, apiKey, {
    timeout: DOC_TIMEOUT,
    retries: DOC_RETRIES,
  });

  let xml: string;
  try {
    xml = (await unzipMainXml(buffer)).text;
  } catch (err) {
    if (err instanceof NotZipError) throwFromErrorBody(err.preview);
    throw err;
  }

  const doc = parseDocument(xml);
  setCached(rceptNo, doc);
  return doc;
}
