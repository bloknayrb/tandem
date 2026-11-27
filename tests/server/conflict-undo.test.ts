/**
 * ADR-057, PR 3: undo for the external-conflict banner.
 *  - Reload keeps the unsaved edits it discards as a backup first (`actor:
 *    "user"`: never unseen, so no kept-edits banner); a refused keep refuses the
 *    reload; `discardUnsavedEdits` is the banner's "Reload anyway".
 *  - Keep keeps the version on disk as a backup first, every time, and says so
 *    when it could not.
 *  - The route: strict flag, 409 BACKUP_FAILED.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-vh-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});
vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
  recordSelfWrite: vi.fn(),
}));
vi.mock(import("../../src/server/notifications.js"), () => ({ pushNotification: vi.fn() }));
vi.mock(import("../../src/server/integrations/acl-win.js"), () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import type { Request, Response } from "express";
import { flagExternalConflict } from "../../src/server/documents/conflict.js";
import { markDirty } from "../../src/server/documents/dirty.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { resolveExternalConflict } from "../../src/server/documents/reload-family.js";
import {
  _resetDocBackupGateForTests,
  docBackupSnapshotPath,
  docBackupsRoot,
  keptEditsNotice,
  listDocBackups,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { handleResolveExternalConflict } from "../../src/server/mcp/routes/external-conflict.js";
import { pushNotification } from "../../src/server/notifications.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_DOCUMENT_META, Y_MAP_EXTERNAL_CONFLICT } from "../../src/shared/constants.js";
import { withMcp } from "../../src/shared/origins.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

const pushNotificationMock = vi.mocked(pushNotification);
let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  _resetDocBackupGateForTests();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-cu-"));
  await fs.rm(docBackupsRoot(resolveAppDataDir()), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

const appData = () => resolveAppDataDir();

/** A `.md` open with unsaved edits, the file then rewritten on disk, and the conflict flagged. */
async function conflicted(name: string, opts: { readOnly?: boolean } = {}) {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, "first version\n");
  const opened = await openFromDisk(filePath, opts.readOnly ? { readOnly: true } : {});
  const id = opened.documentId;
  const doc = getOrCreateDocument(id);
  const adapter = getAdapter("md");
  const prepared = await adapter.parse("my unsaved words\n");
  withMcp(doc, () => adapter.apply(doc, prepared, { fileName: name }));
  markDirty(id);
  await fs.writeFile(filePath, "the external version\n");
  const detectedAt = Date.now();
  flagExternalConflict(id, doc, filePath, { kind: "external-edit", diskChanged: true, detectedAt });
  return { filePath, id, doc, detectedAt };
}

async function kinds(filePath: string) {
  const listed = await listDocBackups(filePath, appData());
  return Promise.all(
    listed.map(async (b) => ({
      kind: b.kind,
      text: await fs.readFile(docBackupSnapshotPath(filePath, appData(), b.name)!, "utf-8"),
    })),
  );
}

function mockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

const req = (body: unknown): Request =>
  ({
    headers: { origin: "http://127.0.0.1:5173" },
    socket: { remoteAddress: "127.0.0.1" },
    query: {},
    body,
  }) as unknown as Request;

describe("Reload keeps the unsaved edits first", () => {
  it("keeps them as an unsaved backup, raises no kept-edits banner, and reloads", async () => {
    const { filePath, id, doc } = await conflicted("reload.md");

    const result = await resolveExternalConflict(id, "reload");

    expect(extractText(doc)).toContain("the external version");
    expect(result?.unsavedEditsKept?.name).toMatch(/-unsaved\.md$/);
    const backups = await kinds(filePath);
    expect(backups.find((b) => b.kind === "unsaved")?.text).toContain("my unsaved words");
    expect(
      await keptEditsNotice(filePath, appData(), await listDocBackups(filePath, appData())),
    ).toBeNull();
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "file-reloaded",
        message: expect.stringContaining("kept as a backup in Version history"),
      }),
    );
  });

  it("refuses with BACKUP_FAILED, leaving the edits and the conflict in place, when they can't be kept", async () => {
    const { id, doc } = await conflicted("full.md");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi
      .spyOn(store, "snapshotUnsavedEdits")
      .mockResolvedValue({ outcome: "skipped-size-cap" });
    try {
      await expect(resolveExternalConflict(id, "reload")).rejects.toMatchObject({
        code: "BACKUP_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
    expect(extractText(doc)).toContain("my unsaved words");
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT)).toBeDefined();
  });

  it("discardUnsavedEdits reloads without keeping them (Reload anyway)", async () => {
    const { filePath, id, doc } = await conflicted("anyway.md");

    await resolveExternalConflict(id, "reload", undefined, { discardUnsavedEdits: true });

    expect(extractText(doc)).toContain("the external version");
    expect((await kinds(filePath)).filter((b) => b.kind === "unsaved")).toEqual([]);
  });

  it("does not reload when a newer conflict replaced the one clicked on during the keep", async () => {
    const { id, doc, filePath, detectedAt } = await conflicted("newer.md");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const real = store.snapshotUnsavedEdits;
    let kept = false;
    const spy = vi.spyOn(store, "snapshotUnsavedEdits").mockImplementation(async (...args) => {
      const r = await real(...args);
      kept = true;
      flagExternalConflict(id, doc, filePath, {
        kind: "external-edit",
        diskChanged: true,
        detectedAt: detectedAt + 1,
      });
      return r;
    });
    try {
      await resolveExternalConflict(id, "reload", detectedAt);
    } finally {
      spy.mockRestore();
    }
    expect(kept).toBe(true);
    expect(extractText(doc)).toContain("my unsaved words");
  });

  it("a read-only document keeps nothing (the banner says Reload discards)", async () => {
    const { filePath, id } = await conflicted("ro.md", { readOnly: true });

    const result = await resolveExternalConflict(id, "reload");

    expect(result?.unsavedEditsKept).toBeUndefined();
    expect((await kinds(filePath)).filter((b) => b.kind === "unsaved")).toEqual([]);
  });
});

describe("Keep keeps the version on disk first", () => {
  it("snapshots the external version even when the run's gate was spent", async () => {
    const { filePath, id } = await conflicted("keep.md");
    // An earlier save already spent the once-per-run gate on the first version.
    await snapshotBeforeFirstWrite(filePath, { appDataDir: appData() });

    const result = await resolveExternalConflict(id, "keep");

    expect(result?.diskVersionKept).toBe(true);
    const disk = (await kinds(filePath)).filter((b) => b.kind === "disk").map((b) => b.text);
    expect(disk).toContain("the external version\n");
  });

  it("proceeds, and says so, when the disk version can't be kept", async () => {
    const { id, doc } = await conflicted("keep-fail.md");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi.spyOn(store, "snapshotBeforeFirstWrite").mockResolvedValue("skipped-size-cap");
    let result: Awaited<ReturnType<typeof resolveExternalConflict>>;
    try {
      result = await resolveExternalConflict(id, "keep");
    } finally {
      spy.mockRestore();
    }
    expect(result?.diskVersionKept).toBe(false);
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_EXTERNAL_CONFLICT)).toBeUndefined();
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("could not be kept as a backup"),
      }),
    );
  });
});

describe("POST /api/external-conflict/resolve", () => {
  it("answers 409 BACKUP_FAILED in the editor's voice when the edits can't be kept", async () => {
    const { id } = await conflicted("route-full.md");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi.spyOn(store, "snapshotUnsavedEdits").mockResolvedValue({ outcome: "failed" });
    try {
      const res = mockRes();
      await handleResolveExternalConflict(req({ documentId: id, choice: "reload" }), res);
      expect(res._status).toBe(409);
      const body = res._json as { error: string; message: string };
      expect(body.error).toBe("BACKUP_FAILED");
      expect(body.message).not.toMatch(/tandem_/);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a discardUnsavedEdits that is not a boolean, or with Keep", async () => {
    const { id, doc } = await conflicted("route-strict.md");
    for (const body of [
      { documentId: id, choice: "reload", discardUnsavedEdits: "true" },
      { documentId: id, choice: "reload", discardUnsavedEdits: 1 },
      { documentId: id, choice: "keep", discardUnsavedEdits: true },
    ]) {
      const res = mockRes();
      await handleResolveExternalConflict(req(body), res);
      expect(res._status, JSON.stringify(body)).toBe(400);
    }
    expect(extractText(doc)).toContain("my unsaved words");
  });

  it("returns what it kept", async () => {
    const { id } = await conflicted("route-ok.md");
    const res = mockRes();
    await handleResolveExternalConflict(req({ documentId: id, choice: "reload" }), res);
    expect(res._status).toBe(200);
    expect((res._json as { unsavedEditsKept?: { name: string } }).unsavedEditsKept?.name).toMatch(
      /-unsaved\.md$/,
    );
  });
});
