/**
 * Save-path ordering, session isolation and the unconditional re-arm
 * (#1749 / #1750).
 *
 * The three faults this file pins, all on the save path:
 *
 *  1. `saveSession` used to run BEFORE the `SAVED_AT_VERSION` stamp, so a
 *     throw from it — an `ENAMETOOLONG` session key was the reported instance
 *     — left the bytes on disk, the stamp unset and the document dirty. The UI
 *     said unsaved, autosave retried the write forever, and the watcher
 *     suppression counter had already been consumed by a write whose stamp
 *     never landed.
 *  2. The two session loops (`documents/autosave.ts` and `saveCurrentSession`)
 *     had no per-document try/catch, so one failing document aborted the loop
 *     AND suppressed the post-loop work — the whole 60 s disk flush in one
 *     case, the shutdown chat-history write in the other.
 *  3. `rearmWatch` must run even when the write throws, which is why it lives
 *     in a NEW INNER `finally` around exactly the suppress/write/record triple
 *     rather than in the function-level lock-release `finally`.
 *
 * **Everything platform-gated here runs under a linux stub**, because
 * `rearmWatch` is a win32 no-op by design: on Bryan's box these cases would be
 * vacuous without it, and real only in ubuntu `check`.
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";
import type { ExternalConflictState } from "../../src/shared/types.js";

/** Interleaving record for the five ordering assertions. vitest ships no
 *  `toHaveBeenCalledBefore`, and this repo's one mention of
 *  `invocationCallOrder` declines it. */
const order = vi.hoisted(() => [] as string[]);

const sessionDir = vi.hoisted(() => {
  const base = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
  return `${base}/tandem-save-order-${Math.random().toString(16).slice(2)}`;
});

vi.mock("../../src/server/platform", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SESSION_DIR: sessionDir,
}));

const hooks = vi.hoisted(() => ({
  saveSession: null as null | ((filePath: string) => Promise<void> | void),
  atomicWrite: null as null | ((filePath: string) => Promise<void> | void),
  sessionAttempts: [] as string[],
  backupPath: "",
}));

// PARTIAL mock. `document-service.ts` and `autosave.ts` import `saveSession` as
// a NAMED ESM BINDING, so `vi.spyOn` on the namespace never reaches it — and a
// wholesale mock would take `deleteSession`, `loadSession` and the real session
// directory with it, which the "no session file remains" assertion needs.
vi.mock("../../src/server/session/manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/session/manager.js")>();
  return {
    ...actual,
    saveSession: vi.fn(async (...args: Parameters<typeof actual.saveSession>) => {
      order.push("saveSession");
      hooks.sessionAttempts.push(args[0]);
      if (hooks.saveSession) return hooks.saveSession(args[0]);
      return actual.saveSession(...args);
    }),
    saveCtrlSession: vi.fn(async () => {
      order.push("saveCtrlSession");
    }),
    startAutoSave: vi.fn(),
    isAutoSaveRunning: vi.fn(() => false),
    stopAutoSave: vi.fn(),
  };
});

vi.mock("../../src/server/file-io/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/file-io/index.js")>();
  return {
    ...actual,
    atomicWrite: vi.fn(async (...args: Parameters<typeof actual.atomicWrite>) => {
      order.push("atomicWrite");
      if (hooks.atomicWrite) return hooks.atomicWrite(args[0]);
      return actual.atomicWrite(...args);
    }),
    atomicWriteBuffer: vi.fn(async (...args: Parameters<typeof actual.atomicWriteBuffer>) => {
      order.push("atomicWriteBuffer");
      if (hooks.atomicWrite) return hooks.atomicWrite(args[0]);
      return actual.atomicWriteBuffer(...args);
    }),
  };
});

vi.mock("../../src/server/file-watcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/file-watcher.js")>();
  return {
    ...actual,
    suppressNextChange: vi.fn(() => order.push("suppressNextChange")),
    recordSelfWrite: vi.fn(() => order.push("recordSelfWrite")),
    rearmWatch: vi.fn(() => order.push("rearmWatch")),
    unwatchFile: vi.fn(),
    watchFile: vi.fn(() => order.push("watchFile")),
  };
});

// Deliberately NOT `importOriginal`. This module sits in a cycle with
// `reload-family` (via `mcp/annotations`), and loading the real graph from
// inside the factory binds `reload-family` to the UNMOCKED `reloadFromDisk`
// while a fresh `import()` still hands back the mock — a mock that reports
// itself installed and is never called. All five exports are therefore
// hand-stubbed.
vi.mock("../../src/server/documents/watcher.js", () => ({
  // MUST return true: a bare `vi.fn()` returns undefined and
  // `reload-family.ts` then throws RELOAD_IN_PROGRESS.
  reloadFromDisk: vi.fn(async () => {
    order.push("reloadFromDisk");
    return true;
  }),
  wireFileWatcher: vi.fn(() => order.push("wireFileWatcher")),
  isReloadInProgress: vi.fn(() => false),
  acquireReloadGuard: vi.fn(() => true),
  releaseReloadGuard: vi.fn(),
}));

vi.mock("../../src/server/file-io/doc-backup.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  snapshotBeforeFirstWrite: vi.fn().mockResolvedValue("written"),
  // The restore path resolves its snapshot through this; pointing it at a temp
  // file is cheaper than building a real doc-backup tree and does not weaken
  // anything these cases assert (the ordering of the write triple).
  docBackupSnapshotPath: vi.fn(() => hooks.backupPath),
}));

import { ensureAutoSave } from "../../src/server/documents/autosave.js";
import { isDirty, markDirty } from "../../src/server/documents/dirty.js";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { restoreDocumentFromBackup } from "../../src/server/documents/reload-family.js";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import {
  autoSaveAllToDisk,
  saveCurrentSession,
  saveDocumentAsToDisk,
  saveDocumentToDisk,
} from "../../src/server/mcp/document-service.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../src/server/notifications.js";
import { deleteSession, sessionKey, startAutoSave } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

const ORIGINAL_PLATFORM = process.platform;

function stubLinux(): void {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
}

let tmpDir: string;

function openMd(
  name: string,
  contents = "# hello\n",
): { id: string; filePath: string; doc: Y.Doc } {
  const filePath = path.join(tmpDir, name);
  fsSync.writeFileSync(filePath, contents);
  const id = docIdFromPath(filePath);
  addDoc(id, { id, filePath, format: "md", readOnly: false, source: "file" });
  const doc = getOrCreateDocument(id);
  const frag = doc.getXmlFragment("default");
  if (frag.length === 0) {
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("hello")]);
      frag.insert(0, [p]);
    }, "internal");
  }
  markDirty(id);
  return { id, filePath, doc };
}

function sessionFileFor(filePath: string): string {
  return path.join(sessionDir, `${sessionKey(filePath)}.json`);
}

const openedIds: string[] = [];

beforeEach(() => {
  order.length = 0;
  hooks.saveSession = null;
  hooks.atomicWrite = null;
  hooks.sessionAttempts.length = 0;
  hooks.backupPath = "";
  resetNotifications();
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "tandem-save-order-docs-"));
  fsSync.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  restorePlatform();
  for (const id of openedIds.splice(0)) removeDoc(id);
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

function track<T extends { id: string }>(opened: T): T {
  openedIds.push(opened.id);
  return opened;
}

describe("#1750 — saveSession is last, and its failure does not un-save the document", () => {
  it("stamps, cleans and clears the conflict even when saveSession throws", async () => {
    const { id, filePath, doc } = track(openMd("a.md"));
    hooks.saveSession = async () => {
      throw Object.assign(new Error("ENAMETOOLONG"), { code: "ENAMETOOLONG" });
    };

    const result = await saveDocumentToDisk(id, "manual");

    expect(result.status).toBe("saved");
    expect(fsSync.readFileSync(filePath, "utf-8")).toContain("hello");
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBeTypeOf("number");
    expect(isDirty(id)).toBe(false);
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT)).toBeUndefined();
    // Best-effort delete: a stale record can be `dirty: true` from the last
    // 60 s tick, and `maybeRestoreSession` restores a dirty session regardless
    // of `sourceFileChanged` — so leaving it would restore stale content over
    // correctly-saved disk bytes.
    expect(fsSync.existsSync(sessionFileFor(filePath))).toBe(false);
  });

  it("a stale dirty session for the path is removed, so a reopen would not prompt", async () => {
    const { id, filePath } = track(openMd("b.md"));
    // A previous 60 s tick's record, dirty and therefore restore-over-disk.
    fsSync.writeFileSync(
      sessionFileFor(filePath),
      JSON.stringify({
        filePath,
        format: "md",
        ydocState: "",
        sourceFileMtime: 0,
        lastAccessed: 1,
        dirty: true,
      }),
    );
    hooks.saveSession = async () => {
      throw new Error("nope");
    };

    await saveDocumentToDisk(id, "manual");
    expect(fsSync.existsSync(sessionFileFor(filePath))).toBe(false);
  });

  it("the next autosave tick does not re-write the DOCUMENT (the stamp landed)", async () => {
    const { id } = track(openMd("c.md"));
    hooks.saveSession = async () => {
      throw new Error("nope");
    };
    await saveDocumentToDisk(id, "manual");

    // Restore the passthrough BEFORE the tick: with the mock still throwing the
    // assertion is vacuous. The session file IS written by this tick, and that
    // is what makes the case non-vacuous — the document stays unwritten only
    // because the stamp landed and `markCleanIfUnchanged` ran.
    hooks.saveSession = null;
    order.length = 0;
    await autoSaveAllToDisk();
    expect(order.filter((o) => o === "atomicWrite")).toHaveLength(0);
  });

  it("twin: when atomicWrite throws there is no stamp, the doc stays dirty, and saveSession is never called", async () => {
    const { id, doc } = track(openMd("d.md"));
    hooks.atomicWrite = async () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    };

    const result = await saveDocumentToDisk(id, "manual");
    expect(result.status).toBe("error");
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBeUndefined();
    expect(isDirty(id)).toBe(true);
    expect(order).not.toContain("saveSession");
    // …and the re-arm STILL ran, from the inner finally. Without it the
    // arrival counter stays armed for 2 s on a live POSIX watcher and the next
    // external atomic save is swallowed.
    expect(order).toContain("rearmWatch");
  });

  it("the session record is written AFTER the external-conflict flag is deleted", async () => {
    const { id, filePath, doc } = track(openMd("e.md"));
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    // A `diskChanged: false` conflict with an explicit source, per the
    // "unsaved-restore" shape. The natural `{kind:"external-edit",
    // diskChanged:true}` seed makes `saveDocumentToDisk` return
    // `{status:"skipped", skipCode:"EXTERNAL_CONFLICT"}` outright, and the
    // ordering assertion never evaluates.
    doc.transact(() => {
      meta.set(Y_MAP_EXTERNAL_CONFLICT, {
        kind: "unsaved-restore",
        diskChanged: false,
        detectedAt: 1,
      } satisfies ExternalConflictState);
    }, "internal");

    // Spied on the METHOD, not via an observer: deleting an absent key emits no
    // Yjs event, so an observer-based index check reads -1 on an unseeded doc
    // and passes the very fold it exists to catch.
    const deleteSpy = vi.spyOn(meta, "delete").mockImplementation(function (
      this: Y.Map<unknown>,
      key: string,
    ) {
      if (key === Y_MAP_EXTERNAL_CONFLICT) order.push("deleteConflict");
      return Y.Map.prototype.delete.call(this, key);
    } as typeof meta.delete);

    try {
      const result = await saveDocumentToDisk(id, "manual");
      expect(result.status).toBe("saved");
      expect(order.indexOf("deleteConflict")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("deleteConflict")).toBeLessThan(order.indexOf("saveSession"));
    } finally {
      deleteSpy.mockRestore();
      await deleteSession(filePath);
    }
  });

  it("a conflict that lands DURING the write is carried into the persisted record", async () => {
    // The ordering test above cannot see this: there the guarded delete has
    // already cleared the map, so `readPendingConflict` is undefined whether or
    // not the argument is passed. The discriminating case is the one where the
    // guarded delete does NOT fire, because a DIFFERENT value arrived mid-write.
    const { id, filePath, doc } = track(openMd("f.md"));
    const landed: ExternalConflictState = {
      kind: "external-edit",
      diskChanged: true,
      detectedAt: 4242,
    };
    // Scoped to the DOCUMENT write: the session write below goes through the
    // same mocked `atomicWrite`, and intercepting it would leave no record to
    // read back.
    hooks.atomicWrite = async (target) => {
      if (target !== filePath) throw new Error(`unexpected write to ${target}`);
      doc.transact(() => {
        doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_EXTERNAL_CONFLICT, landed);
      }, "internal");
      hooks.atomicWrite = null;
    };

    const result = await saveDocumentToDisk(id, "manual");
    expect(result.status).toBe("saved");

    const record = JSON.parse(fsSync.readFileSync(sessionFileFor(filePath), "utf-8"));
    // `toEqual`, never `toBe`: `readPendingConflict` routes through
    // `narrowConflict`, which builds a fresh object on every call.
    expect(record.conflict).toEqual(landed);
    await deleteSession(filePath);
  });
});

describe("#1750 — one failing document does not take the loop with it", () => {
  it("autosave: the other documents are written, and autoSaveAllToDisk still runs", async () => {
    const a = track(openMd("iso-a.md"));
    const b = track(openMd("iso-b.md"));
    const c = track(openMd("iso-c.md"));

    hooks.saveSession = (filePath) => {
      if (filePath === b.filePath) {
        throw Object.assign(new Error("ENAMETOOLONG"), { code: "ENAMETOOLONG" });
      }
    };

    let tick: (() => Promise<void>) | undefined;
    vi.mocked(startAutoSave).mockImplementation((cb) => {
      tick = cb;
    });
    ensureAutoSave();
    expect(tick).toBeDefined();
    await tick!();

    // Every document was attempted — the loop did not abort on the middle one.
    expect(hooks.sessionAttempts.slice(0, 3).sort()).toEqual(
      [a.filePath, b.filePath, c.filePath].sort(),
    );
    expect(getBuffer().filter((n) => n.dedupKey === "session-save-failed")).toHaveLength(1);
    // The post-loop survivor, asserted through the REAL flush rather than a
    // spy: all three documents are dirty, so `autoSaveAllToDisk` writes all
    // three. Before the fix one ENAMETOOLONG suppressed the entire 60 s disk
    // flush for EVERY open document until that tab was closed — which is why
    // #1750 reads as "cannot save".
    expect(order.filter((o) => o === "atomicWrite")).toHaveLength(3);
  });

  it("shutdown: saveCtrlSession still runs after a failing document", async () => {
    track(openMd("sd-a.md"));
    track(openMd("sd-b.md"));
    track(openMd("sd-c.md"));

    hooks.saveSession = (filePath) => {
      if (filePath.endsWith("sd-b.md")) throw new Error("ENAMETOOLONG");
    };

    await saveCurrentSession();

    expect(hooks.sessionAttempts).toHaveLength(3);
    // One ENAMETOOLONG in this loop used to lose the CTRL_ROOM chat log at exit.
    expect(order).toContain("saveCtrlSession");
    expect(getBuffer().filter((n) => n.dedupKey === "session-save-failed")).toHaveLength(1);
  });
});

describe("#1749 — the re-arm is unconditional, per required function", () => {
  it("saveDocumentToDisk: rearmWatch runs from the finally and precedes saveSession", async () => {
    stubLinux();
    expect(process.platform).toBe("linux");
    const { id } = track(openMd("r1.md"));

    await saveDocumentToDisk(id, "manual");

    expect(order).toEqual(
      expect.arrayContaining([
        "suppressNextChange",
        "atomicWrite",
        "recordSelfWrite",
        "rearmWatch",
      ]),
    );
    expect(order.indexOf("recordSelfWrite")).toBeLessThan(order.indexOf("rearmWatch"));
    // Not merely "inside" the function: `if (cond) rearmWatch(p)`,
    // `queueMicrotask(() => rearmWatch(p))` and `try { rearmWatch(p) } catch {}`
    // all pass a loose phrasing, and each sibling branch of the two save arms
    // rests on this check alone.
    expect(order.indexOf("rearmWatch")).toBeLessThan(order.indexOf("saveSession"));
  });

  it("saveDocumentToDisk: a throwing write still re-arms, and a later rename still schedules", async () => {
    stubLinux();
    const { id } = track(openMd("r2.md"));
    hooks.atomicWrite = async () => {
      throw new Error("EIO");
    };

    await saveDocumentToDisk(id, "manual");
    expect(order).toContain("rearmWatch");
    expect(order.indexOf("atomicWrite")).toBeLessThan(order.indexOf("rearmWatch"));
  });

  it("saveDocumentAsToDisk: rearmWatch runs from the finally, and the watcher is wired AFTER it", async () => {
    stubLinux();
    const target = path.join(tmpDir, "as-target.md");
    const id = docIdFromPath(path.join(tmpDir, "src.md"));
    fsSync.writeFileSync(path.join(tmpDir, "src.md"), "x");
    addDoc(id, {
      id,
      filePath: "upload://abc/src.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    openedIds.push(id);
    const doc = getOrCreateDocument(id);
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("as-content")]);
      doc.getXmlFragment("default").insert(0, [p]);
    }, "internal");

    const result = await saveDocumentAsToDisk(id, target, "md");
    expect(result.status).toBe("saved");
    expect(order.indexOf("recordSelfWrite")).toBeLessThan(order.indexOf("rearmWatch"));
    // Placed BEFORE the write, `fs.watch` on a not-yet-existing path throws
    // ENOENT and both `watchFile` and `wireFileWatcher` swallow it — two
    // catches, so misplacement is silent. Only the order proves it.
    expect(order.indexOf("atomicWrite")).toBeLessThan(order.indexOf("wireFileWatcher"));
    expect(order.indexOf("rearmWatch")).toBeLessThan(order.indexOf("wireFileWatcher"));
  });

  it("saveDocumentAsToDisk: a throwing write still re-arms (the watcher half is unobservable here)", async () => {
    // Only the spy call is asserted. Nothing watches the new path when the
    // write runs, and `wireFileWatcher` comes after the inner try/finally that
    // a throw leaves through — so `rearmWatch(resolved)` finds no entry and no
    // `rename` can schedule anything. A fixture that pre-watches the target to
    // make the second half observable would pin a state the product never
    // reaches; the asymmetry is deliberate.
    stubLinux();
    const target = path.join(tmpDir, "as-throw.md");
    const id = docIdFromPath(path.join(tmpDir, "src2.md"));
    addDoc(id, {
      id,
      filePath: "upload://def/src2.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    openedIds.push(id);
    getOrCreateDocument(id);
    hooks.atomicWrite = async () => {
      throw new Error("EIO");
    };

    const result = await saveDocumentAsToDisk(id, target, "md");
    expect(result.status).toBe("error");
    expect(order).toContain("rearmWatch");
    expect(order).not.toContain("wireFileWatcher");
  });

  it("restoreDocumentFromBackup: rearmWatch runs from the finally and precedes reloadFromDisk", async () => {
    stubLinux();
    const { id, filePath } = track(openMd("restore.md", "original\n"));
    hooks.backupPath = path.join(tmpDir, "backup.md");
    fsSync.writeFileSync(hooks.backupPath, "restored bytes\n");

    await restoreDocumentFromBackup(id, "backup.md");

    expect(order.indexOf("suppressNextChange")).toBeLessThan(order.indexOf("atomicWrite"));
    expect(order.indexOf("recordSelfWrite")).toBeLessThan(order.indexOf("rearmWatch"));
    expect(order.indexOf("rearmWatch")).toBeLessThan(order.indexOf("reloadFromDisk"));
    expect(fsSync.readFileSync(filePath, "utf-8")).toBe("restored bytes\n");
  });

  it("restoreDocumentFromBackup: a throwing write still re-arms", async () => {
    stubLinux();
    const { id } = track(openMd("restore-throw.md"));
    hooks.backupPath = path.join(tmpDir, "backup2.md");
    fsSync.writeFileSync(hooks.backupPath, "bytes\n");
    hooks.atomicWrite = async () => {
      throw new Error("EIO");
    };

    await expect(restoreDocumentFromBackup(id, "backup2.md")).rejects.toThrow();
    expect(order).toContain("rearmWatch");
    expect(order).not.toContain("reloadFromDisk");
  });
});
