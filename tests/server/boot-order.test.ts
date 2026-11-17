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

/**
 * The local period's boot wiring (#1123 A2, review round 2 item 4). Nothing
 * else would notice these calls going missing: `wireLocalPeriod` only installs
 * hooks, and `recordBootSelections` only stamps the selections a restored
 * session holds, so a deleted call leaves every behaviour test green (they
 * call both themselves). These are TEXT pins over the source: a call that is
 * commented out (`// wireLocalPeriod();`) still matches and stays green, so
 * they catch a deletion or a reorder, not a disabling. The persistence round trip in
 * `tests/server/local-period.test.ts` (`restartServer`) is a hand copy of
 * the order pinned here: CTRL restore, priming, then the wiring.
 */
describe("local period boot wiring (#1123 A2)", () => {
  const read = () => fs.readFile(path.join(__dirname, "../../src/server/index.ts"), "utf-8");
  const all = (src: string, needle: string): number[] => {
    const out: number[] = [];
    for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i);
    return out;
  };

  it("wireLocalPeriod runs once, after the CTRL and document restores and the answerer prime, in its own try, before Hocuspocus and the supervisor", async () => {
    const src = await read();
    const wires = all(src, "wireLocalPeriod();");
    expect(wires).toHaveLength(1);
    const wire = wires[0];
    const ctrl = src.indexOf("await restoreCtrlSession()");
    const docs = src.indexOf("await restoreOpenDocuments");
    const prime = src.indexOf("primeChatAnswerer();");
    expect(ctrl).toBeGreaterThan(-1);
    expect(docs).toBeGreaterThan(ctrl);
    expect(prime).toBeGreaterThan(docs);
    expect(wire).toBeGreaterThan(prime);
    // Outside the prime's try: that try closes, and a new one opens, between them.
    const between = src.slice(prime, wire);
    expect(between).toMatch(/\}\s*catch\s*\(err\)[\s\S]*try\s*\{/);
    expect(wire).toBeLessThan(src.indexOf("startHocuspocus("));
    expect(wire).toBeLessThan(src.indexOf("await startLauncherSupervisor()"));
  });

  it("recordBootSelections runs immediately before Hocuspocus binds, on both the HTTP and the stdio path, after the wiring", async () => {
    const src = await read();
    const records = all(src, "recordBootSelections();");
    expect(records).toHaveLength(2);
    const wire = src.indexOf("wireLocalPeriod();");
    const binds = all(src, "startHocuspocus(wsPort)");
    expect(binds).toHaveLength(2);
    // HTTP: after every startup document is open, before the bind.
    const userDefault = src.indexOf("applyUserOpenDefaultToDocuments(");
    expect(records[0]).toBeGreaterThan(wire);
    expect(records[0]).toBeGreaterThan(userDefault);
    expect(records[0]).toBeLessThan(binds[0]);
    // Nothing that opens a document between the record and the HTTP bind.
    expect(src.slice(records[0], binds[0])).not.toMatch(/open(FromDisk|Document|Scratchpad)\(/);
    // Stdio: the statement just before the awaited bind.
    expect(records[1]).toBeGreaterThan(binds[0]);
    expect(src.slice(records[1], binds[1])).toMatch(/^recordBootSelections\(\);\s*\}\s*await $/);
  });
});
