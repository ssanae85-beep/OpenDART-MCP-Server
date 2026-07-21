import { getBinary } from "./client";
import { OpenDartError } from "./errors";
import { unzipXmlFiles, NotZipError } from "./zip";
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
/** Bundles are multi-MB; keep only a few resident. */
const CACHE_MAX_ENTRIES = 3;

/** One XML document inside a filing's ZIP: the filing itself or an attachment. */
export interface BundleEntry {
  /** 1-based; 1 is the main filing */
  index: number;
  fileName: string;
  /** <DOCUMENT-NAME>, e.g. "사업보고서" or "감사보고서" */
  docName: string;
  chars: number;
  raw: string;
  /** U+FFFD ratio from decoding; > UNREADABLE_THRESHOLD means text is unreliable */
  garbleRatio: number;
  /** Populated on first use — parsing every attachment up front wastes the time budget */
  parsed?: ParsedDocument;
}

export interface DocumentBundle {
  rceptNo: string;
  /** Main filing first, then attachments in archive order */
  entries: BundleEntry[];
}

interface CacheEntry {
  bundle: DocumentBundle;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(rceptNo: string): DocumentBundle | null {
  const entry = cache.get(rceptNo);
  if (!entry) return null;

  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(rceptNo);
    return null;
  }

  // Refresh LRU position
  cache.delete(rceptNo);
  cache.set(rceptNo, entry);
  return entry.bundle;
}

function setCached(rceptNo: string, bundle: DocumentBundle): void {
  cache.set(rceptNo, { bundle, fetchedAt: Date.now() });
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

function readDocName(xml: string): string {
  return xml.match(/<DOCUMENT-NAME[^>]*>([^<]*)/i)?.[1].trim() ?? "";
}

/** Parse on demand and memoize — callers only ever read one document per call. */
export function getParsed(entry: BundleEntry): ParsedDocument {
  entry.parsed ??= parseDocument(entry.raw);
  return entry.parsed;
}

/** Select a document by 1-based index or by name keyword (e.g. "감사보고서"). */
export function findEntry(bundle: DocumentBundle, query: string): BundleEntry | null {
  const q = query.trim();
  if (!q) return null;

  if (/^\d+$/.test(q)) {
    return bundle.entries.find((e) => e.index === parseInt(q, 10)) ?? null;
  }

  const norm = (s: string) => s.toLowerCase().replace(/\s/g, "");
  const nq = norm(q);

  return (
    bundle.entries.find((e) => norm(e.docName) === nq) ??
    bundle.entries.find((e) => norm(e.docName).includes(nq)) ??
    bundle.entries.find((e) => norm(e.fileName).includes(nq)) ??
    null
  );
}

/**
 * Fetch and unzip a filing. A filing's ZIP holds the report plus its
 * attachments (감사보고서 etc.), each a separate XML document.
 * Cached in memory so a toc lookup followed by section reads costs one download.
 */
export async function fetchDocumentBundle(
  rceptNo: string,
  apiKey: string
): Promise<DocumentBundle> {
  const cached = getCached(rceptNo);
  if (cached) return cached;

  const buffer = await getBinary("document", { rcept_no: rceptNo }, apiKey, {
    timeout: DOC_TIMEOUT,
    retries: DOC_RETRIES,
  });

  let files;
  try {
    files = await unzipXmlFiles(buffer);
  } catch (err) {
    if (err instanceof NotZipError) throwFromErrorBody(err.preview);
    throw err;
  }

  if (files.length === 0) {
    throw new Error("[OpenDART] ZIP archive contained no documents");
  }

  // The main filing is named after the receipt number; attachments get a suffix.
  // Fall back to the largest document when the naming doesn't match.
  const mainIdx = (() => {
    const byName = files.findIndex((f) => f.name.toLowerCase() === `${rceptNo}.xml`);
    if (byName !== -1) return byName;
    let biggest = 0;
    files.forEach((f, i) => {
      if (f.text.length > files[biggest].text.length) biggest = i;
    });
    return biggest;
  })();

  const ordered = [files[mainIdx], ...files.filter((_, i) => i !== mainIdx)];

  const bundle: DocumentBundle = {
    rceptNo,
    entries: ordered.map((f, i) => ({
      index: i + 1,
      fileName: f.name,
      docName: readDocName(f.text) || f.name,
      chars: f.text.length,
      raw: f.text,
      garbleRatio: f.garbleRatio,
    })),
  };

  setCached(rceptNo, bundle);
  return bundle;
}
