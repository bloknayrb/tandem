import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODE_FILES,
  closure,
  IMPORTS,
  sidecarEntries,
  UNRESOLVED,
} from "../helpers/import-graph.js";
import { readTree, SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * The ownership flag's module seam (#2358, ADR-054; ownership design §12).
 *
 * `src/server/ownership-flag.ts` reads `__OWNERSHIP_ENABLED__`. esbuild leaves
 * an absent define as a bare free global, and the flag then falls back to the
 * `TANDEM_OWNERSHIP` env var — a half-on build. So:
 *
 * - every module that imports the flag is pinned, so a new reader is a
 *   reviewed diff;
 * - every tsup bundle whose entry reaches the flag carries the define (derived
 *   from the real config, so a new bundle joins by itself);
 * - the define-less bundles (every sidecar, the stdio bridge's script, the SSE
 *   consumer), `src/shared` and `src/client` never reach it;
 * - only `ownership-flag.ts` reads the define or the variable in `src`.
 *
 * And the test side of shipping dark: which test files turn the flag on or off
 * for themselves is a pinned set (a file stubbing it `""` opts out of the
 * flag-on job, silently shrinking it), nothing mocks the flag module, and only
 * the anchor keys a test on the flag — while never stubbing it, so the anchor
 * proves the job's variable reached the workers.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FLAG = "src/server/ownership-flag.ts";
const ANCHOR = "tests/server/ownership-anchor.test.ts";

/** Every code file under `tests/`, repo-relative → contents, decode-checked. */
const TEST_FILES = readTree(path.join(ROOT, "tests"), (name) =>
  /\.(ts|mts|js|mjs|svelte)$/.test(name),
);

describe("ownership flag module seam", () => {
  it("the import walk resolves every relative specifier in src (fails closed)", () => {
    // The same known prose specifier license-module-seam.test.ts pins.
    expect(UNRESOLVED).toEqual([
      "src/client/svelte-harness/registry.ts -> ../path/to/Component.svelte",
    ]);
  });

  it("is imported by exactly the reviewed modules", () => {
    const importers = [...IMPORTS]
      .filter(([file, targets]) => file !== FLAG && targets.includes(FLAG))
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual([
      "src/server/mcp/owned-op.ts",
      "src/server/mcp/server.ts",
      "src/server/sessions/caller.ts",
      "src/server/sessions/log-id.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });

  it("every tsup bundle whose entry reaches it carries the define", async () => {
    type Entry = { entry?: string[]; outDir?: string; define?: Record<string, string> };
    const config = (await import(pathToFileURL(path.join(ROOT, "tsup.config.ts")).href))
      .default as Entry[];
    const reaching = config.filter((e) => (e.entry ?? []).some((f) => closure(f).has(FLAG)));
    // Anti-vacuity: the server bundle does reach it.
    expect(reaching.map((e) => e.outDir)).toContain("dist/server");
    for (const e of reaching) {
      expect(e.define, `${e.outDir} reaches ${FLAG}`).toHaveProperty("__OWNERSHIP_ENABLED__");
    }
  });

  it("no define-less bundle, and nothing in src/shared or src/client, reaches it", () => {
    const sidecars = sidecarEntries(readFileSync(path.join(ROOT, "tsup.config.ts"), "utf-8"));
    expect(sidecars).toEqual(
      expect.arrayContaining([
        "src/channel/index.ts",
        "src/monitor/index.ts",
        "src/stdio-bridge/index.ts",
      ]),
    );
    for (const root of [...sidecars, "src/cli/mcp-stdio.ts", "src/shared/sse-consumer.ts"]) {
      const reach = closure(root);
      expect(reach.size, `${root} closure`).toBeGreaterThan(1);
      expect(reach.has(FLAG), `${root} must not reach ${FLAG}`).toBe(false);
    }
    const leaking = CODE_FILES.filter(
      (f) => (f.startsWith("src/shared/") || f.startsWith("src/client/")) && closure(f).has(FLAG),
    );
    expect(leaking).toEqual([]);
  });

  it("only ownership-flag.ts reads the define or the variable in src", () => {
    const readers = CODE_FILES.filter((f) => f !== FLAG).filter((f) =>
      /TANDEM_OWNERSHIP|__OWNERSHIP_ENABLED__/.test(stripComments(SRC_FILES.get(f) as string)),
    );
    expect(readers).toEqual([]);
    expect(SRC_FILES.get(FLAG)).toMatch(/process\.env\.TANDEM_OWNERSHIP === "1"/);
  });
});

describe("tests and the flag", () => {
  /** Files whose source matches `pattern`, sorted. */
  const filesMatching = (pattern: RegExp) =>
    [...TEST_FILES]
      .filter(([, src]) => pattern.test(src))
      .map(([f]) => f)
      .sort();

  it("the walk sees the test tree", () => {
    expect(TEST_FILES.size).toBeGreaterThan(500);
    expect(TEST_FILES.has(ANCHOR)).toBe(true);
  });

  it("only the anchor keys a test on the flag", () => {
    // `ownershipEnabled` imported into a test is the way to write
    // `it.runIf(ownershipEnabled())` or `if (!ownershipEnabled()) return`; a
    // second such file is a test that silently never runs in `check`.
    expect(filesMatching(/import\s*\{[^}]*\bownershipEnabled\b[^}]*\}\s*from/)).toEqual([
      ANCHOR,
      "tests/server/ownership-flag.test.ts",
    ]);
    const keyed = [...TEST_FILES]
      .filter(([, src]) =>
        /\b(?:runIf|skipIf)\s*\([^)]*(?:ownership|OWNERSHIP)/.test(stripComments(src)),
      )
      .map(([f]) => f);
    expect(keyed).toEqual([ANCHOR]);
  });

  it("the anchor never sets the variable or mocks anything", () => {
    // Comments stripped: its docblock explains why it never calls vi.stubEnv.
    const src = stripComments(TEST_FILES.get(ANCHOR) as string);
    expect(src).not.toMatch(/stubEnv|vi\.mock|vi\.doMock|process\.env\.\w+\s*=|process\.env\[/);
    expect(src).toMatch(/expect\(process\.env\.TANDEM_OWNERSHIP\)\.toBe\("1"\)/);
  });

  it("nothing mocks the flag module", () => {
    expect(filesMatching(/vi\.(?:do)?[mM]ock\(\s*["'][^"']*ownership-flag/)).toEqual([]);
  });

  // Every file that stubs the variable, by any argument: a stub through a
  // variable would slip past the two literal sets below.
  const OWNERSHIP_TEST_FILES = [
    "tests/server/local-period.test.ts",
    "tests/server/mcp-context-seam.test.ts",
    "tests/server/mcp-write-precedence.test.ts",
    "tests/server/ownership-api-no-context.test.ts",
    "tests/server/ownership-claim-at-outcome.test.ts",
    "tests/server/ownership-claims-table.test.ts",
    "tests/server/ownership-dark-enforcement.test.ts",
    "tests/server/ownership-default-rule.test.ts",
    "tests/server/ownership-enforcement.test.ts",
    "tests/server/ownership-flag.test.ts",
    "tests/server/ownership-handover.test.ts",
    "tests/server/ownership-http-identity.test.ts",
    "tests/server/ownership-inbox-scope.test.ts",
    "tests/server/ownership-notice-rule.test.ts",
    "tests/server/ownership-records.test.ts",
    "tests/server/ownership-tool-modes.test.ts",
    "tests/server/ownership-wait-bound.test.ts",
  ];

  it("the files that stub the variable at all are a reviewed set", () => {
    expect(filesMatching(/stubEnv\(\s*["'`]TANDEM_OWNERSHIP["'`]/)).toEqual(OWNERSHIP_TEST_FILES);
  });

  it("the files that turn the flag OFF for themselves are a reviewed set", () => {
    // A file stubbing "" runs that test flag-off even in the ownership-flag-on
    // job: it pins dark behaviour, and the series lists each one (design §12).
    // Every one of these also stubs "1": none opts a whole file out.
    // PR 1c's four: each runs the same rows flag-off and flag-on (the
    // precedence pin, the tool-mode table, the `/api` differential), or pins
    // what enforcement must not do while dark.
    // The handover PR's one (`ownership-handover.test.ts`): it seeds state
    // flag-on and then turns the flag off, to show no path reaches the inbox.
    // The scope PR's one (`ownership-inbox-scope.test.ts`): its dark tests
    // build their server flag-off, to show tandem_checkInbox is master's.
    // #1123 A2's one (`local-period.test.ts`): it runs every local-period case
    // with ownership off and on (the brief's "ownership off and on").
    // The notice-rule PR's one (`ownership-notice-rule.test.ts`): its lone-
    // session script and its dark test run flag-off to compare with master.
    expect(filesMatching(/stubEnv\(\s*"TANDEM_OWNERSHIP",\s*""\s*\)/)).toEqual([
      "tests/server/local-period.test.ts",
      "tests/server/mcp-context-seam.test.ts",
      "tests/server/mcp-write-precedence.test.ts",
      "tests/server/ownership-api-no-context.test.ts",
      "tests/server/ownership-dark-enforcement.test.ts",
      "tests/server/ownership-default-rule.test.ts",
      "tests/server/ownership-flag.test.ts",
      "tests/server/ownership-handover.test.ts",
      "tests/server/ownership-inbox-scope.test.ts",
      "tests/server/ownership-notice-rule.test.ts",
      "tests/server/ownership-records.test.ts",
      "tests/server/ownership-tool-modes.test.ts",
      "tests/server/ownership-wait-bound.test.ts",
    ]);
  });

  it("the files that turn the flag ON for themselves are a reviewed set", () => {
    expect(filesMatching(/stubEnv\(\s*"TANDEM_OWNERSHIP",\s*"1"\s*\)/)).toEqual([
      "tests/server/local-period.test.ts",
      "tests/server/mcp-context-seam.test.ts",
      "tests/server/mcp-write-precedence.test.ts",
      "tests/server/ownership-api-no-context.test.ts",
      "tests/server/ownership-claim-at-outcome.test.ts",
      "tests/server/ownership-claims-table.test.ts",
      "tests/server/ownership-dark-enforcement.test.ts",
      "tests/server/ownership-default-rule.test.ts",
      "tests/server/ownership-enforcement.test.ts",
      "tests/server/ownership-flag.test.ts",
      "tests/server/ownership-handover.test.ts",
      "tests/server/ownership-inbox-scope.test.ts",
      "tests/server/ownership-notice-rule.test.ts",
      "tests/server/ownership-records.test.ts",
      "tests/server/ownership-tool-modes.test.ts",
      "tests/server/ownership-wait-bound.test.ts",
    ]);
  });

  it("no test writes the variable except through vi.stubEnv", () => {
    // An assignment, a bracket access, or a `delete` (which turns the flag off
    // for the rest of the file in the flag-on job, past every stubEnv pin).
    expect(
      filesMatching(
        /process\.env\.TANDEM_OWNERSHIP\s*=(?!=)|process\.env\[\s*["'`]TANDEM_OWNERSHIP|\bdelete\s+process\.env\.TANDEM_OWNERSHIP\b/,
      ),
    ).toEqual([]);
  });

  it("no test passes vi.stubEnv a key that is not a string literal", () => {
    // The stubEnv pins above read the key as a literal, so a stubEnv of `K` to ""
    // with `K` a constant (here or imported) would turn the flag off unseen.
    // No test needs a computed key today, so none is allowed: a new one names
    // its variable in place.
    expect(filesMatching(/\bstubEnv\(\s*(?!["'`])/)).toEqual([]);
  });
});
