import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { listSessionFilePaths, saveSession, sessionKey } from "../../src/server/session/manager.js";

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
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fs.rm(SESSION_DIR, { recursive: true, force: true });
  await fs.mkdir(SESSION_DIR, { recursive: true });
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
