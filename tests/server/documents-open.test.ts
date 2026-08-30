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
 *     `documents/reload-family.ts` outside a written-down exception list —
 *     four modules today, each with the symbols it may take. That is Unit 6's
 *     actual deliverable, and nothing else observes it: a new route importing
 *     `openFromDisk` would work perfectly and quietly put the seam back to
 *     zero production consumers.
 *
 *     The named module has changed twice. It was `mcp/file-opener.ts` when
 *     this was written; Unit 7a moved the open pipeline out of it, and Unit 7c
 *     moved the remaining reload family to `documents/reload-family.ts` and
 *     deleted it. The inventory moved with the module rather than being
 *     emptied — an empty `SANCTIONED` runs zero assertions through the
 *     `Object.entries` loop below, which is the shape where a guard reads
 *     exactly like a pass.
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
import { isSourceFile } from "../helpers/source-extensions.js";
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
   * So this keys on the structural fact instead: **which files name the
   * module specifier at all.** Most syntax cannot route around that — reaching
   * `reload-family.ts` requires saying its name, in `import * as`, in a
   * dynamic `import()` — quoted OR backticked, the latter added after review
   * found the pattern read only `["']` while this sentence promised both —
   * in a destructure. The symbol check is then a second, narrower layer over
   * the handful of files allowed to say it.
   *
   * What still gets through, stated so it is not rediscovered: a specifier
   * assembled at runtime (`import(`../documents/${dir}/x.js`)`) names nothing
   * this can match. Nothing in `src/` does that, and a static guard cannot
   * close it — but a reader deserves to know the boundary rather than infer
   * a stronger one from silence.
   *
   * **"Most" is doing work, and the exception is written down rather than
   * discovered again.** A guard keyed on an EDGE is defeated by anything that
   * does not create one. A sanctioned consumer can `export { restoreDocumentFromBackup };`
   * — a bare re-export of a symbol it is already entitled to — and any module
   * may then import it from THERE. No new specifier means no new row here and
   * none in `documents-boundary.test.ts`'s fan-in tally, and the entitlement
   * layer has nothing to object to because the re-exporting module is listed.
   * Both layers are satisfied by construction rather than by the code being
   * safe. (The `export … from "…reload-family.js"` form IS caught, but only
   * incidentally: it happens to carry a specifier.) The `it` below closes it
   * by asking a different question — not who imports, but who re-exports.
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
      // The vocabulary is shared with `documents-boundary.test.ts`, whose
      // docblock defers bare `export { X };` laundering to THIS file. That
      // deferral was only as good as the extension set behind it: this walk
      // was `ts|svelte` while the boundary file's was `ts|tsx|mts|cts|svelte`,
      // so a `.mts` consumer bare-re-exporting a sanctioned symbol was
      // invisible to both at once. Sharing the constant makes them equal by
      // construction; `helpers/source-extensions.ts` carries the case fix and
      // its negative control.
      const files = (await walk(srcRoot)).filter(isSourceFile);

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
        // The extension is OPTIONAL, and that is the whole point. `tsconfig.json`
        // sets `moduleResolution: "bundler"` and `tsconfig.server.json` extends it,
        // so `from "../../documents/reload-family"` typechecks, bundles and ships.
        // This required a literal `.js` until review demonstrated the gap: an
        // unsanctioned fifth consumer using the extensionless form passed this
        // spec, passed `tsc --noEmit`, and produced a successful `tsup` build.
        //
        // The miss COMPOUNDED, which is why the extension is the wrong thing to
        // anchor on. The symbol-entitlement spec below iterates the list this
        // loop builds, so a file that never enters `referencing` is never checked
        // for which symbols it takes either — one dropped extension defeated both
        // layers, and the second layer's silence looked identical to a pass.
        // The backtick is in the class because a template literal is a legal
        // module specifier for a dynamic import: `await import(`…/reload-family.js`)`
        // typechecks, runs, and carried no quote for the old pattern to find.
        // The prose above claimed dynamic `import()` was covered; it was covered
        // only in its quoted form, which is the overclaim this file has now
        // produced twice.
        if (/["'`][^"'`]*reload-family(?:\.[a-z]+)?["'`]/.test(body)) {
          referencing.push(rel(file));
        }
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

  it(
    "no sanctioned module re-exports its entitlement, which would launder access to anyone",
    async () => {
      // Demonstrated, not hypothesised. Appending `export { restoreDocumentFromBackup };`
      // to `routes/backups.ts` and importing it from an unlisted module passed
      // every other spec in this file AND the boundary inventory: 25 green with
      // an arbitrary fifth consumer in place.
      //
      // Scoped to the sanctioned four rather than all of `src/`, because they
      // are the only modules that HAVE the symbols to re-export — anywhere else,
      // the specifier sweep above already fires.
      //
      // `export *` is refused outright rather than analysed. A star re-export
      // from a sanctioned consumer republishes whatever it imported without
      // naming anything, so no name-keyed check can see it; and these four are
      // route modules with no legitimate need for one. Refusing the construct
      // is a rule a reader can hold, where "a star export whose target
      // transitively re-exports the family" is not.
      const offenders: string[] = [];
      for (const relPath of Object.keys(SANCTIONED)) {
        const body = stripComments(await fs.readFile(path.join(srcRoot, relPath), "utf8"));
        if (/export\s*\*/.test(body)) {
          offenders.push(`${relPath} uses \`export *\`, which republishes without naming`);
        }
        for (const name of ENTRIES) {
          // `export { x }`, `export { x as y }`, `export { a, x }` — with or
          // without a `from` clause, since the bare form is the one that was
          // invisible. A local `export function <name>` cannot occur here: these
          // names are defined in reload-family.ts, not in a consumer.
          const re = new RegExp(`export\\s*\\{[^}]*(?<![\\w$])${name}(?![\\w$])[^}]*\\}`);
          if (re.test(body)) offenders.push(`${relPath} re-exports ${name}`);

          // Matching the ORIGINAL name is not enough, and review demonstrated
          // both ways round it. `import { restoreDocumentFromBackup as _r }`
          // followed by `export { _r };` contains the original name only in the
          // import, which this file is entitled to have — so the export carries
          // the capability under a name the loop above never looks for. Resolve
          // the local binding first, then ask what leaves under it.
          const bound = new RegExp(
            `import\\s*\\{([^}]*)\\}\\s*from\\s*["'\`][^"'\`]*reload-family`,
          ).exec(body);
          const localNames = (bound?.[1] ?? "")
            .split(",")
            .map((clause) => clause.trim())
            .filter((clause) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(clause))
            .map((clause) => {
              const asMatch = /\bas\s+([\w$]+)/.exec(clause);
              return asMatch ? asMatch[1] : clause;
            })
            .filter((local) => local && local !== name);
          for (const local of localNames) {
            const leaks = [
              new RegExp(`export\\s*\\{[^}]*(?<![\\w$])${local}(?![\\w$])[^}]*\\}`),
              new RegExp(`export\\s+(?:const|let|var)\\s+[\\w$]+\\s*=\\s*${local}(?![\\w$])`),
              new RegExp(`export\\s+default\\s+${local}(?![\\w$])`),
            ];
            if (leaks.some((re2) => re2.test(body))) {
              offenders.push(`${relPath} re-exports ${name} as ${local}`);
            }
          }
        }
      }
      expect(
        offenders,
        "a consumer re-exporting what it is entitled to hands that entitlement to every module in src/, and adds no import edge for any inventory to see",
      ).toEqual([]);
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
