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

/**
 * Allowed parameter names per tool, derived from each tool's registered Zod
 * schema — never hand-maintained. Deriving from the schema the SDK actually
 * validates against means the allowlist can't drift from it, can't carry a typo
 * of its own, and covers new tools automatically. Populated by buildAllowlist()
 * after all tools are registered.
 */
export type ToolAllowlist = Record<string, string[]>;

/** Minimal shape of the SDK's internal tool registry entry. */
interface RegisteredToolLike {
  inputSchema?: { shape?: Record<string, unknown> };
}

/**
 * Read the allowed parameter names for every registered tool straight from its
 * Zod schema shape. A tool with no inputSchema (no parameters) maps to [].
 */
export function buildAllowlist(
  registeredTools: Record<string, RegisteredToolLike>,
): ToolAllowlist {
  const allowlist: ToolAllowlist = {};
  for (const [name, tool] of Object.entries(registeredTools)) {
    const shape = tool.inputSchema?.shape;
    allowlist[name] = shape ? Object.keys(shape) : [];
  }
  return allowlist;
}

/** Split a key into lowercase word tokens: "business_year" → ["business","year"]. */
function tokens(key: string): string[] {
  return key
    .toLowerCase()
    .split(/[_\s]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean);
}

/**
 * Two keys share a distinctive token if a word in one is a prefix of, or equal
 * to, a word in the other (min length 3 to avoid noise). This catches
 * abbreviations Levenshtein misses — business_year ↔ bsns_year both own "year",
 * report_code ↔ reprt_code both own "code".
 */
function sharesToken(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  for (const x of ta) {
    for (const y of tb) {
      if (x.length < 3 || y.length < 3) continue;
      if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}

/**
 * Closest allowed key, for "did you mean" hints. Accepts a match when it's
 * within edit distance 3 (typos), or shares a distinctive token (abbreviations
 * like business_year→bsns_year that edit distance alone would miss).
 */
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
  if (best === null) return null;
  if (bestDist <= 3) return best;
  return sharesToken(unknown, best) ? best : null;
}

export interface UnknownParamError {
  unknownKeys: string[];
  message: string;
}

/**
 * Return an error describing any keys not in `allowed`, or null if all are known.
 *
 * `allowed === undefined` means the tool isn't in the allowlist at all (e.g. an
 * unknown tool name) — don't guard, return null. An empty array is different: it
 * means a tool that takes no parameters, so any key is unknown and rejected.
 */
export function checkParams(
  toolName: string,
  args: Record<string, unknown> | undefined,
  allowed: string[] | undefined,
): UnknownParamError | null {
  if (allowed === undefined || !args) return null;

  const allowedSet = new Set(allowed);
  const unknownKeys = Object.keys(args).filter((k) => !allowedSet.has(k));
  if (unknownKeys.length === 0) return null;

  const parts = unknownKeys.map((k) => {
    const hint = suggestKey(k, allowed);
    return hint ? `'${k}' (did you mean '${hint}'?)` : `'${k}'`;
  });

  const label = unknownKeys.length === 1 ? "parameter" : "parameters";
  const allowedText = allowed.length > 0
    ? `Allowed: ${allowed.join(", ")}.`
    : `This tool takes no parameters.`;
  const message =
    `Unknown ${label} for ${toolName}: ${parts.join(", ")}. ${allowedText} ` +
    `알 수 없는 파라미터입니다 — 허용된 키만 사용하세요.`;

  return { unknownKeys, message };
}
