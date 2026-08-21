/**
 * Read-only survives a session restore.
 *
 * A document opened read-only (Settings → View Changelog) came back writable
 * after a restart: `SessionData` had no `readOnly` field, `listSessionFilePaths`
 * projected the record to `{filePath, lastAccessed}`, and `restoreOpenDocuments`
 * called `openFileByPath(filePath)` with no options — so every restored document
 * took `resolveAndValidatePath`'s hardcoded `readOnly = false`.
 *
 * The flag cannot be recovered from the persisted `ydocState`: `writeDocMeta`
 * deliberately tombstones and overwrites `documentMeta.readOnly` on every open so
 * a stale session's Y.Map clock can never outvote the caller. It has to travel as
 * session metadata instead, derived inside `saveSession` off the `doc` argument.
 *
 * Covered here:
 *  - round-trip: a read-only document's session records `readOnly: true`, and a
 *    writable one's record stays byte-identical to the pre-fix shape;
 *  - a legacy record (field absent) restores writable;
 *  - a record whose `readOnly` is a non-boolean truthy value restores writable —
 *    the `=== true` narrowing, same don't-trust-`JSON.parse` rule as
 *    `narrowConflict`;
 *  - autosave refuses to write a restored read-only document back to disk.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-readonly-restore-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

// The real watcher would leave fs handles open across the suite.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

import * as Y from "yjs";
import { markDirty, resetForTesting as resetDirtyState } from "../../src/server/documents/dirty.js";
import {
  autoSaveAllToDisk,
  getOpenDocs,
  restoreOpenDocuments,
} from "../../src/server/mcp/document-service.js";
import { openFileByPath } from "../../src/server/mcp/file-opener.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { listSessionFilePaths, saveSession, sessionKey } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { SessionData } from "../../src/shared/types.js";
import { clearOpenDocs } from "../helpers/doc-service.js";

let tmpDir: string;

async function writeFixture(name: string, body: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, body, "utf-8");
  return p;
}

/** Write the session for an already-open document, the way the 60s tick does. */
async function saveOpenedSession(
  filePath: string,
  opened: { documentId: string; format: string },
): Promise<void> {
  await saveSession(filePath, opened.format, getOrCreateDocument(opened.documentId));
}

/** Simulate the restart: drop all in-memory state, then restore from disk. */
async function restoreFresh(): Promise<number> {
  clearOpenDocs();
  return restoreOpenDocuments(null);
}

/** The restored open-docs registry entry for `filePath`, if it came back. */
function stateFor(filePath: string) {
  return [...getOpenDocs().values()].find((d) => d.filePath === filePath);
}

async function readSessionRecord(filePath: string): Promise<SessionData> {
  const raw = await fs.readFile(path.join(SESSION_DIR, `${sessionKey(filePath)}.json`), "utf-8");
  return JSON.parse(raw) as SessionData;
}

/** Overwrite a session record's `readOnly` with an arbitrary (untrusted) value. */
async function tamperReadOnly(filePath: string, value: unknown): Promise<void> {
  const sessionPath = path.join(SESSION_DIR, `${sessionKey(filePath)}.json`);
  const record = JSON.parse(await fs.readFile(sessionPath, "utf-8")) as Record<string, unknown>;
  if (value === undefined) delete record.readOnly;
  else record.readOnly = value;
  await fs.writeFile(sessionPath, JSON.stringify(record), "utf-8");
}

beforeEach(async () => {
  clearOpenDocs();
  resetDirtyState();
  vi.clearAllMocks();
  await fs.mkdir(SESSION_DIR, { recursive: true });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-readonly-restore-"));
});

afterEach(async () => {
  clearOpenDocs();
  // Each test owns the whole session dir — wipe it so listSessionFilePaths in
  // the next test sees only what that test wrote.
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("read-only survives a session restore", () => {
  it("records readOnly:true for a read-only document and restores it read-only", async () => {
    const filePath = await writeFixture("changelog.md", "# Changelog\n\nEntry.\n");
    const opened = await openFileByPath(filePath, { readOnly: true });
    expect(opened.readOnly).toBe(true);

    await saveOpenedSession(filePath, opened);

    expect((await readSessionRecord(filePath)).readOnly).toBe(true);

    const listed = await listSessionFilePaths();
    const entry = listed.find((r) => r.filePath === filePath);
    expect(entry?.readOnly).toBe(true);

    expect(await restoreFresh()).toBe(1);
    expect(stateFor(filePath)?.readOnly).toBe(true);
  });

  it("leaves a writable document's record byte-identical to the pre-fix shape", async () => {
    const filePath = await writeFixture("notes.md", "# Notes\n\nBody.\n");
    const opened = await openFileByPath(filePath);
    expect(opened.readOnly).toBe(false);

    await saveOpenedSession(filePath, opened);

    const record = (await readSessionRecord(filePath)) as Record<string, unknown>;
    // Absent, not `false`: the conditional spread is what keeps clean records
    // identical to what shipped before the field existed.
    expect("readOnly" in record).toBe(false);
    expect(Object.keys(record).sort()).toEqual(
      [
        "filePath",
        "format",
        "lastAccessed",
        "modelRevision",
        "sourceFileMtime",
        "ydocState",
      ].sort(),
    );
  });

  it("restores a legacy record (no readOnly field) writable", async () => {
    const filePath = await writeFixture("legacy.md", "# Legacy\n\nBody.\n");
    const opened = await openFileByPath(filePath, { readOnly: true });
    await saveOpenedSession(filePath, opened);
    // Strip the field to reproduce a record written before it existed.
    await tamperReadOnly(filePath, undefined);

    const entry = (await listSessionFilePaths()).find((r) => r.filePath === filePath);
    expect(entry?.readOnly).toBe(false);

    await restoreFresh();
    expect(stateFor(filePath)?.readOnly).toBe(false);
  });

  it.each([
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["an object", {}],
  ])("restores writable when readOnly is %s off disk", async (_label, value) => {
    const filePath = await writeFixture("tampered.md", "# Tampered\n\nBody.\n");
    const opened = await openFileByPath(filePath, { readOnly: true });
    await saveOpenedSession(filePath, opened);
    await tamperReadOnly(filePath, value);

    const entry = (await listSessionFilePaths()).find((r) => r.filePath === filePath);
    expect(entry?.readOnly).toBe(false);

    await restoreFresh();
    expect(stateFor(filePath)?.readOnly).toBe(false);
  });

  it("autosave refuses to write a restored read-only document to disk", async () => {
    const original = "# Changelog\n\nOriginal.\n";
    const filePath = await writeFixture("autosave.md", original);
    const opened = await openFileByPath(filePath, { readOnly: true });
    await saveOpenedSession(filePath, opened);

    resetDirtyState();
    await restoreFresh();

    const state = stateFor(filePath);
    expect(state).toBeDefined();
    // Dirty it so the readOnly guard — not the #851 not-dirty skip — is what
    // has to stop the write.
    const restoredDoc = getOrCreateDocument(state!.id);
    withBrowser(restoredDoc, () => {
      const fragment = restoredDoc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      const t = new Y.XmlText();
      p.insert(0, [t]);
      fragment.insert(fragment.length, [p]);
      t.insert(0, "edit that must never reach disk");
    });
    markDirty(state!.id);

    await autoSaveAllToDisk();

    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });
});
