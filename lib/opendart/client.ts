import { checkResponse } from "./errors";

const BASE_URL = "https://opendart.fss.or.kr/api";
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 3000];

let sessionApiKey: string | undefined;

export function setSessionApiKey(key: string): void {
  sessionApiKey = key;
}

export function getSessionApiKey(): string | undefined {
  return sessionApiKey;
}

export function resolveApiKey(toolParamKey?: string): string {
  const key = toolParamKey || sessionApiKey || process.env.OPENDART_API_KEY;
  if (!key) {
    throw new Error(
      "[OpenDART] API key required. Get one at https://opendart.fss.or.kr/ and call set_api_key tool first. / " +
      "API 키가 필요합니다. https://opendart.fss.or.kr/ 에서 발급 후 set_api_key 도구를 먼저 호출하세요."
    );
  }
  return key;
}

async function fetchWithRetry(
  url: string,
  retries: number = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  throw lastError || new Error("Request failed after retries");
}

export async function getJson(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string
): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE_URL}/${endpoint}.json`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const response = await fetchWithRetry(url.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from OpenDART API (${endpoint})`);
  }

  const data = await response.json() as { status: string; message: string; [key: string]: unknown };
  checkResponse(data, endpoint);
  return data;
}

export async function getBinary(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string
): Promise<ArrayBuffer> {
  const url = new URL(`${BASE_URL}/${endpoint}.xml`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const response = await fetchWithRetry(url.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from OpenDART API (${endpoint})`);
  }

  return response.arrayBuffer();
}
