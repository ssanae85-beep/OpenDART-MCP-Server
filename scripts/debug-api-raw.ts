/**
 * Dump a raw OpenDART JSON response so its actual fields can be inspected.
 *
 * The API key is read from .env and is never printed.
 *
 * Usage:
 *   npm run debug:api -- <endpoint> <key=value> [key=value ...]
 *   npm run debug:api -- fnlttSinglAcnt corp_code=00126380 bsns_year=2025 reprt_code=11014
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
  console.error("Error: OPENDART_API_KEY is required (.env).");
  process.exit(1);
}

const [endpoint, ...pairs] = process.argv.slice(2);
if (!endpoint) {
  console.error("Usage: npm run debug:api -- <endpoint> key=value ...");
  process.exit(1);
}

async function main() {
  const url = new URL(`https://opendart.fss.or.kr/api/${endpoint}.json`);
  url.searchParams.set("crtfc_key", API_KEY!);
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i > 0) url.searchParams.set(p.slice(0, i), p.slice(i + 1));
  }

  const shown = new URL(url.toString());
  shown.searchParams.set("crtfc_key", "***");
  console.log(`GET ${shown.toString()}\n`);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(60000) });
  const data = (await res.json()) as Record<string, unknown>;

  console.log(`status: ${data.status}  message: ${data.message}`);

  const list = data.list as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list) || list.length === 0) {
    console.log("(no list rows)");
    console.log(JSON.stringify(data, null, 2).slice(0, 1500));
    return;
  }

  console.log(`rows: ${list.length}\n`);

  const fields = [...new Set(list.flatMap((r) => Object.keys(r)))];
  console.log(`=== fields (${fields.length}) ===`);
  for (const f of fields) {
    const sample = list.find((r) => r[f] !== undefined && r[f] !== "")?.[f];
    const filled = list.filter((r) => r[f] !== undefined && r[f] !== "").length;
    console.log(`  ${f.padEnd(22)} filled ${String(filled).padStart(3)}/${list.length}  e.g. ${JSON.stringify(sample)}`);
  }

  console.log(`\n=== first row ===`);
  console.log(JSON.stringify(list[0], null, 2));
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
