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
});
