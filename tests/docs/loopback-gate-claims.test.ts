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
 * Budget for the corpus walk, well above vitest's 15s default.
 *
 * Measured: ~5s for this file alone, ~22-25s inside the full suite on Windows,
 * where vitest's own transforms are already saturating the disk. The default
 * turned that gap into a red run that reproduced on master and passed on CI —
 * a timing verdict wearing the costume of a security-invariant failure, which
 * is the most expensive kind of false alarm to debug. Generous on purpose: this
 * number exists to stop the machine's load deciding the outcome, so it should
 * only ever fail if the walk is genuinely broken.
 */
const CORPUS_TIMEOUT_MS = 90_000;

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

/**
 * Read every scanned file ONCE, shared across the tests below.
 *
 * This scan walks ~1500 `.ts` files with synchronous I/O, and each test used to
 * repeat the whole walk. Under the full suite — where vitest is already
 * saturating the disk with its own transforms — that pushed a single test past
 * vitest's 15s default and failed the run on timing alone, on Windows, while
 * passing in isolation and on CI. A test whose verdict depends on how busy the
 * machine is reports nothing useful about the claim it exists to check.
 *
 * Memoized at module scope rather than in a `beforeAll` so the cost lands once
 * per file, not once per suite. Memoizing alone is not sufficient — whichever
 * test runs first still pays the full walk, which is why the test consuming it
 * also carries {@link CORPUS_TIMEOUT_MS}.
 */
let cachedCorpus: Array<{ rel: string; lines: string[] }> | null = null;
function corpus(): Array<{ rel: string; lines: string[] }> {
  if (!cachedCorpus) {
    cachedCorpus = scannedFiles().map((rel) => ({
      rel,
      lines: readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n"),
    }));
  }
  return cachedCorpus;
}

describe("loopback-gate documentation claims (#1293 / #1322)", () => {
  it(
    "nothing live describes the gate as inert without tensing that as history",
    () => {
      const offenders: string[] = [];

      for (const { rel, lines } of corpus()) {
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
          const dated =
            /#1293/.test(line) && /\bwas\b|\bwere\b|\buntil\b|\bbefore\b|~~/i.test(line);
          if (claimsInert && !dated) offenders.push(`${rel}:${i + 1}`);
        });
      }

      expect(offenders).toEqual([]);
    },
    CORPUS_TIMEOUT_MS,
  );

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

  it("the #1320 carve-out set derived from source is exactly what the docs enumerate", () => {
    // The invariant made deny the default, so the hand-maintained list flipped
    // from obligations to EXEMPTIONS. That is a safer list to keep by hand —
    // forgetting to add to it fails closed — but it is still the one place a
    // reviewer has to trust prose, so pin it to the source the same way.
    const src = stripComments(readFileSync(API_ROUTES, "utf-8"));
    const block = src.match(/NON_LOOPBACK_ALLOWED[^=]*=\s*new Set\(([\s\S]*?)\n\);/);
    expect(
      block,
      "NON_LOOPBACK_ALLOWED is no longer a literal list of API_* constants",
    ).not.toBeNull();

    const constants = [...(block?.[1] ?? "").matchAll(/\b(API_[A-Z_]+)\b/g)].map((m) => m[1]);
    // Sanity, for the same reason PATH_TAKING exists above: a regex that
    // silently matched nothing would make every assertion below vacuous.
    expect(constants.length).toBeGreaterThan(1);

    const paths = readFileSync(join(REPO_ROOT, "src", "shared", "api-paths.ts"), "utf-8");
    const carveOuts = constants.map((name) => {
      const literal = paths.match(new RegExp(`export const ${name} = "([^"]+)"`));
      expect(literal, `${name} has no literal in api-paths.ts`).not.toBeNull();
      return literal?.[1] ?? "";
    });

    for (const rel of ["CLAUDE.md", "docs/security.md"]) {
      const doc = readFileSync(join(REPO_ROOT, rel), "utf-8");
      // Family form is what the docs should say — enumerating five sibling
      // channel paths is noise a reader will not re-verify. Accept either the
      // family prefix or the exact path, but the prefix must be the REAL one:
      // both docs said `/api/channel/*` with a slash for months, which matches
      // no route and would have been carried straight into the carve-out set.
      const missing = carveOuts.filter(
        (p) =>
          !doc.includes(p) && !(p.startsWith("/api/channel-") && doc.includes("/api/channel-")),
      );
      expect(missing, `${rel} omits #1320 carve-out(s)`).toEqual([]);
      expect(doc, `${rel} must not write the non-existent /api/channel/* form`).not.toMatch(
        /\/api\/channel\/\*/,
      );
    }
  });
});
