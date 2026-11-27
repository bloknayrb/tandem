/**
 * ADR-057, PR 2: the editor's Version history.
 *
 *  - `kept-ack.json`: which `unsaved` snapshots the user has been told about
 *    (`keptEditsNotice`, `acknowledgeKeptEdits`), its prune and sweep roles.
 *  - `restoreDocumentFromBackup(…, { actor: "user" })`: the browser restore keeps
 *    the unsaved edits, says so in the user's voice, and never raises the
 *    kept-edits banner for its own keeps.
 *  - The routes: `GET /api/backups`' `keptNotice`, `POST /api/backups/restore`'s
 *    keep-by-default / `discardUnsavedEdits` / 409, and
 *    `POST /api/backups/acknowledge`.
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
import { docHash } from "../../src/server/annotations/doc-hash.js";
import { markDirty } from "../../src/server/documents/dirty.js";
import { openFromDisk, type UnsavedEditsHolder } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { restoreDocumentFromBackup } from "../../src/server/documents/reload-family.js";
import {
  _resetDocBackupGateForTests,
  acknowledgeKeptEdits,
  docBackupSnapshotPath,
  docBackupsRoot,
  keptEditsNotice,
  listDocBackups,
  MAX_DOC_BACKUPS,
  snapshotBeforeFirstWrite,
  snapshotKind,
  snapshotUnsavedEdits,
  sweepDocBackups,
} from "../../src/server/file-io/doc-backup.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { handleListBackups, handleRestoreBackup } from "../../src/server/mcp/routes/backups.js";
import { handleAcknowledgeKeptEdits } from "../../src/server/mcp/routes/backups-ack.js";
import { pushNotification } from "../../src/server/notifications.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { withMcp } from "../../src/shared/origins.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

const pushNotificationMock = vi.mocked(pushNotification);

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  _resetDocBackupGateForTests();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-vh-"));
  await fs.rm(docBackupsRoot(resolveAppDataDir()), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

const appData = () => resolveAppDataDir();
const subdirOf = (filePath: string) => path.join(docBackupsRoot(appData()), docHash(filePath));

/** Open `body` from disk, then give the document unsaved edits `edited`. */
async function openWithUnsavedEdits(name: string, body: string, edited: string) {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, body);
  const opened = await openFromDisk(filePath);
  const doc = getOrCreateDocument(opened.documentId);
  await giveEdits(opened.documentId, edited, name);
  return { filePath, id: opened.documentId, doc };
}

async function giveEdits(id: string, edited: string, name = "doc.md") {
  const doc = getOrCreateDocument(id);
  const adapter = getAdapter("md");
  const prepared = await adapter.parse(edited);
  withMcp(doc, () => adapter.apply(doc, prepared, { fileName: name }));
  markDirty(id);
}

/** A Claude-equivalent keep: `tandem_open force` with the keep holder. */
async function claudeForceOpen(filePath: string): Promise<string> {
  const holder: UnsavedEditsHolder = {};
  await openFromDisk(filePath, { force: true, keepUnsavedEdits: holder });
  if (!holder.kept) throw new Error("expected edits to be kept");
  return holder.kept.name;
}

async function noticeFor(filePath: string) {
  return keptEditsNotice(filePath, appData(), await listDocBackups(filePath, appData()));
}

async function readSnapshot(filePath: string, name: string): Promise<string> {
  return fs.readFile(docBackupSnapshotPath(filePath, appData(), name)!, "utf-8");
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

const req = (extra: Partial<Request> = {}): Request =>
  ({
    headers: { origin: "http://127.0.0.1:5173" },
    socket: { remoteAddress: "127.0.0.1" },
    query: {},
    body: {},
    ...extra,
  }) as unknown as Request;

// ---------------------------------------------------------------------------
// The ack store
// ---------------------------------------------------------------------------

describe("kept-ack.json", () => {
  it("a Claude keep is news until acknowledged, then not", async () => {
    const { filePath } = await openWithUnsavedEdits("a.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);

    const before = await noticeFor(filePath);
    expect(before).toMatchObject({ name: kept, names: [kept] });

    expect(await acknowledgeKeptEdits(filePath, appData(), [kept])).toBe(true);
    expect(await noticeFor(filePath)).toBeNull();
  });

  it("a snapshot touched after its ack (Claude kept the same edits again) is news again", async () => {
    const { filePath } = await openWithUnsavedEdits("touch.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    await acknowledgeKeptEdits(filePath, appData(), [kept]);

    const later = new Date(Date.now() + 5_000);
    await fs.utimes(docBackupSnapshotPath(filePath, appData(), kept)!, later, later);

    expect((await noticeFor(filePath))?.name).toBe(kept);
  });

  it("an ack recorded at a later clock time cannot hide a new snapshot (equality, not ordering)", async () => {
    const { filePath } = await openWithUnsavedEdits("skew.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    // A clock that ran ahead: the ack file names a far-future time for another name.
    await fs.writeFile(
      path.join(subdirOf(filePath), "kept-ack.json"),
      JSON.stringify({ acked: { "other-20990101-000000-abcdef12-unsaved.md": 4_102_444_800_000 } }),
    );
    expect((await noticeFor(filePath))?.name).toBe(kept);
  });

  it("acknowledges only names that are current unsaved snapshots; anything else is ignored", async () => {
    const { filePath } = await openWithUnsavedEdits("names.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    const disk = (await listDocBackups(filePath, appData())).find((b) => b.kind === "disk");

    expect(await acknowledgeKeptEdits(filePath, appData(), ["../../etc/passwd"])).toBe(false);
    expect(await acknowledgeKeptEdits(filePath, appData(), ["source.txt"])).toBe(false);
    if (disk) expect(await acknowledgeKeptEdits(filePath, appData(), [disk.name])).toBe(false);
    expect((await noticeFor(filePath))?.name).toBe(kept);
  });

  it("never creates the backup directory", async () => {
    const filePath = path.join(tmpDir, "none.md");
    await fs.writeFile(filePath, "x\n");
    expect(
      await acknowledgeKeptEdits(filePath, appData(), ["x-20260101-000000-abcdef12-unsaved.md"]),
    ).toBe(false);
    await expect(fs.stat(subdirOf(filePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an unreadable, oversized or malformed ack file reads as nothing acknowledged", async () => {
    const { filePath } = await openWithUnsavedEdits("garbage.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    const ackFile = path.join(subdirOf(filePath), "kept-ack.json");
    for (const body of [
      "not json",
      JSON.stringify({ acked: [kept] }),
      JSON.stringify({ acked: { [kept]: "soon" } }),
      JSON.stringify({ acked: { [kept]: -1 } }),
      "x".repeat(70 * 1024),
    ]) {
      await fs.writeFile(ackFile, body);
      expect((await noticeFor(filePath))?.name).toBe(kept);
    }
  });

  it("drops entries for snapshots no longer listed", async () => {
    const { filePath } = await openWithUnsavedEdits("drop.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    const ackFile = path.join(subdirOf(filePath), "kept-ack.json");
    await fs.writeFile(
      ackFile,
      JSON.stringify({ acked: { "gone-20200101-000000-abcdef12-unsaved.md": 1 } }),
    );
    await acknowledgeKeptEdits(filePath, appData(), [kept]);
    const written = JSON.parse(await fs.readFile(ackFile, "utf-8")) as { acked: object };
    expect(Object.keys(written.acked)).toEqual([kept]);
  });

  it("the ack file name can never pass for a snapshot", () => {
    expect(docBackupSnapshotPath("/x/doc.md", "/app", "kept-ack.json")).toBeNull();
  });

  it("the unsaved prune removes acknowledged snapshots before unacknowledged ones", async () => {
    const filePath = path.join(tmpDir, "prune.md");
    await fs.writeFile(filePath, "x\n");
    const claude = await snapshotUnsavedEdits(filePath, "claude kept this\n", {
      appDataDir: appData(),
    });
    if (claude.outcome !== "written") throw new Error("expected a write");
    // The user's own keeps after it, each acknowledged as the restore route does.
    for (let i = 0; i < MAX_DOC_BACKUPS + 1; i++) {
      const r = await snapshotUnsavedEdits(filePath, `user edits ${i}\n`, {
        appDataDir: appData(),
      });
      if (r.outcome !== "written") throw new Error("expected a write");
      await acknowledgeKeptEdits(filePath, appData(), [r.name]);
    }
    const unsaved = (await listDocBackups(filePath, appData())).filter((b) => b.kind === "unsaved");
    expect(unsaved).toHaveLength(MAX_DOC_BACKUPS);
    expect(unsaved.map((b) => b.name)).toContain(claude.name);
    expect((await noticeFor(filePath))?.name).toBe(claude.name);
  });

  it("the sweep removes the ack file with its emptied directory", async () => {
    const { filePath } = await openWithUnsavedEdits("sweep.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    await acknowledgeKeptEdits(filePath, appData(), [kept]);
    const subdir = subdirOf(filePath);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    for (const name of await fs.readdir(subdir)) {
      if (name.endsWith(".md")) await fs.utimes(path.join(subdir, name), old, old);
    }

    await sweepDocBackups(appData());

    await expect(fs.stat(subdir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// The browser restore (actor: "user")
// ---------------------------------------------------------------------------

describe('restoreDocumentFromBackup with actor: "user"', () => {
  async function withGoodSnapshot(name: string) {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: appData() });
    const [good] = await listDocBackups(filePath, appData());
    return { filePath, good };
  }

  it("keeps the unsaved edits, acknowledges them, and says so in the user's voice", async () => {
    const { filePath, good } = await withGoodSnapshot("user.md");
    const { id, doc } = await openWithUnsavedEdits("user.md", "good\n", "my edits\n");

    const result = await restoreDocumentFromBackup(id, good.name, {
      keepUnsavedEdits: true,
      actor: "user",
    });

    expect(extractText(doc)).toContain("good");
    expect(result.unsavedEditsKept).toBeDefined();
    expect(await readSnapshot(filePath, result.unsavedEditsKept!.name)).toContain("my edits");
    // No banner for the user's own keep.
    expect(await noticeFor(filePath)).toBeNull();
    const types = pushNotificationMock.mock.calls.map(([n]) => n.type);
    expect(types).not.toContain("unsaved-edits-kept");
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "file-reloaded",
        message: expect.stringContaining("Your unsaved edits were kept as a backup."),
      }),
    );
  });

  it("snapshots the bytes it overwrites even after the run's gate was spent", async () => {
    const { filePath, good } = await withGoodSnapshot("gate.md");
    await fs.writeFile(filePath, "current\n");
    const opened = await openFromDisk(filePath);

    await restoreDocumentFromBackup(opened.documentId, good.name, {
      keepUnsavedEdits: true,
      actor: "user",
    });

    const disk = (await listDocBackups(filePath, appData())).filter((b) => b.kind === "disk");
    const texts = await Promise.all(disk.map((b) => readSnapshot(filePath, b.name)));
    expect(texts).toContain("current\n");
  });

  it("a failure after keeping names Version history, not Claude's tool, and pushes no Claude notice", async () => {
    const { filePath, good } = await withGoodSnapshot("fail.md");
    const { id } = await openWithUnsavedEdits("fail.md", "good\n", "edits\n");
    const watcher = await import("../../src/server/documents/watcher.js");
    const spy = vi.spyOn(watcher, "reloadFromDisk").mockResolvedValue(false);
    try {
      const err = await restoreDocumentFromBackup(id, good.name, {
        keepUnsavedEdits: true,
        actor: "user",
      }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err?.code).toBe("RELOAD_IN_PROGRESS");
      expect(err?.message).toContain("Version history");
      expect(err?.message).not.toContain("tandem_restoreBackup");
    } finally {
      spy.mockRestore();
    }
    const types = pushNotificationMock.mock.calls.map(([n]) => n.type);
    expect(types).not.toContain("unsaved-edits-kept");
    expect(await noticeFor(filePath)).toBeNull();
  });

  it("restoring the kept edits a banner points at acknowledges them, whoever restores", async () => {
    const { filePath, id } = await openWithUnsavedEdits("back.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);
    expect((await noticeFor(filePath))?.name).toBe(kept);

    // Claude brings them back (a clean document: nothing new is kept).
    await restoreDocumentFromBackup(id, kept, { keepUnsavedEdits: true });

    expect(await noticeFor(filePath)).toBeNull();
  });

  it("a Claude restore's keep still raises the banner", async () => {
    const { filePath, good } = await withGoodSnapshot("claude.md");
    const { id } = await openWithUnsavedEdits("claude.md", "good\n", "edits\n");

    const result = await restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true });

    expect((await noticeFor(filePath))?.name).toBe(result.unsavedEditsKept?.name);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("GET /api/backups keptNotice", () => {
  it("reports the unacknowledged kept edits, and null once acknowledged", async () => {
    const { filePath, id } = await openWithUnsavedEdits("get.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);

    const res = mockRes();
    await handleListBackups(req({ query: { documentId: id } }), res);
    expect((res._json as { data: { keptNotice: { name: string } } }).data.keptNotice.name).toBe(
      kept,
    );

    await acknowledgeKeptEdits(filePath, appData(), [kept]);
    const res2 = mockRes();
    await handleListBackups(req({ query: { documentId: id } }), res2);
    expect((res2._json as { data: { keptNotice: unknown } }).data.keptNotice).toBeNull();
  });
});

describe("POST /api/backups/restore", () => {
  it("keeps the unsaved edits by default", async () => {
    const filePath = path.join(tmpDir, "route.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: appData() });
    const [good] = await listDocBackups(filePath, appData());
    const { id } = await openWithUnsavedEdits("route.md", "good\n", "my edits\n");

    const res = mockRes();
    await handleRestoreBackup(req({ body: { documentId: id, backup: good.name } }), res);

    expect(res._status).toBe(200);
    const kept = (res._json as { data: { unsavedEditsKept?: { name: string } } }).data
      .unsavedEditsKept;
    expect(kept && snapshotKind(kept.name)).toBe("unsaved");
    expect(await readSnapshot(filePath, kept!.name)).toContain("my edits");
  });

  it("discardUnsavedEdits: true keeps nothing", async () => {
    const filePath = path.join(tmpDir, "discard.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: appData() });
    const [good] = await listDocBackups(filePath, appData());
    const { id } = await openWithUnsavedEdits("discard.md", "good\n", "my edits\n");

    const res = mockRes();
    await handleRestoreBackup(
      req({ body: { documentId: id, backup: good.name, discardUnsavedEdits: true } }),
      res,
    );

    expect(res._status).toBe(200);
    const unsaved = (await listDocBackups(filePath, appData())).filter((b) => b.kind === "unsaved");
    expect(unsaved).toEqual([]);
  });

  it("refuses a discardUnsavedEdits that is not a boolean, restoring nothing", async () => {
    const { filePath, id, doc } = await openWithUnsavedEdits("strict.md", "disk\n", "my edits\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: appData() });
    const [snap] = await listDocBackups(filePath, appData());

    for (const value of ["false", "true", 1, null]) {
      const res = mockRes();
      await handleRestoreBackup(
        req({ body: { documentId: id, backup: snap.name, discardUnsavedEdits: value } }),
        res,
      );
      expect(res._status).toBe(400);
    }
    expect(extractText(doc)).toContain("my edits");
  });

  it("answers 409 BACKUP_FAILED in the editor's voice when the edits can't be kept", async () => {
    const filePath = path.join(tmpDir, "full.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: appData() });
    const [good] = await listDocBackups(filePath, appData());
    const { id, doc } = await openWithUnsavedEdits("full.md", "good\n", "precious\n");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi
      .spyOn(store, "snapshotUnsavedEdits")
      .mockResolvedValue({ outcome: "skipped-size-cap" });
    try {
      const res = mockRes();
      await handleRestoreBackup(req({ body: { documentId: id, backup: good.name } }), res);
      expect(res._status).toBe(409);
      const body = res._json as { error: string; message: string };
      expect(body.error).toBe("BACKUP_FAILED");
      expect(body.message).not.toMatch(/tandem_|ask the user/);
    } finally {
      spy.mockRestore();
    }
    expect(extractText(doc)).toContain("precious");
  });
});

describe("POST /api/backups/acknowledge", () => {
  it("acknowledges the names it is given", async () => {
    const { filePath, id } = await openWithUnsavedEdits("ack.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);

    const res = mockRes();
    await handleAcknowledgeKeptEdits(req({ body: { documentId: id, backups: [kept] } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ data: { acknowledged: true } });
    expect(await noticeFor(filePath)).toBeNull();
  });

  it("refuses a disallowed origin and a non-loopback caller before acknowledging", async () => {
    const { filePath, id } = await openWithUnsavedEdits("gate.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);

    const bad = mockRes();
    await handleAcknowledgeKeptEdits(
      req({
        headers: { origin: "http://attacker.example" },
        body: { documentId: id, backups: [kept] },
      }),
      bad,
    );
    expect(bad._status).toBe(403);

    const remote = mockRes();
    await handleAcknowledgeKeptEdits(
      req({
        socket: { remoteAddress: "192.168.1.9" } as Request["socket"],
        body: { documentId: id, backups: [kept] },
      }),
      remote,
    );
    expect(remote._status).toBe(403);

    expect((await noticeFor(filePath))?.name).toBe(kept);
  });

  it("validates its body and the document", async () => {
    const { id } = await openWithUnsavedEdits("shape.md", "disk\n", "edits\n");
    const cases: Array<[unknown, number]> = [
      [undefined, 400],
      ["text", 400],
      [{ backups: ["x"] }, 400],
      [{ documentId: "../x", backups: ["x"] }, 400],
      [{ documentId: id }, 400],
      [{ documentId: id, backups: [] }, 400],
      [{ documentId: id, backups: [1] }, 400],
      [{ documentId: id, backups: Array.from({ length: 17 }, () => "x") }, 400],
      [{ documentId: "aaaaaaaaaaaa", backups: ["x"] }, 404],
    ];
    for (const [body, status] of cases) {
      const res = mockRes();
      await handleAcknowledgeKeptEdits(req({ body } as Partial<Request>), res);
      expect(res._status, JSON.stringify(body)).toBe(status);
    }
  });

  it("an unknown name acknowledges nothing", async () => {
    const { filePath, id } = await openWithUnsavedEdits("unknown.md", "disk\n", "edits\n");
    const kept = await claudeForceOpen(filePath);

    const res = mockRes();
    await handleAcknowledgeKeptEdits(
      req({ body: { documentId: id, backups: ["nope-20260101-000000-abcdef12-unsaved.md"] } }),
      res,
    );

    expect(res._json).toEqual({ data: { acknowledged: false } });
    expect((await noticeFor(filePath))?.name).toBe(kept);
  });
});

// The edits a second Claude keep holds are reported after a first was dismissed.
describe("end to end", () => {
  it("dismiss, then a new Claude keep, shows the banner again", async () => {
    const { filePath, id } = await openWithUnsavedEdits("e2e.md", "disk 1\n", "edits 1\n");
    const first = await claudeForceOpen(filePath);
    await acknowledgeKeptEdits(filePath, appData(), [first]);

    await giveEdits(id, "edits 2\n");
    await fs.writeFile(filePath, "disk 2\n");
    const second = await claudeForceOpen(filePath);

    expect(await noticeFor(filePath)).toMatchObject({ name: second, names: [second] });
  });
});
