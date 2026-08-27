/**
 * Tests for the ADR-034 named file-open seam.
 *
 * This file used to assert `openFromDisk === openFileByPath`, and the two
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
 *     `mcp/file-opener.ts` outside a written-down exception list — five modules
 *     today, each with the symbols it is allowed to take. That is Unit 6's
 *     actual deliverable, and nothing else observes it: a new route importing
 *     `openFileByPath` would work perfectly and quietly put the seam back to
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

import {
  kindOfOpenResult,
  openFromUpload,
  openScratchpad,
} from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import type { OpenFileResult } from "../../src/server/mcp/file-opener.js";
import { removeDocument } from "../../src/server/yjs/provider.js";

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
   * the five SANCTIONED rows below were consequently zero-of-zero: their
   * `allowed` lists name reload-family symbols (`restoreDocumentFromBackup`,
   * `reloadDocumentFromMarkdown`, `resolveExternalConflict`) that the
   * vocabulary could not see, so those rows constrained nothing and could
   * never fail. Only the `document-service.ts` row was live.
   *
   * A name list cannot see a symbol nobody has heard of yet — the same
   * argument `registry-primitive-containment.test.ts` makes for pinning an
   * exact exported surface. Deriving it means a NEW export from
   * `file-opener.ts` is in scope automatically, and every row constrains
   * something.
   */
  let ENTRIES: string[] = [];
  beforeAll(async () => {
    ENTRIES = Object.keys(await import("../../src/server/mcp/file-opener.js"));
    // A derived vocabulary that derives to nothing satisfies every filter below.
    expect(ENTRIES.length, "control: the export surface is non-empty").toBeGreaterThan(3);
  });

  /**
   * Written down here, not derived: this is the review inventory. Every module
   * under `src/` that may reach `mcp/file-opener.ts` at all, and the symbols it
   * may take. Adding a row is a decision someone has to make deliberately.
   *
   * Keys are src-relative, forward-slashed — the same source tree must not
   * produce a different verdict on Windows than on CI's Linux runner.
   */
  const SANCTIONED: Record<string, string[]> = {
    // Reload-family entries the ADR-034 seam does not name.
    "server/mcp/routes/backups.ts": ["restoreDocumentFromBackup"],
    "server/mcp/docx-apply.ts": ["restoreDocumentFromBackup"],
    "server/mcp/routes/document-reload.ts": ["reloadDocumentFromMarkdown"],
    "server/mcp/routes/external-conflict.ts": ["resolveExternalConflict"],
    // The cycle break: file-opener statically imports document-service, so the
    // restore path can only reach back dynamically. Unit 7a replaces this with
    // `openFromRestore` on the seam.
    "server/mcp/document-service.ts": ["openFileByPath", "wireAnnotationStore", "wireFileWatcher"],
  };

  const srcRoot = path.resolve(fileURLToPath(import.meta.url), "../../../src");
  const seam = path.join(srcRoot, "server", "documents", "open.ts");
  const impl = path.join(srcRoot, "server", "mcp", "file-opener.ts");

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
   * way — `import * as fo`, `export { openFileByPath } from …` (the exact line
   * this branch deleted from `mcp/document.ts`), a bare
   * `(await import(…)).openFileByPath`, and a multi-line destructure Biome
   * emits on its own once the list is long enough. Every one of those is a real
   * regrowth of the thing Unit 6 removes, and every one passed.
   *
   * So this keys on the structural fact instead: **which files name the legacy
   * module specifier at all.** Syntax cannot route around that — reaching
   * `file-opener.ts` requires saying its name. The symbol check is then a
   * second, narrower layer over the handful of files allowed to say it.
   */
  it("only sanctioned modules name the legacy file-opener specifier", async () => {
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
      if (/["'][^"']*file-opener\.js["']/.test(body)) referencing.push(rel(file));
    }

    expect(
      referencing.sort(),
      "a module that reaches mcp/file-opener.ts must either move to documents/open.js or be added to SANCTIONED with the symbols it needs — adding a row is a deliberate decision, not a formality",
    ).toEqual(Object.keys(SANCTIONED).sort());
  });

  it("sanctioned modules take only the symbols they are sanctioned for", async () => {
    // The file-level gate above is what syntax cannot evade. This narrows what
    // the five survivors may do with their access — including through a
    // namespace alias, since `fo.openFileByPath` still spells the bare name.
    for (const [relPath, allowed] of Object.entries(SANCTIONED)) {
      const body = stripCommentsAndStrings(await fs.readFile(path.join(srcRoot, relPath), "utf8"));
      const used = ENTRIES.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
      const forbidden = used.filter((name) => !allowed.includes(name));
      expect(forbidden, `${relPath} may not use ${forbidden.join(", ")}`).toEqual([]);
    }

    // Positive control for the symbol matcher itself: the one sanctioned use of
    // an entry point must actually be visible to it. Without this, a matcher
    // that found nothing anywhere would report a clean bill of health.
    const restore = stripCommentsAndStrings(
      await fs.readFile(path.join(srcRoot, "server/mcp/document-service.ts"), "utf8"),
    );
    expect(
      /\bopenFileByPath\b/.test(restore),
      "control: the sanctioned restore call is where this test thinks it is",
    ).toBe(true);
  });

  it("scans every executable file under src/, so a new extension cannot hide", async () => {
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
  });
});

describe("kindOfOpenResult", () => {
  function baseResult(overrides: Partial<OpenFileResult>): OpenFileResult {
    return {
      documentId: "doc-1",
      filePath: "/tmp/doc-1.md",
      fileName: "doc-1.md",
      format: "md",
      readOnly: false,
      source: "file",
      tokenEstimate: 0,
      pageEstimate: 0,
      restoredFromSession: false,
      alreadyOpen: false,
      forceReloaded: false,
      ...overrides,
    };
  }

  it("returns 'force-reloaded' when forceReloaded is true (highest priority)", () => {
    expect(
      kindOfOpenResult(
        baseResult({ forceReloaded: true, alreadyOpen: true, restoredFromSession: true }),
      ),
    ).toBe("force-reloaded");
  });

  it("returns 'already-open' when alreadyOpen is true but not force-reloaded", () => {
    expect(kindOfOpenResult(baseResult({ alreadyOpen: true, restoredFromSession: true }))).toBe(
      "already-open",
    );
  });

  it("returns 'restored' when only restoredFromSession is true", () => {
    expect(kindOfOpenResult(baseResult({ restoredFromSession: true }))).toBe("restored");
  });

  it("returns 'fresh' when none of the flags are set", () => {
    expect(kindOfOpenResult(baseResult({}))).toBe("fresh");
  });
});
