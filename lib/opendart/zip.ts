/**
 * ZIP handling for OpenDART binary endpoints (corpCode.xml, document.xml).
 * Shared by the server runtime and scripts/update-corp-codes.ts.
 */

/** OpenDART returns a plain XML error body instead of a ZIP when a request fails. */
export class NotZipError extends Error {
  constructor(public preview: string) {
    super("Response is not a ZIP file");
    this.name = "NotZipError";
  }
}

export interface ExtractedFile {
  name: string;
  text: string;
  /** U+FFFD ratio after decoding; > GARBLE_THRESHOLD means text is unreliable */
  garbleRatio: number;
}

/** Filings this garbled after fallback can't be read as text; warn instead. */
export const UNREADABLE_THRESHOLD = 0.05;

/** ZIP local file header magic bytes ("PK\x03\x04") */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** U+FFFD (�) is what a decoder emits for bytes it can't map. */
const REPLACEMENT_CHAR = "�";

/** Share of characters that came out as U+FFFD — a proxy for wrong encoding. */
export function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let bad = 0;
  for (const ch of text) if (ch === REPLACEMENT_CHAR) bad++;
  return bad / text.length;
}

/** Above this, treat the decode as wrong and try the other encoding. */
const GARBLE_THRESHOLD = 0.05;

export interface DecodeResult {
  text: string;
  encoding: string;
  /** U+FFFD ratio after the best attempt; high means still unreadable */
  garbleRatio: number;
}

/**
 * Decode XML bytes, verifying the result rather than trusting the prolog.
 *
 * The declared encoding is only a hint: pre-2020 DART filings are EUC-KR and
 * some mislabel themselves or omit the declaration, so decoding by the label
 * alone returned a wall of � that both broke reading and bloated the context.
 * We decode, measure the U+FFFD ratio, and fall back to the other encoding when
 * the first attempt looks wrong — keeping whichever result is cleaner.
 */
export function decodeXmlChecked(bytes: Uint8Array): DecodeResult {
  const asciiPreview = new TextDecoder("ascii").decode(bytes.slice(0, 200));
  const encMatch = asciiPreview.match(/encoding=["']([^"']+)["']/i);
  const declared = encMatch?.[1].toLowerCase() ?? "utf-8";
  const declaredIsKorean =
    declared === "euc-kr" || declared === "cp949" || declared === "ks_c_5601-1987";

  const primary = declaredIsKorean ? "euc-kr" : "utf-8";
  const fallback = declaredIsKorean ? "utf-8" : "euc-kr";

  const decode = (label: string) => {
    // fatal:false so a bad byte yields U+FFFD instead of throwing — we want to
    // measure the damage, not abort.
    const text = new TextDecoder(label, { fatal: false }).decode(bytes);
    return { label, text, ratio: replacementRatio(text) };
  };

  const first = decode(primary);
  if (first.ratio <= GARBLE_THRESHOLD) {
    return { text: first.text, encoding: first.label, garbleRatio: first.ratio };
  }

  // Primary looked wrong — try the other encoding and keep the cleaner one.
  const second = decode(fallback);
  const best = second.ratio < first.ratio ? second : first;
  return { text: best.text, encoding: best.label, garbleRatio: best.ratio };
}

/**
 * Decode bytes, trusting the prolog's declared encoding with a checked fallback.
 * Kept for callers that only need the text (e.g. corpCode.xml).
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  return decodeXmlChecked(bytes).text;
}

/**
 * Unzip an OpenDART response and decode every XML entry inside.
 * Throws NotZipError with a text preview when the response is an error body.
 */
export async function unzipXmlFiles(buffer: ArrayBuffer): Promise<ExtractedFile[]> {
  const uint8 = new Uint8Array(buffer);

  if (!isZip(uint8)) {
    throw new NotZipError(new TextDecoder("utf-8").decode(uint8.slice(0, 500)));
  }

  const { unzipSync } = await import("fflate");
  const unzipped = unzipSync(uint8);

  const names = Object.keys(unzipped);
  const xmlNames = names.filter((n) => n.toLowerCase().endsWith(".xml"));
  const targets = xmlNames.length > 0 ? xmlNames : names;

  return targets.map((name) => {
    const decoded = decodeXmlChecked(unzipped[name]);
    return { name, text: decoded.text, garbleRatio: decoded.garbleRatio };
  });
}

/** Unzip and return only the primary (largest) XML entry. */
export async function unzipMainXml(buffer: ArrayBuffer): Promise<ExtractedFile> {
  const files = await unzipXmlFiles(buffer);
  if (files.length === 0) {
    throw new Error("ZIP archive contained no files");
  }
  return files.reduce((biggest, f) => (f.text.length > biggest.text.length ? f : biggest));
}
