/**
 * What kind of `tandem` entry is in Claude Code's user config (#2358 PR 2b).
 *
 * One classifier for the two places that must agree: the boot sweep's
 * HTTP→bridge migration (`server/integrations/apply.ts`), which rewrites only
 * the exact direct-HTTP shape Tandem wrote, and `tandem doctor`, which tells
 * the user whether the next start will switch their entry. A doctor rule looser
 * than the migration's would promise a switch that never comes (a hand-added
 * header, a `localhost` URL, a moved port) — so both read this file.
 *
 * Dependency-free, string-only: no filesystem call, so it is safe on a value
 * read straight out of a config file.
 */

import { VALID_TOKEN_RE } from "../cli-runtime.js";
import { isValidNodeBinary } from "./node-binary-name.js";
import { isCanonicalNpxStdioArgs } from "./npx-entry-spec.js";

/**
 * Is this recorded script one of OUR stdio-bridge paths? Matched on the
 * trailing segments, separator-agnostic: a recorded path is by construction
 * a different location from the current one (an old install prefix, a
 * pre-update `.app`, the AppImage's app-data copy).
 */
export function isOwnStdioBridgeScript(recorded: string): boolean {
  return /[/\\]dist[/\\]stdio-bridge[/\\]index\.js$/.test(recorded);
}

/** Tandem tokens are 32+ URL-safe characters; nothing it mints is near this. A
 *  bound keeps a pathological value out of an environment block (32,767 chars
 *  on Windows). */
const MAX_TOKEN_LENGTH = 512;

export type ClaudeCodeTandemEntryShape =
  /** Exactly `{type: "http", url: "<base>/mcp", headers?: {Authorization: "Bearer <token>"}}`. */
  | { kind: "tandem-http"; token: string | undefined }
  /** An absolute Node running one of Tandem's bridge scripts, with only Tandem's env keys. */
  | { kind: "bridge"; command: string; script: string }
  /** `npx -y tandem-editor[@v] mcp-stdio` — Tandem's own, also a bridge. */
  | { kind: "npx-bridge" }
  /** Anything else: Tandem did not write it and leaves it alone. */
  | { kind: "other" };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The env keys a Tandem-written stdio `tandem` entry carries — the complete
 * set. `buildMcpEntries` WRITES exactly these; everything that asks "did Tandem
 * write this?" (the npx convergence gate, the `bridge` arm below, so the
 * migration, the repair, `keepWorkingClaudeCodeBridge` and the doctor) refuses
 * an entry carrying anything else. `tests/shared/npx-entry-spec.test.ts` pins
 * the writer's output against it.
 */
export const STDIO_ENTRY_ENV_KEYS = { url: "TANDEM_URL", token: "TANDEM_AUTH_TOKEN" } as const;

const STDIO_ENTRY_ENV_KEY_SET: ReadonlySet<string> = new Set(Object.values(STDIO_ENTRY_ENV_KEYS));

/** Is `env` absent, or a plain object holding only {@link STDIO_ENTRY_ENV_KEYS}? */
export function hasOnlyTandemEnvKeys(env: unknown): boolean {
  if (env === undefined) return true;
  if (!isPlainObject(env)) return false;
  return Object.keys(env).every((key) => STDIO_ENTRY_ENV_KEY_SET.has(key));
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** `Bearer <token>` with a token the bridge itself would send, or null. */
export function bearerTokenOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length);
  return token.length <= MAX_TOKEN_LENGTH && VALID_TOKEN_RE.test(token) ? token : null;
}

/**
 * Classify a `mcpServers.tandem` value. `mcpBaseUrl` is the URL Tandem writes
 * (`http://127.0.0.1:<default port>`), without `/mcp`.
 */
export function classifyClaudeCodeTandemEntry(
  entry: unknown,
  mcpBaseUrl: string,
): ClaudeCodeTandemEntryShape {
  if (!isPlainObject(entry)) return { kind: "other" };

  if ("command" in entry) {
    const { command, args } = entry;
    if (typeof command !== "string") return { kind: "other" };
    if (command === "npx" && isCanonicalNpxStdioArgs(args)) return { kind: "npx-bridge" };
    if (
      isAbsolutePath(command) &&
      isValidNodeBinary(command) &&
      Array.isArray(args) &&
      args.length === 1 &&
      typeof args[0] === "string" &&
      isOwnStdioBridgeScript(args[0]) &&
      hasOnlyTandemEnvKeys(entry.env)
    ) {
      return { kind: "bridge", command, script: args[0] };
    }
    return { kind: "other" };
  }

  for (const key of Object.keys(entry)) {
    if (key !== "type" && key !== "url" && key !== "headers") return { kind: "other" };
  }
  if (entry.type !== "http" || entry.url !== `${mcpBaseUrl}/mcp`) return { kind: "other" };
  if (!("headers" in entry)) return { kind: "tandem-http", token: undefined };
  const headers = entry.headers;
  if (!isPlainObject(headers)) return { kind: "other" };
  const keys = Object.keys(headers);
  if (keys.length !== 1 || keys[0] !== "Authorization") return { kind: "other" };
  const token = bearerTokenOf(headers.Authorization);
  return token === null ? { kind: "other" } : { kind: "tandem-http", token };
}
