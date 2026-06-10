import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("server boot ordering invariants (#334)", () => {
  it("awaits cleanupOrphanedAnnotationFiles before restoreOpenDocuments", async () => {
    const src = await fs.readFile(path.join(__dirname, "../../src/server/index.ts"), "utf-8");
    // Match `await` preceding the call site (allows optional wrapper like
    // `await withTimeout(cleanupOrphanedAnnotationFiles(...))`). Regression
    // guard assumes the identifier stays exported under this name — which is
    // fine, because a rename propagates to both call site and test in one
    // refactor.
    const awaitRe = /await\s+(?:\w+\(\s*)?cleanupOrphanedAnnotationFiles/;
    const cleanupMatch = src.match(awaitRe);
    const restoreIdx = src.indexOf("await restoreOpenDocuments");
    expect(cleanupMatch, "boot path must await the GC").not.toBeNull();
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(cleanupMatch!.index!).toBeLessThan(restoreIdx);
  });

  it("shutdown stops the autosave timer, flushes dirty docs, then saves the session", async () => {
    const src = await fs.readFile(path.join(__dirname, "../../src/server/index.ts"), "utf-8");
    // Scope the scan to the shutdown handler so import lines don't match.
    const fnStart = src.indexOf("async function shutdown(");
    expect(fnStart, "shutdown handler must exist").toBeGreaterThan(-1);
    const body = src.slice(fnStart);

    // Order matters: the timer must be stopped before the flush (so it can't
    // fire concurrently), the flush must precede the session save (so the
    // session captures post-save state), and the disk converges with the
    // session instead of lagging up to 60s of edits.
    const stopIdx = body.indexOf("stopAutoSave()");
    const flushIdx = body.indexOf("autoSaveAllToDisk()");
    const sessionIdx = body.indexOf("saveCurrentSession()");
    expect(stopIdx, "shutdown must stop the autosave timer").toBeGreaterThan(-1);
    expect(flushIdx, "shutdown must flush dirty docs to disk").toBeGreaterThan(-1);
    expect(sessionIdx, "shutdown must save the session").toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(flushIdx);
    expect(flushIdx).toBeLessThan(sessionIdx);
  });
});
