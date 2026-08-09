/**
 * `resolveBundledDocDirs()` — the #1282 drift-nudge exclusion list.
 *
 * These exist because the exclusion's *predicate* was well tested while its
 * *production input* was not: every case in `cwd-preview.test.ts` injects
 * `bundledDocDirs` as a fixture, so a list that was correct in dev and wrong in
 * a packaged build passed everything. That is exactly what happened —
 * `WELCOME_PATH` resolves under the resource dir, but `index.ts` opens
 * `<TANDEM_DATA_DIR>/sample/welcome.md`, and only the Tauri shell sets that
 * variable. Dev and CI leave it unset, which collapses the two directories into
 * one and hides the gap.
 *
 * So the assertion that matters is the coupling one: the directory `index.ts`
 * would open `welcome.md` from must be in the list. Restating the join here
 * would only re-test this file's own arithmetic, so the expected value is
 * derived the same way the production code derives it.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBundledDocDirs } from "../../src/server/mcp/server.js";

/** What `src/server/index.ts` actually opens on a fresh start. */
function sampleDirIndexWouldOpen(): string {
  const base = process.env.TANDEM_DATA_DIR?.trim();
  const dir = base ? join(base, "sample") : undefined;
  if (dir === undefined) throw new Error("only meaningful with TANDEM_DATA_DIR set");
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

describe("resolveBundledDocDirs", () => {
  const original = process.env.TANDEM_DATA_DIR;

  beforeEach(() => {
    delete process.env.TANDEM_DATA_DIR;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TANDEM_DATA_DIR;
    else process.env.TANDEM_DATA_DIR = original;
  });

  it("includes the app-data sample dir the desktop app actually opens from", () => {
    // The packaged-desktop shape: the Tauri shell exports TANDEM_DATA_DIR and
    // copies sample/* into it. Without this entry the amber drift pill fires on
    // every first run, offering to repoint the launcher at Tandem's own folder.
    process.env.TANDEM_DATA_DIR = join(process.cwd(), "test-app-data");

    expect(resolveBundledDocDirs()).toContain(sampleDirIndexWouldOpen());
  });

  it("still lists the bundle's own dirs, so the app-data entry is an addition", () => {
    // A fix that swapped one directory for the other would leave the npm
    // distribution (no TANDEM_DATA_DIR, docs beside the code) unprotected.
    process.env.TANDEM_DATA_DIR = join(process.cwd(), "test-app-data");
    const withDataDir = resolveBundledDocDirs();

    delete process.env.TANDEM_DATA_DIR;
    const without = resolveBundledDocDirs();

    expect(without.length).toBeGreaterThan(0);
    for (const dir of without) expect(withDataDir).toContain(dir);
    expect(withDataDir.length).toBe(without.length + 1);
  });

  it("ignores a blank TANDEM_DATA_DIR rather than listing a bare 'sample'", () => {
    // `join("", "sample")` is the relative string "sample", which would silently
    // enter the list and could never match a canonicalized absolute candidate.
    process.env.TANDEM_DATA_DIR = "   ";

    for (const dir of resolveBundledDocDirs()) expect(dir).not.toBe("sample");
  });
});
