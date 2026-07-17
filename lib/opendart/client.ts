import { checkResponse, OpenDartNetworkError } from "./errors";

const BASE_URL = "https://opendart.fss.or.kr/api";
const DEFAULT_TIMEOUT = 30000;
const BINARY_TIMEOUT = 55000;
const DEFAULT_RETRIES = 2;
const BINARY_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

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

interface FetchOptions {
  timeout?: number;
  retries?: number;
  endpoint?: string;
  /** Called before each backoff. Retries are otherwise silent, which makes an
   *  unattended run that dies after several attempts impossible to diagnose. */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: Error }) => void;
}

async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, endpoint = "unknown", onRetry } = options;
  let lastError: Error | null = null;

  const backoff = async (attempt: number, error: Error) => {
    const delayMs = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    onRetry?.({ attempt: attempt + 1, maxAttempts: retries + 1, delayMs, error });
    await new Promise((r) => setTimeout(r, delayMs));
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (response.status === 429 || response.status >= 500) {
        lastError = new OpenDartNetworkError("http", endpoint, attempt + 1, retries + 1, response.status);
        if (attempt < retries) {
          await backoff(attempt, lastError);
          continue;
        }
      }
      return response;
    } catch (err) {
      // AbortSignal.timeout() raises TimeoutError, not AbortError. Matching only
      // AbortError left every timeout falling through as a bare DOMException,
      // losing the retry hint the message is supposed to carry.
      if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
        lastError = new OpenDartNetworkError("timeout", endpoint, attempt + 1, retries + 1);
      } else if (err instanceof TypeError) {
        lastError = new OpenDartNetworkError("network", endpoint, attempt + 1, retries + 1);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < retries) {
        await backoff(attempt, lastError);
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

  const response = await fetchWithRetry(url.toString(), {
    timeout: DEFAULT_TIMEOUT,
    retries: DEFAULT_RETRIES,
    endpoint,
  });
  if (!response.ok) {
    throw new OpenDartNetworkError("http", endpoint, 1, 1, response.status);
  }

  const data = await response.json() as { status: string; message: string; [key: string]: unknown };
  checkResponse(data, endpoint);
  return data;
}

/**
 * Fetch a binary (ZIP) endpoint.
 *
 * The BINARY_TIMEOUT/BINARY_RETRIES defaults can exceed Vercel's 60s function
 * limit in the worst case, so callers running inside a request should pass a
 * budget that fits (see lib/tools/document.ts).
 */
export async function getBinary(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  options: { timeout?: number; retries?: number; onRetry?: FetchOptions["onRetry"] } = {}
): Promise<ArrayBuffer> {
  const url = new URL(`${BASE_URL}/${endpoint}.xml`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const response = await fetchWithRetry(url.toString(), {
    timeout: options.timeout ?? BINARY_TIMEOUT,
    retries: options.retries ?? BINARY_RETRIES,
    endpoint,
    onRetry: options.onRetry,
  });
  if (!response.ok) {
    throw new OpenDartNetworkError("http", endpoint, 1, 1, response.status);
  }

  return response.arrayBuffer();
}
