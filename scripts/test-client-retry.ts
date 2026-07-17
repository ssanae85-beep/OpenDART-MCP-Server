/**
 * Retry/error-classification checks for the OpenDART client.
 * fetch is stubbed — no network, no API key.
 *
 * Usage: npm run test:client
 */
import { getBinary } from "../lib/opendart/client";
import { OpenDartNetworkError } from "../lib/opendart/errors";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

const realFetch = globalThis.fetch;
function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = (async () => impl()) as typeof realFetch;
}

async function capture(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

async function main() {
  console.log("=== timeout is classified as a timeout ===");
  // AbortSignal.timeout() raises TimeoutError. Matching only AbortError left the
  // raw DOMException to surface: "DOMException [TimeoutError]: The operation was
  // aborted due to timeout", with none of the retry context.
  let calls = 0;
  const retryLog: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
  stubFetch(async () => {
    calls++;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  const timeoutErr = await capture(() =>
    getBinary("corpCode", {}, "k", {
      timeout: 10,
      retries: 2,
      onRetry: ({ attempt, maxAttempts, delayMs }) => retryLog.push({ attempt, maxAttempts, delayMs }),
    })
  );

  check("is an OpenDartNetworkError", timeoutErr instanceof OpenDartNetworkError, true);
  check("typed as timeout", (timeoutErr as OpenDartNetworkError).type, "timeout");
  check("message stays actionable", timeoutErr.message.includes("요청 시간 초과"), true);
  check("names the endpoint", timeoutErr.message.includes("corpCode"), true);
  check("attempted 1 + 2 retries", calls, 3);
  check("reports the final attempt count", timeoutErr.message.includes("3/3"), true);

  console.log("\n=== retries are observable ===");
  check("onRetry fired once per backoff", retryLog.length, 2);
  check("attempt numbers", retryLog.map((r) => r.attempt), [1, 2]);
  check("max attempts reported", retryLog[0].maxAttempts, 3);
  check("backoff grows", retryLog.map((r) => r.delayMs), [1000, 2000]);

  console.log("\n=== AbortError still classified (manual abort) ===");
  stubFetch(async () => {
    throw new DOMException("aborted", "AbortError");
  });
  const abortErr = await capture(() => getBinary("corpCode", {}, "k", { timeout: 10, retries: 0 }));
  check("typed as timeout", (abortErr as OpenDartNetworkError).type, "timeout");

  console.log("\n=== network failure ===");
  stubFetch(async () => {
    throw new TypeError("fetch failed");
  });
  const netErr = await capture(() => getBinary("corpCode", {}, "k", { timeout: 10, retries: 0 }));
  check("typed as network", (netErr as OpenDartNetworkError).type, "network");

  console.log("\n=== 5xx retries, then gives up ===");
  calls = 0;
  stubFetch(async () => {
    calls++;
    return new Response("boom", { status: 503 });
  });
  const httpErr = await capture(() => getBinary("corpCode", {}, "k", { timeout: 10, retries: 2 }));
  check("retried on 503", calls, 3);
  check("surfaces an http error", httpErr.message.includes("503"), true);

  console.log("\n=== succeeds on a later attempt ===");
  calls = 0;
  stubFetch(async () => {
    calls++;
    if (calls < 3) throw new DOMException("timeout", "TimeoutError");
    return new Response(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, { status: 200 });
  });
  const buf = await getBinary("corpCode", {}, "k", { timeout: 10, retries: 3 });
  check("recovered without throwing", buf.byteLength, 3);
  check("stopped once it worked", calls, 3);

  console.log("\n=== retries beyond the backoff table don't break ===");
  calls = 0;
  stubFetch(async () => {
    calls++;
    throw new DOMException("timeout", "TimeoutError");
  });
  const delays: number[] = [];
  await capture(() =>
    getBinary("corpCode", {}, "k", {
      timeout: 10,
      retries: 5,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    })
  );
  check("all attempts made", calls, 6);
  check("delay never undefined", delays.every((d) => typeof d === "number" && d > 0), true);
  check("caps at the last backoff", delays, [1000, 2000, 4000, 4000, 4000]);

  globalThis.fetch = realFetch;
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CRASH:", err);
  process.exit(1);
});
