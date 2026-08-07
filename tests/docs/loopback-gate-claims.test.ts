import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the two documentation claims about `assertLoopbackForMutation` that
 * #1293 / PR #1322 invalidated, and that the first correction sweep missed.
 *
 * Two distinct defects, both doc-only, both of the "authoritative-sounding
 * prose that is now false" class:
 *
 *  1. **The staleness claim.** Before #1293 the gate rejected only under
 *     `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`, so ~10 sites described it as a
 *     no-op in the default configuration. It now rejects unconditionally.
 *     ADR-046 (`docs/decisions.md`) still carried the old wording *after* the
 *     first sweep, while this PR's own `docs/security.md` points the reader at
 *     ADR-046 as stating "the same posture" — two documents asserting opposite
 *     things, with the stale one sounding more authoritative. The historical
 *     note is allowed to survive, but only when it is explicitly tensed as
 *     history (mentions #1293).
 *
 *  2. **The ungated-set claim** — the load-bearing half. `CLAUDE.md` and
 *     `docs/security.md` enumerate which mutating routes call *no* gate, and
 *     Critical Rule 9 establishes that such enumerations are used in this repo
 *     as review inventories. An enumeration that is short is worse than none,
 *     because a reviewer concludes the omitted routes are covered.
 *
 * The set is DERIVED FROM SOURCE, never from the doc list. A test seeded with
 * the names the docs already claim would only confirm the docs against
 * themselves; it has to be able to fail when a *new* ungated route appears.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const ROUTES_DIR = join(REPO_ROOT, "src", "server", "mcp", "routes");
const API_ROUTES = join(REPO_ROOT, "src", "server", "mcp", "api-routes.ts");

/** Drop comments so a helper NAMED in prose isn't mistaken for a helper CALLED. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every route module reached by a mutating (`post`/`put`/`patch`/`delete`)
 * registration in `api-routes.ts`, mapped to whether its handler performs a
 * peer-address check of any kind — the two shared helpers, or the hand-rolled
 * `isLoopback` that `shutdown.ts` uses deliberately (it must accept an absent
 * `Origin`, which `assertOriginAllowlisted` rejects).
 *
 * Resolution is per-MODULE, not per-handler: a module exporting one gated and
 * one ungated mutating handler would read as gated. Every multi-handler module
 * gates each of its mutating handlers today (`sessions`, `backups`, `license`),
 * so there is no false negative now — but split such a module rather than
 * trusting this to notice.
 */
function ungatedMutatingRouteModules(): string[] {
  const src = readFileSync(API_ROUTES, "utf-8");

  // handler identifier -> route module basename
  const identToModule = new Map<string, string>();
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+"\.\/routes\/([\w-]+)\.js"/g)) {
    const moduleName = m[2];
    for (const raw of m[1].split(",")) {
      const ident = raw.replace(/\btype\b/, "").trim();
      if (ident) identToModule.set(ident, moduleName);
    }
  }

  const stripped = stripComments(src);
  const modules = new Set<string>();
  for (const reg of stripped.matchAll(/app\.(post|put|patch|delete)\(([^;]*?)\)\s*;/gs)) {
    for (const [ident, moduleName] of identToModule) {
      if (new RegExp(`\\b${ident}\\b`).test(reg[2])) modules.add(moduleName);
    }
  }

  return [...modules]
    .filter((moduleName) => {
      const body = stripComments(readFileSync(join(ROUTES_DIR, `${moduleName}.ts`), "utf-8"));
      return !/\b(assertLoopbackForMutation|assertOriginAllowlisted|isLoopback)\s*\(/.test(body);
    })
    .sort();
}

/** The four that additionally take a caller-supplied filesystem path (#1320). */
const PATH_TAKING = ["convert", "open", "save", "upload"];

/**
 * Source and test comments are scanned too, not just prose docs: #1293's own
 * report counted ~10 *comments* making this claim, and the last carrier the
 * manual sweep turned up was a header comment in `tests/server/`.
 */
function scannedFiles(): string[] {
  const docs = ["CLAUDE.md", "docs/security.md", "docs/decisions.md", "docs/roadmap.md"];
  const code = ["src", "tests"].flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf-8" })
      .filter((p) => p.endsWith(".ts"))
      .map((p) => `${dir}/${p.replace(/\\/g, "/")}`),
  );
  // This file quotes the claim wording it is hunting for.
  return [...docs, ...code].filter((p) => !p.endsWith("loopback-gate-claims.test.ts"));
}

describe("loopback-gate documentation claims (#1293 / #1322)", () => {
  it("nothing live describes the gate as inert without tensing that as history", () => {
    const offenders: string[] = [];

    for (const rel of scannedFiles()) {
      const lines = readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!/assertLoopbackForMutation/.test(line)) return;
        const claimsInert =
          /no-op|only rejects when|would not fire|is inert|dead code|does not (?:fire|gate)/i.test(
            line,
          );
        // A historical note is fine, but naming #1293 is not enough on its own:
        // the roadmap entry that survived the first sweep described the gate in
        // the PRESENT tense on a line that opened with the issue number. The
        // past-tense marker is what distinguishes "this was true once" from
        // "this is true", so both are required.
        const dated = /#1293/.test(line) && /\bwas\b|\bwere\b|\buntil\b|\bbefore\b|~~/i.test(line);
        if (claimsInert && !dated) offenders.push(`${rel}:${i + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it("the ungated mutating set derived from source is exactly what the docs enumerate", () => {
    const derived = ungatedMutatingRouteModules();

    // Sanity: the derivation must actually find the path-taking four, or the
    // parser silently returned nothing and the assertion below is vacuous.
    for (const name of PATH_TAKING) expect(derived).toContain(name);

    const NUMBER_WORD = [
      "",
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
      "Six",
      "Seven",
      "Eight",
      "Nine",
      "Ten",
      "Eleven",
      "Twelve",
    ];

    for (const rel of ["CLAUDE.md", "docs/security.md"]) {
      // Scope to the enumerating passage, not the whole file — several of these
      // route names also appear in CLAUDE.md's license-gate list, which would
      // make a document-wide search pass on an enumeration that names none of
      // them. The passage runs from its opening phrase to the blank line or
      // list item that ends it.
      const doc = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const start = doc.indexOf("governs the routes that");
      expect(start, `${rel} no longer contains the ungated-set passage`).toBeGreaterThan(-1);
      const passage = doc.slice(start, doc.indexOf("\n\n", start));

      const missing = derived.filter(
        (name) => !new RegExp(`\`${name}\`|\`/api/${name}\``).test(passage),
      );
      expect(missing, `${rel} omits ungated route(s) from its enumeration`).toEqual([]);
      expect(passage, `${rel} must state the size of the ungated set`).toMatch(
        new RegExp(`\\*\\*${NUMBER_WORD[derived.length]}\\*\\*`, "i"),
      );
    }
  });
});
