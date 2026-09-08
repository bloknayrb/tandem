import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Static reads of the `/api` registration surface — the `/api` twin of
 * `tests/helpers/mcp-source.ts`.
 *
 * Kept as a helper rather than inlined so the registrar list is one binding.
 * A suite that hard-codes four of the five files is not wrong on the day it is
 * written; it is wrong the first time a registrar is added, and silently.
 */

const SERVER_DIR = join(import.meta.dirname, "..", "..", "src", "server");

/**
 * Every module that registers `/api` routes on the Express app.
 *
 * Derived by hand and pinned by {@link unlistedRegistrars}, which sweeps
 * `src/server` for `app.<method>(` and returns any file outside this list that
 * has one. Hand-listing plus a sweep, rather than a bare sweep, so the list is
 * readable AND cannot go short.
 */
export const API_REGISTRARS = [
  "mcp/api-routes.ts",
  "mcp/channel-routes.ts",
  "integrations/api-routes.ts",
  "launcher/api-routes.ts",
  "models/api-routes.ts",
] as const;

export function readRegistrar(rel: string): string {
  return readFileSync(join(SERVER_DIR, rel), "utf-8");
}

/** HTTP methods that can change server state. `get`/`head`/`options` cannot. */
const MUTATING_METHODS = "post|put|patch|delete";

/**
 * `app.post(\n    API_FOO,` matches as well as the one-line form — several
 * registrations wrap because of their middleware chain, and a `[^\s]` anchor
 * would skip exactly those (the longest chains, which are the gated ones).
 */
const REGISTRATION = new RegExp(
  String.raw`\bapp\.(?:${MUTATING_METHODS})\(\s*([A-Za-z_][A-Za-z0-9_]*)`,
  "g",
);

export type Registration = {
  /** The route-path constant's identifier, e.g. `API_SCRATCHPAD`. */
  constant: string;
  /** Registrar file, relative to `src/server`. */
  file: string;
  /** The full `app.method(...)` call text, parens balanced. */
  call: string;
};

/**
 * Slice the complete `app.method(...)` call starting at `openParenIdx`.
 *
 * Paren-balanced rather than "up to the next `);`" because two registrations
 * carry an inline object literal (`makeRotateTokenHandler({ ... })`) and one a
 * nested call, so a first-match scan truncates them — and a truncated call is
 * one that no longer contains its own `licenseGateMiddleware`, which would read
 * as "ungated" rather than as a parse failure.
 */
function balancedCall(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  throw new Error(`Unbalanced parens from index ${openParenIdx}`);
}

/**
 * Files under `src/server` that register a mutating route but are NOT in
 * {@link API_REGISTRARS} — i.e. a whole registrar the coverage table cannot see.
 *
 * This is the outer of the two nets. The inner one catches a new route in a
 * known registrar; without this one, a new *file* of routes is invisible to
 * both, and that is the cheaper mistake to make.
 */
export function unlistedRegistrars(): string[] {
  const known = new Set<string>(API_REGISTRARS);
  const found: string[] = [];
  const probe = new RegExp(String.raw`\bapp\.(?:${MUTATING_METHODS})\(`);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const rel = relative(SERVER_DIR, full).split(sep).join("/");
        if (!known.has(rel) && probe.test(readFileSync(full, "utf-8"))) found.push(rel);
      }
    }
  };
  walk(SERVER_DIR);
  return found.sort();
}

/** Every mutating `/api` route registration across {@link API_REGISTRARS}. */
export function mutatingRegistrations(): Registration[] {
  const out: Registration[] = [];
  for (const file of API_REGISTRARS) {
    const src = readRegistrar(file);
    for (const m of src.matchAll(REGISTRATION)) {
      const openParen = src.indexOf("(", m.index);
      out.push({ constant: m[1], file, call: balancedCall(src, openParen) });
    }
  }
  return out;
}
