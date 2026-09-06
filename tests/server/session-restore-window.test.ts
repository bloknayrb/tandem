import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Same isolation shape as session-restore.test.ts: a unique SESSION_DIR per
// file, so one case's leftovers cannot be restored by the next.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...original,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-window-${cryptoMod.randomUUID()}`),
  };
});

vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { removeDoc } from "../../src/server/documents/registry-testing.js";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, restoreOpenDocuments } from "../../src/server/mcp/document-service.js";
import { SESSION_DIR } from "../../src/server/platform";
import {
  listSessionFilePaths,
  saveSession,
  sessionKey,
  stopAutoSave,
} from "../../src/server/session/manager.js";

/**
 * The bound on what startup reopens.
 *
 * Origin: a Tauri update restarted the app and it reopened ~40 documents the
 * user had never opened — vitest fixtures that had leaked into the real session
 * store. `restoreOpenDocuments` reopened every session file on disk, and
 * because a restored document is autosaved like any other, each leaked session
 * kept refreshing its own mtime and the 30-day GC could never reclaim it.
 *
 * Every case here seeds through `saveSession` and then edits the record on
 * disk, so no fixture can drift from the real on-disk schema.
 */
const docsRoot = path.join(os.tmpdir(), `tandem-test-window-docs-${process.pid}`);

async function writeDoc(name: string): Promise<string> {
  await fs.mkdir(docsRoot, { recursive: true });
  const p = path.join(docsRoot, name);
  await fs.writeFile(p, `# ${name}\n`, "utf-8");
  return p;
}

/** Seed a session, then rewrite the fields the restore bound reads. */
async function seedSession(
  filePath: string,
  patch: { lastAccessed?: number; dirty?: boolean; conflict?: unknown },
): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "seeded");
  await saveSession(filePath, "md", doc);
  const file = path.join(SESSION_DIR, `${sessionKey(filePath)}.json`);
  const data = JSON.parse(await fs.readFile(file, "utf-8"));
  Object.assign(data, patch);
  await fs.writeFile(file, JSON.stringify(data), "utf-8");
}

const NOW = Date.now();
const MINUTES = 60_000;

beforeEach(async () => {
  await fs.mkdir(SESSION_DIR, { recursive: true });
});

afterEach(async () => {
  // `openFromRestore` -> `openFromDisk` arms `ensureAutoSave()`, a real 60s
  // `setInterval` that is not `unref`'d and that nothing here disarms. Under
  // today's default `isolate: true` each file gets its own process, so a leaked
  // timer dies with it — this is insurance against that default being flipped,
  // when the timer would otherwise fire during a LATER test file and write to
  // disk on behalf of a suite that has finished.
  stopAutoSave();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fs.rm(SESSION_DIR, { recursive: true, force: true });
  await fs.mkdir(SESSION_DIR, { recursive: true });
});

// Not `afterEach`: the fixture documents are reused across cases and cost
// nothing to keep for the file's lifetime. Leaving them behind entirely is what
// produced the tens of thousands of `tandem-test-*` directories this PR's own
// commit message complains about.
afterAll(async () => {
  await fs.rm(docsRoot, { recursive: true, force: true });
});

describe("restoreOpenDocuments restore window", () => {
  it("reopens the working set and leaves a stale foreign session closed", async () => {
    const mine = await writeDoc("mine.md");
    const foreign = await writeDoc("foreign.md");
    await seedSession(mine, { lastAccessed: NOW });
    await seedSession(foreign, { lastAccessed: NOW - 3 * 24 * 60 * MINUTES });

    const count = await restoreOpenDocuments(null);

    const open = new Set(getOpenDocs().keys());
    expect(open.has(docIdFromPath(mine))).toBe(true);
    expect(open.has(docIdFromPath(foreign))).toBe(false);
    expect(count).toBe(1);
  });

  it("keeps the skipped session on disk and in the listing", async () => {
    // The Sessions UI reads the same list. A session we decline to REOPEN must
    // still be offered, or a recoverable document reads as data loss.
    const foreign = await writeDoc("still-listed.md");
    const mine = await writeDoc("current.md");
    await seedSession(mine, { lastAccessed: NOW });
    await seedSession(foreign, { lastAccessed: NOW - 3 * 24 * 60 * MINUTES });

    await restoreOpenDocuments(null);

    const listed = (await listSessionFilePaths()).map((e) => e.filePath);
    expect(listed).toContain(foreign);
    await expect(
      fs.stat(path.join(SESSION_DIR, `${sessionKey(foreign)}.json`)),
    ).resolves.toBeTruthy();
  });

  it("reopens an OLD session that holds unsaved edits", async () => {
    // `closeDocumentById` deliberately keeps this session — it is the only copy
    // of those edits — and its lastAccessed is frozen at close time, so the
    // window alone would discard exactly the record that was kept on purpose.
    const kept = await writeDoc("dirty-old.md");
    const mine = await writeDoc("current2.md");
    await seedSession(mine, { lastAccessed: NOW });
    await seedSession(kept, { lastAccessed: NOW - 30 * 24 * 60 * MINUTES, dirty: true });

    await restoreOpenDocuments(null);

    expect(getOpenDocs().has(docIdFromPath(kept))).toBe(true);
  });

  it("reopens an OLD session carrying an unresolved external conflict", async () => {
    const kept = await writeDoc("conflict-old.md");
    const mine = await writeDoc("current3.md");
    await seedSession(mine, { lastAccessed: NOW });
    await seedSession(kept, {
      lastAccessed: NOW - 30 * 24 * 60 * MINUTES,
      conflict: { kind: "external-edit", diskChanged: true, detectedAt: NOW - 1000 },
    });

    await restoreOpenDocuments(null);

    expect(getOpenDocs().has(docIdFromPath(kept))).toBe(true);
  });

  it("does NOT exempt an old session whose conflict field is junk", async () => {
    // The negative twin of the case above, and the one that decides whether the
    // exemption is a hole. `holdsUnsavedWork` is the single escape from the
    // window, so a record that satisfies it is reopened and re-autosaved every
    // boot forever — the immortal-session cycle this bound exists to break. A
    // bare `!= null` hands that to `{}`, which no shipped writer produces but
    // any hand-edited or half-written record can.
    const junk = await writeDoc("junk-conflict.md");
    const mine = await writeDoc("current4.md");
    await seedSession(mine, { lastAccessed: NOW });
    await seedSession(junk, { lastAccessed: NOW - 30 * 24 * 60 * MINUTES, conflict: {} });

    await restoreOpenDocuments(null);

    expect(getOpenDocs().has(docIdFromPath(junk))).toBe(false);
  });

  it("ignores a future timestamp instead of discarding the working set", async () => {
    // One skewed clock (NTP correction, a session copied from another machine)
    // would otherwise put `newest` ahead of real time and push every genuine
    // session outside the window — the user restarts and gets one tab back.
    const skewed = await writeDoc("from-the-future.md");
    const a = await writeDoc("real-a.md");
    const b = await writeDoc("real-b.md");
    await seedSession(skewed, { lastAccessed: NOW + 5 * 24 * 60 * MINUTES });
    await seedSession(a, { lastAccessed: NOW });
    await seedSession(b, { lastAccessed: NOW - 2 * MINUTES });

    await restoreOpenDocuments(null);

    const open = new Set(getOpenDocs().keys());
    expect(open.has(docIdFromPath(a)), "a real session must survive the skew").toBe(true);
    expect(open.has(docIdFromPath(b)), "a real session must survive the skew").toBe(true);
  });

  it("refreshes the timestamp of a session that failed to reopen for a non-ENOENT reason", async () => {
    // Without the refresh this session keeps its old stamp while every session
    // that DID reopen is autosaved forward, so the next boot finds it outside
    // the window and never retries it — a momentary antivirus lock costing the
    // tab permanently. `EACCES` stands in for that class here.
    const locked = await writeDoc("locked.md");
    const mine = await writeDoc("current5.md");
    const stale = NOW - 10 * MINUTES;
    await seedSession(mine, { lastAccessed: NOW });
    await seedSession(locked, { lastAccessed: stale });

    const realOpen = (await import("../../src/server/documents/open.js")).openFromRestore;
    const spy = vi
      .spyOn(await import("../../src/server/documents/open.js"), "openFromRestore")
      .mockImplementation(async (args: Parameters<typeof realOpen>[0]) => {
        if (args.filePath === locked) {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realOpen(args);
      });

    try {
      await restoreOpenDocuments(null);
    } finally {
      spy.mockRestore();
    }

    const record = JSON.parse(
      await fs.readFile(path.join(SESSION_DIR, `${sessionKey(locked)}.json`), "utf-8"),
    );
    expect(
      record.lastAccessed,
      "a transient failure must not freeze the session out of the next window",
    ).toBeGreaterThan(stale);
  });

  it("restores a whole working set that is old in absolute terms", async () => {
    // The bound is relative to the NEWEST session, never to the wall clock —
    // otherwise a month away from Tandem loses every tab.
    const old = NOW - 60 * 24 * 60 * MINUTES;
    const a = await writeDoc("a-old.md");
    const b = await writeDoc("b-old.md");
    await seedSession(a, { lastAccessed: old });
    await seedSession(b, { lastAccessed: old - 2 * MINUTES });

    const count = await restoreOpenDocuments(null);

    expect(count).toBe(2);
  });
});
