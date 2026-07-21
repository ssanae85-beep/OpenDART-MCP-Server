/**
 * Runtime input guards for MCP tools.
 *
 * The MCP SDK builds a non-strict ZodObject from each tool's inputSchema, which
 * silently strips keys the schema doesn't know before the handler runs. A
 * client that sent `rcept_name` instead of `rcept_no` got a normal-looking
 * response computed from the wrong (defaulted) arguments — the ambiguity that
 * sent a model into a token-repetition collapse. The only place to see the
 * original keys is before the SDK validates, so this runs at the low-level
 * CallToolRequest boundary (see lib/tools/index.ts).
 */

import { levenshtein } from "./korean-search";

/** Allowed parameter names per tool. Anything else is rejected, not ignored. */
export const TOOL_ALLOWED_PARAMS: Record<string, string[]> = {
  opendart_get_document: [
    "rcept_no", "mode", "section", "offset", "query", "attachment", "max_chars", "api_key",
  ],
};

/** Closest allowed key within edit distance 3, for "did you mean" hints. */
export function suggestKey(unknown: string, allowed: string[]): string | null {
  const u = unknown.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const key of allowed) {
    const d = levenshtein(u, key.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  // 3 covers rcept_name→rcept_no (2) and typical typos without matching noise.
  return best !== null && bestDist <= 3 ? best : null;
}

export interface UnknownParamError {
  unknownKeys: string[];
  message: string;
}

/**
 * Return an error describing any keys not in `allowed`, or null if all are known.
 * `allowed` unknown (no entry for the tool) means "don't guard" — returns null.
 */
export function checkParams(
  toolName: string,
  args: Record<string, unknown> | undefined,
  allowed: string[] | undefined,
): UnknownParamError | null {
  if (!allowed || !args) return null;

  const allowedSet = new Set(allowed);
  const unknownKeys = Object.keys(args).filter((k) => !allowedSet.has(k));
  if (unknownKeys.length === 0) return null;

  const parts = unknownKeys.map((k) => {
    const hint = suggestKey(k, allowed);
    return hint ? `'${k}' (did you mean '${hint}'?)` : `'${k}'`;
  });

  const label = unknownKeys.length === 1 ? "parameter" : "parameters";
  const message =
    `Unknown ${label} for ${toolName}: ${parts.join(", ")}. ` +
    `Allowed: ${allowed.join(", ")}. ` +
    `알 수 없는 파라미터입니다 — 위 허용 목록의 키만 사용하세요.`;

  return { unknownKeys, message };
}
