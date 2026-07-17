/**
 * Corp code updater script
 * Downloads the full corporate registry from OpenDART API and saves as JSON.
 *
 * Usage:
 *   OPENDART_API_KEY=your_key npx tsx scripts/update-corp-codes.ts
 *
 * Or set OPENDART_API_KEY in .env file first.
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { XMLParser } from "fast-xml-parser";
import { unzipMainXml, NotZipError } from "../lib/opendart/zip";

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
  console.error("Error: OPENDART_API_KEY environment variable is required.");
  console.error("Usage: OPENDART_API_KEY=your_key npx tsx scripts/update-corp-codes.ts");
  process.exit(1);
}

interface Entry {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  modify_date: string;
}

/** Floors, not targets: real counts are ~118k total / ~3.9k listed. */
const MIN_ENTRIES = 50_000;
const MIN_LISTED = 2_000;
/** A shrink this large means a bad response, not a delisting wave. */
const MAX_SHRINK = 0.1;

/**
 * Refuse to write data that looks wrong.
 *
 * The leading-zero corruption sat in this file undetected until a user hit it.
 * Unattended runs make that failure mode cheaper to repeat, so the bad data has
 * to be rejected before it lands rather than after someone notices.
 */
function validate(entries: Entry[], listedCount: number, outputPath: string): void {
  const problems: string[] = [];

  if (entries.length < MIN_ENTRIES) {
    problems.push(`only ${entries.length} companies parsed (expected >= ${MIN_ENTRIES})`);
  }
  if (listedCount < MIN_LISTED) {
    problems.push(`only ${listedCount} listed companies (expected >= ${MIN_LISTED})`);
  }

  const badCorp = entries.filter((e) => !/^\d{8}$/.test(e.corp_code));
  if (badCorp.length > 0) {
    problems.push(
      `${badCorp.length} malformed corp_code, e.g. ${badCorp.slice(0, 3).map((e) => `${e.corp_name}="${e.corp_code}"`).join(", ")}`
    );
  }

  // Six characters, not six digits: SPACs and REITs carry a letter (0068Y0,
  // 0115H0). Requiring digits here would reject 53 real listings.
  const badStock = entries.filter((e) => e.stock_code !== "" && !/^[0-9A-Z]{6}$/.test(e.stock_code));
  if (badStock.length > 0) {
    problems.push(
      `${badStock.length} malformed stock_code — leading zeros lost? e.g. ${badStock.slice(0, 3).map((e) => `${e.corp_name}="${e.stock_code}"`).join(", ")}`
    );
  }

  // Listed codes starting with 0 are the canary: 005930 etc. exist in reality
  const zeroLeading = entries.filter((e) => e.stock_code.startsWith("0")).length;
  if (listedCount >= MIN_LISTED && zeroLeading === 0) {
    problems.push("no stock_code starts with 0 — leading zeros were almost certainly stripped");
  }

  if (existsSync(outputPath)) {
    try {
      const prev = JSON.parse(readFileSync(outputPath, "utf-8")) as Entry[];
      if (prev.length > 0 && entries.length < prev.length * (1 - MAX_SHRINK)) {
        problems.push(
          `company count dropped from ${prev.length} to ${entries.length} (>${MAX_SHRINK * 100}%)`
        );
      }
    } catch {
      // An unreadable existing file is not a reason to reject fresh data
    }
  }

  if (problems.length > 0) {
    console.error("\nValidation failed — data NOT written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`  Validation OK (${zeroLeading} codes start with 0)`);
}

async function main() {
  console.log("Downloading corp code ZIP from OpenDART...");

  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${API_KEY}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });

  if (!response.ok) {
    console.error(`HTTP error: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const buffer = await response.arrayBuffer();
  console.log(`Downloaded ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB ZIP`);

  // Unzip + decode via the shared helper (also used by the document.xml tool)
  let extracted;
  try {
    extracted = await unzipMainXml(buffer);
  } catch (err) {
    if (err instanceof NotZipError) {
      console.error("Response is not a ZIP file:", err.preview);
      process.exit(1);
    }
    throw err;
  }

  const xml = extracted.text;
  console.log(`Extracted ${extracted.name} (${(xml.length / 1024 / 1024).toFixed(1)}M chars)`);

  // Parse XML with fast-xml-parser
  // parseTagValue:false is load-bearing. Left on (the default), fast-xml-parser
  // reads <stock_code>005930</stock_code> as the number 5930 and the leading
  // zeros are gone before we ever see the value — 55% of listed companies.
  // Every field here is an identifier, not a quantity: keep them as strings.
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: false,
    isArray: (name) => name === "list",
  });
  const parsed = parser.parse(xml);

  // Extract entries - handle both result.list and direct list
  const rawList = parsed?.result?.list || parsed?.list || [];
  const entries = rawList
    .map((item: Record<string, unknown>) => ({
      corp_code: String(item.corp_code || "").trim().padStart(8, "0"),
      corp_name: String(item.corp_name || "").trim(),
      stock_code: String(item.stock_code || "").trim() || "",
      modify_date: String(item.modify_date || "").trim(),
    }))
    .filter((e: { corp_name: string }) => e.corp_name.length > 0);

  console.log(`Parsed ${entries.length} companies`);

  const listedCount = entries.filter((e: { stock_code: string }) => e.stock_code).length;
  console.log(`  Listed (with stock code): ${listedCount}`);
  console.log(`  Unlisted: ${entries.length - listedCount}`);

  // Sample entries
  const samples = entries.slice(0, 5);
  console.log(`  Samples: ${samples.map((e: { corp_name: string }) => e.corp_name).join(", ")}`);

  const outputPath = join(process.cwd(), "data", "corp-codes.json");
  validate(entries, listedCount, outputPath);

  writeFileSync(outputPath, JSON.stringify(entries));
  const fileSize = (Buffer.byteLength(JSON.stringify(entries)) / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${outputPath} (${fileSize}MB)`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
