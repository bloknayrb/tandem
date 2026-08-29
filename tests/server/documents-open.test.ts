/**
 * Tests for the ADR-034 named file-open seam.
 *
 * This file used to assert `openFromDisk === openFromDisk`, and the two
 * siblings of that. Those assertions were true of a re-export and of nothing
 * else: they pass while the seam forwards, and go RED the moment Unit 7a moves
 * the implementation into this module — which is the change they sit in front
 * of. An assertion that fails on the intended refactor and passes on every
 * behavioural break is worse than none.
 *
 * What replaces them:
 *   - **Outcome.** Calling through the seam opens a real document — upload
 *     provenance for `openFromUpload`, seeded content for `openScratchpad`.
 *     (`openFromDisk`'s outcomes are covered in the characterization suite,
 *     which drives every entry point through this same seam.)
 *   - **The redirect invariant.** No module under `src/` may reach
 *     `mcp/file-opener.ts` outside a written-down exception list — four
 *     modules today (Unit 7a removed the fifth), each with the symbols it may
 *     take. That is Unit 6's
 *     actual deliverable, and nothing else observes it: a new route importing
 *     `openFromDisk` would work perfectly and quietly put the seam back to
 *     zero production consumers.
 *
 * Broader behaviour of the open pipelines is characterized in
 * `adr-034-open-characterization.test.ts`.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-seam-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

import { openFromUpload, openScratchpad } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { removeDocument } from "../../src/server/yjs/provider.js";
import { timeoutMs } from "../helpers/timing.js";

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

describe("named entry points (ADR-034 seam)", () => {
  beforeEach(() => {
    for (const id of [...getOpenDocs().keys()]) {
      removeDoc(id);
      removeDocument(id);
    }
    setActiveDocId(null);
  });

  it("openFromUpload opens a tracked document with upload provenance", async () => {
    const result = await openFromUpload("seam.md", "# Seam\n");

    expect(result.source, "provenance drives dirty-mirror and rename affordances").toBe("upload");
    expect(getOpenDocs().get(result.documentId)?.source).toBe("upload");
  });

  it("openScratchpad seeds the buffer it is given", async () => {
    // The header used to say this entry opens "an empty" buffer. It has taken
    // optional content since #979, and a caller trusting the old wording would
    // seed nothing.
    const result = await openScratchpad("# Seeded\n");
    const { extractText } = await import("../../src/server/mcp/document.js");
    const { getOrCreateDocument } = await import("../../src/server/yjs/provider.js");

    expect(extractText(getOrCreateDocument(result.documentId))).toContain("Seeded");
  });
});

describe("the redirect invariant (Unit 6)", () => {
  /**
   * Derived from the module's real export surface, not written down.
   *
   * This was a hand-written list of the three open entry points, and four of
   * the five SANCTIONED rows that existed then were consequently zero-of-zero
   * (Unit 7a has since removed the fifth, `document-service.ts`): their
   * `allowed` lists name reload-family symbols (`restoreDocumentFromBackup`,
   * `reloadDocumentFromMarkdown`, `resolveExternalConflict`) that the
   * vocabulary could not see, so those rows constrained nothing and could
   * never fail. Only the `document-service.ts` row was live.
   *
   * A name list cannot see a symbol nobody has heard of yet — the same
   * argument `registry-primitive-containment.test.ts` makes for pinning an
   * exact exported surface. Deriving it means a NEW export from
   * `reload-family.ts` is in scope automatically, and every row constrains
   * something.
   */
  let ENTRIES: string[] = [];
  beforeAll(async () => {
    ENTRIES = Object.keys(await import("../../src/server/documents/reload-family.js"));
    // A derived vocabulary that derives to nothing satisfies every filter
    // below. This was a `> 3` count, which was really the old export surface's
    // size wearing a control's clothing: Unit 7a shrank that surface to exactly
    // the three reload entries and the control failed on a correct change.
    //
    // The honest check is the one that rules out the bug the derivation exists
    // to fix — a SANCTIONED row naming a symbol the vocabulary cannot see, and
    // therefore constraining nothing. Asserting coverage of the rows keeps that
    // impossible no matter how the surface is resized.
    const named = new Set(Object.values(SANCTIONED).flat());
    expect(ENTRIES.length, "control: the export surface is non-empty").toBeGreaterThan(0);
    expect(
      [...named].filter((n) => !ENTRIES.includes(n)),
      "every SANCTIONED symbol must be in the derived vocabulary, or its row is zero-of-zero",
    ).toEqual([]);
  });

  /**
   * Written down here, not derived: this is the review inventory. Every module
   * under `src/` that may reach `documents/reload-family.ts` at all, and the
   * symbols it may take. Adding a row is a decision someone has to make
   * deliberately.
   *
   * **Migrated, not emptied, when Unit 7c deleted `mcp/file-opener.ts`.** The
   * obvious move was to empty the list along with the module that motivated it
   * — and review caught that the spec below loops `Object.entries(SANCTIONED)`,
   * so an empty map runs zero assertions. The defeat it named: give
   * `routes/backups.ts` an import of `resolveExternalConflict`, which it is not
   * entitled to, and stay green forever. The module moved; the reason for the
   * inventory did not, so the inventory moved with it.
   *
   * Keys are src-relative, forward-slashed — the same source tree must not
   * produce a different verdict on Windows than on CI's Linux runner.
   */
  const SANCTIONED: Record<string, string[]> = {
    // The reload family — replacing the content of an ALREADY-open document.
    // Since Unit 7c these live in `documents/reload-family.ts`; the four
    // consumers and their entitlements are unchanged by that move.
    "server/mcp/routes/backups.ts": ["restoreDocumentFromBackup"],
    "server/mcp/docx-apply.ts": ["restoreDocumentFromBackup"],
    "server/mcp/routes/document-reload.ts": ["reloadDocumentFromMarkdown"],
    "server/mcp/routes/external-conflict.ts": ["resolveExternalConflict"],
    // Unit 7a removed the fifth row. `document-service.ts` reached into
    // file-opener through three dynamic imports whose only purpose was
    // breaking the cycle its own static import created; with the pipeline,
    // annotation wiring and the watcher all living below both modules, every
    // one of them is a static import of `documents/`, so that PAIR of modules
    // no longer forms a cycle. (A three-module one through `documents/autosave.ts`
    // does remain — see the `documents/open.ts` header. This row is not what
    // would catch it.) A row reappearing here is the old cycle regrowing.
  };

  const srcRoot = path.resolve(fileURLToPath(import.meta.url), "../../../src");
  const seam = path.join(srcRoot, "server", "documents", "open.ts");
  const impl = path.join(srcRoot, "server", "documents", "reload-family.ts");

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  }

  /** Strip comments and string literals so prose about a symbol is not a use of it. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  }

  /**
   * Strings too, for the symbol scan ONLY. The specifier check must not use
   * this: a module specifier *is* a string literal, so stripping strings made
   * the whole sweep return nothing. The file-level `toEqual` caught that
   * immediately — which is the argument for asserting a non-empty expected list
   * rather than an emptiness check.
   */
  function stripCommentsAndStrings(src: string): string {
    return stripComments(src)
      .replace(/`(?:\\.|[^`\\])*`/g, "``")
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  }

  function rel(file: string): string {
    return path.relative(srcRoot, file).replace(/\\/g, "/");
  }

  /**
   * The previous version of this guard matched two import *shapes*. Four
   * reviewers independently defeated it by writing the same import a different
   * way — `import * as fo`, `export { openFromDisk } from …` (the exact line
   * this branch deleted from `mcp/document.ts`), a bare
   * `(await import(…)).openFromDisk`, and a multi-line destructure Biome
   * emits on its own once the list is long enough. Every one of those is a real
   * regrowth of the thing Unit 6 removes, and every one passed.
   *
   * So this keys on the structural fact instead: **which files name the legacy
   * module specifier at all.** Syntax cannot route around that — reaching
   * `file-opener.ts` requires saying its name. The symbol check is then a
   * second, narrower layer over the handful of files allowed to say it.
   */
  /**
   * Corpus-walk budget, well above the project's 15s default.
   *
   * These specs read every `.ts`/`.svelte` file under `src/`. Alone that is a
   * couple of seconds; inside the full suite on Windows, where vitest's own
   * transforms are already saturating the disk, they run long enough to blow
   * the default and fail as a timeout -- which reads exactly like the redirect
   * invariant being violated, rather than like the machine being busy. That is
   * the most expensive kind of false alarm, and it has already cost a push.
   *
   * `tests/docs/loopback-gate-claims.test.ts` reached the same conclusion for
   * the same reason and settled on 90s; this is the same number so the two
   * corpus walks stop disagreeing. Generous on purpose: it exists so load
   * cannot decide the outcome, and should only ever fail if the walk is
   * genuinely broken.
   *
   * Via `timeoutMs` rather than a bare literal: an explicit second
   * argument to `it` beats `--testTimeout`, so a coverage run (1.1-1.5x
   * instrumented) would otherwise fail these on a clock for a reason
   * unrelated to what they check.
   */
  const CORPUS_TIMEOUT_MS = timeoutMs(90_000, 300_000);

  it(
    "only sanctioned modules import the reload family directly",
    async () => {
      const files = (await walk(srcRoot)).filter((f) => /\.(ts|svelte)$/.test(f));

      // Controls. An empty or truncated sweep satisfies every assertion below
      // vacuously, which is how this class of guard usually dies.
      expect(files.length, "control: the sweep found the source tree").toBeGreaterThan(50);
      expect(files, "control: the seam and its implementation are both in scope").toEqual(
        expect.arrayContaining([seam, impl]),
      );

      const referencing: string[] = [];
      for (const file of files) {
        if (file === seam || file === impl) continue;
        const body = stripComments(await fs.readFile(file, "utf8"));
        if (/["'][^"']*reload-family\.js["']/.test(body)) referencing.push(rel(file));
      }

      expect(
        referencing.sort(),
        "a module that reaches documents/reload-family.ts must either use documents/open.js instead or be added to SANCTIONED with the symbols it needs — adding a row is a deliberate decision, not a formality",
      ).toEqual(Object.keys(SANCTIONED).sort());
    },
    CORPUS_TIMEOUT_MS,
  );

  it(
    "sanctioned modules take only the symbols they are sanctioned for",
    async () => {
      // The file-level gate above is what syntax cannot evade. This narrows what
      // the four survivors may do with their access — including through a
      // namespace alias, since `fo.openFromDisk` still spells the bare name.
      for (const [relPath, allowed] of Object.entries(SANCTIONED)) {
        const body = stripCommentsAndStrings(
          await fs.readFile(path.join(srcRoot, relPath), "utf8"),
        );
        const used = ENTRIES.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
        const forbidden = used.filter((name) => !allowed.includes(name));
        expect(forbidden, `${relPath} may not use ${forbidden.join(", ")}`).toEqual([]);

        // Positive control, per row rather than once for the suite. This was a
        // single anchor naming `openFileByPath` in `document-service.ts` — which
        // Unit 7a legitimately removed, so the control failed on a correct change
        // while proving nothing about the other four rows.
        //
        // Checking each row instead means a row can never go quiet: if a module's
        // sanctioned symbol stops appearing, the row has stopped constraining
        // anything and should be deleted, not left sitting there reading like a
        // rule. It also keeps the matcher honest — one that found nothing
        // anywhere would fail here rather than report a clean bill of health.
        expect(
          used,
          `${relPath} no longer uses any sanctioned symbol — delete the row rather than leaving it`,
        ).not.toEqual([]);
      }
    },
    CORPUS_TIMEOUT_MS,
  );

  // Budgeted for the same reason as the two above, and it carried no budget
  // on EITHER side of this merge: it walks the same corpus. Two specs were
  // observed failing under load and two got funded; three do the expensive
  // thing. Naming the set is only worth anything if the set is the thing
  // that gets funded.
  it(
    "scans every executable file under src/, so a new extension cannot hide",
    async () => {
      // The sweep filters on `.ts`/`.svelte`. That is complete today and has no
      // guard against a `.mts`/`.cts`/`.tsx` appearing — the exact drift that has
      // already cost this repo twice (see the typecheck:tests orphan sweep).
      const unscanned = (await walk(srcRoot))
        .filter((f) => /\.(mts|cts|tsx|jsx|mjs|cjs|js)$/.test(f))
        .map(rel);

      expect(
        unscanned,
        "these are executable and the redirect sweep does not read them — widen the extension filter above",
      ).toEqual([]);
    },
    CORPUS_TIMEOUT_MS,
  );
});

// `kindOfOpenResult`'s precedence is pinned in
// `tests/server/open-result-message.test.ts`, over the full 2^3 cross product.
// It lived here as four reachable cases; one fixture in two files is what
// drifts. The message chain that USED to be a second copy of that precedence
// now switches on `kind`, so the two are pinned as a round trip rather than as
// two orderings that happen to agree.
