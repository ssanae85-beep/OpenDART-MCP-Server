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
}

/** ZIP local file header magic bytes ("PK\x03\x04") */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * Decode bytes using the encoding declared in the XML prolog.
 * OpenDART documents are usually EUC-KR; corpCode.xml is UTF-8.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const asciiPreview = new TextDecoder("ascii").decode(bytes.slice(0, 200));
  const encMatch = asciiPreview.match(/encoding=["']([^"']+)["']/i);
  const declared = encMatch?.[1].toLowerCase() ?? "utf-8";
  const label = declared === "euc-kr" || declared === "cp949" || declared === "ks_c_5601-1987"
    ? "euc-kr"
    : "utf-8";
  return new TextDecoder(label).decode(bytes);
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

  return targets.map((name) => ({
    name,
    text: decodeXmlBytes(unzipped[name]),
  }));
}

/** Unzip and return only the primary (largest) XML entry. */
export async function unzipMainXml(buffer: ArrayBuffer): Promise<ExtractedFile> {
  const files = await unzipXmlFiles(buffer);
  if (files.length === 0) {
    throw new Error("ZIP archive contained no files");
  }
  return files.reduce((biggest, f) => (f.text.length > biggest.text.length ? f : biggest));
}
