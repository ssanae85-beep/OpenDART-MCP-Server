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

  // Write JSON
  const outputPath = join(process.cwd(), "data", "corp-codes.json");
  writeFileSync(outputPath, JSON.stringify(entries));
  const fileSize = (Buffer.byteLength(JSON.stringify(entries)) / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${outputPath} (${fileSize}MB)`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
