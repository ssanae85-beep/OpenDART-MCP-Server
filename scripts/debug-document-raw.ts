/**
 * Dump the raw XML of a filing (and one section of it) for inspection.
 *
 * The API key is read from .env and is never printed or written to the dump.
 *
 * Usage:
 *   npm run debug:document -- <rcept_no> [section keyword]
 *   npm run debug:document -- 20260310002820 "충당부채"
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { unzipXmlFiles } from "../lib/opendart/zip";
import { parseDocument, findSection } from "../lib/opendart/document-parser";

// Load .env if present
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const API_KEY = process.env.OPENDART_API_KEY;
if (!API_KEY) {
  console.error("Error: OPENDART_API_KEY is required.");
  console.error("Create a .env file in the project root containing:");
  console.error("  OPENDART_API_KEY=your_key_here");
  process.exit(1);
}

const rceptNo = process.argv[2];
const sectionQuery = process.argv[3];

if (!rceptNo || !/^\d{14}$/.test(rceptNo)) {
  console.error("Error: pass a 14-digit rcept_no.");
  console.error('Usage: npm run debug:document -- 20260310002820 "충당부채"');
  process.exit(1);
}

/** Count tag frequency so unfamiliar element names stand out. */
function tagHistogram(xml: string, topN = 40): Array<[string, number]> {
  const counts = new Map<string, number>();
  const re = /<([A-Za-z][A-Za-z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = m[1].toUpperCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
}

/** Collect distinct attribute names seen on a given element. */
function attrsOf(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const attrs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrRe = /([A-Za-z][A-Za-z0-9:_-]*)\s*=/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1])) !== null) attrs.add(a[1]);
  }
  return [...attrs].sort();
}

async function main() {
  const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${API_KEY}&rcept_no=${rceptNo}`;
  console.log(`Downloading document ${rceptNo} ...`);

  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) {
    console.error(`HTTP error: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const buffer = await response.arrayBuffer();
  console.log(`Downloaded ${(buffer.byteLength / 1024 / 1024).toFixed(2)}MB`);

  const files = await unzipXmlFiles(buffer);
  console.log(`\nZIP contains ${files.length} file(s):`);
  for (const f of files) {
    console.log(`  - ${f.name} (${(f.text.length / 1024 / 1024).toFixed(2)}M chars)`);
  }

  const outDir = join(process.cwd(), ".debug");
  mkdirSync(outDir, { recursive: true });

  for (const f of files) {
    const safe = f.name.replace(/[^\w.-]/g, "_");
    const path = join(outDir, `${rceptNo}-${safe}`);
    writeFileSync(path, f.text, "utf-8");
    console.log(`  wrote ${path}`);
  }

  const main = files.reduce((b, f) => (f.text.length > b.text.length ? f : b));
  const doc = parseDocument(main.text);

  console.log(`\n=== DOCUMENT ===`);
  console.log(`name: ${doc.docName} / company: ${doc.companyName}`);
  console.log(`sections: ${doc.sections.length}`);

  console.log(`\n=== TOC ===`);
  for (const s of doc.sections) {
    console.log(`${"  ".repeat(s.depth)}${s.index}. ${s.title}  [${s.end - s.start} chars]`);
  }

  console.log(`\n=== TAG HISTOGRAM (whole document) ===`);
  for (const [tag, n] of tagHistogram(main.text)) console.log(`  ${String(n).padStart(7)}  ${tag}`);

  if (!sectionQuery) {
    console.log(`\n(pass a section keyword as the 2nd arg to dump one section's raw XML)`);
    return;
  }

  const target = findSection(doc, sectionQuery);
  if (!target) {
    console.error(`\nSection not found: "${sectionQuery}"`);
    process.exit(1);
  }

  const rawSection = main.text.slice(target.titleStart, target.end);
  const sectionPath = join(outDir, `${rceptNo}-section-${target.index}.xml`);
  writeFileSync(sectionPath, rawSection, "utf-8");

  console.log(`\n=== SECTION ${target.index}: ${target.title} ===`);
  console.log(`raw length: ${rawSection.length} chars`);
  console.log(`wrote ${sectionPath}`);

  console.log(`\n--- tag histogram (section) ---`);
  for (const [tag, n] of tagHistogram(rawSection)) console.log(`  ${String(n).padStart(6)}  ${tag}`);

  for (const tag of ["TABLE", "TR", "TD", "TH", "TE", "SPAN", "P"]) {
    const attrs = attrsOf(rawSection, tag);
    if (attrs.length) console.log(`  <${tag}> attrs: ${attrs.join(", ")}`);
  }

  console.log(`\n--- first 4000 chars of raw section ---`);
  console.log(rawSection.slice(0, 4000));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
