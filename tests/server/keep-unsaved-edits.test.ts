/**
 * ADR-057: a Claude action that discards unsaved edits keeps them as a backup
 * first — `tandem_open force` (`openFromDisk`'s `keepUnsavedEdits`), the
 * `tandem_restoreBackup` restore arm (`restoreDocumentFromBackup`'s
 * `keepUnsavedEdits`) and `tandem_close` (`closeDocumentById`'s
 * `keepUnsavedEdits`). If the backup cannot be kept, the action is refused with
 * the document untouched. A call with no option (no production caller since
 * the Version history, which passes `actor: "user"` — see
 * version-history.test.ts) keeps the pre-ADR-057 behaviour pinned below.
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
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-keep-${cryptoMod.randomUUID()}`);
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { flagExternalConflict } from "../../src/server/documents/conflict.js";
import { markDirty } from "../../src/server/documents/dirty.js";
import {
  captureAtSwap,
  keepEditsCapturedAtSwap,
  keepUnsavedEdits,
  unsavedEditsOf,
} from "../../src/server/documents/keep-unsaved.js";
import { openFromDisk, type UnsavedEditsHolder } from "../../src/server/documents/open.js";
import { clearAndReload } from "../../src/server/documents/populate.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { restoreDocumentFromBackup } from "../../src/server/documents/reload-family.js";
import { reloadFromDisk } from "../../src/server/documents/watcher.js";
import {
  _resetDocBackupGateForTests,
  docBackupSnapshotPath,
  docBackupsRoot,
  listDocBackups,
  MAX_DOC_BACKUPS,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { pushNotification } from "../../src/server/notifications.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { withMcp } from "../../src/shared/origins.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller, ownershipTestDispatch } from "../helpers/ownership-caller.js";

const pushNotificationMock = vi.mocked(pushNotification);

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
const toolHandlers = new Map<string, ToolHandler>();
registerApplyTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
    toolHandlers.set(name, (args) => asTestCaller(() => handler(args)));
  },
} as unknown as McpServer);
const restoreTool = toolHandlers.get("tandem_restoreBackup")!;

/** `tandem_open` / `tandem_close` through a real in-memory MCP server and client. */
async function callDocumentTool(name: string, args: Record<string, unknown>) {
  const { client, close } = await setupMcpServer([registerDocumentTools], {
    dispatch: ownershipTestDispatch,
  });
  try {
    return parseResult(await client.callTool({ name, arguments: args }));
  } finally {
    await close();
  }
}

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  _resetDocBackupGateForTests();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-keep-"));
  await fs.rm(docBackupsRoot(resolveAppDataDir()), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

/** Open `body` from disk, then give the document unsaved edits `edited`. */
async function openWithUnsavedEdits(name: string, body: string, edited: string) {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, body);
  const opened = await openFromDisk(filePath);
  const doc = getOrCreateDocument(opened.documentId);
  const adapter = getAdapter("md");
  const prepared = await adapter.parse(edited);
  withMcp(doc, () => adapter.apply(doc, prepared, { fileName: name }));
  markDirty(opened.documentId);
  return { filePath, id: opened.documentId, doc };
}

/** The text of every `unsaved`-kind snapshot for `filePath`, newest first. */
async function unsavedSnapshots(filePath: string): Promise<string[]> {
  const listed = await listDocBackups(filePath, resolveAppDataDir());
  return Promise.all(
    listed
      .filter((b) => b.kind === "unsaved")
      .map((b) =>
        fs.readFile(docBackupSnapshotPath(filePath, resolveAppDataDir(), b.name)!, "utf-8"),
      ),
  );
}

/** Make every backup write fail: a FILE where the backup root directory goes. */
async function breakBackupFolder(): Promise<void> {
  await fs.mkdir(resolveAppDataDir(), { recursive: true });
  await fs.writeFile(docBackupsRoot(resolveAppDataDir()), "not a directory");
}

describe("tandem_open force keeps unsaved edits", () => {
  it("keeps the edits as a backup, reloads, reports the backup and notifies", async () => {
    const { filePath, id, doc } = await openWithUnsavedEdits(
      "force.md",
      "disk text\n",
      "my unsaved edits\n",
    );
    const holder: UnsavedEditsHolder = {};

    await openFromDisk(filePath, { force: true, keepUnsavedEdits: holder });

    expect(extractText(doc)).toContain("disk text");
    expect(holder.kept?.name).toMatch(/-unsaved\.md$/);
    const kept = await unsavedSnapshots(filePath);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("my unsaved edits");
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unsaved-edits-kept",
        severity: "warning",
        documentId: id,
        backupName: holder.kept?.name,
      }),
    );
  });

  it("keeps nothing for a clean document", async () => {
    const filePath = path.join(tmpDir, "clean.md");
    await fs.writeFile(filePath, "clean text\n");
    await openFromDisk(filePath);
    const holder: UnsavedEditsHolder = {};

    await openFromDisk(filePath, { force: true, keepUnsavedEdits: holder });

    expect(holder.kept).toBeUndefined();
    expect(await unsavedSnapshots(filePath)).toEqual([]);
  });

  it("is opt-in: a force-open without the option (the /api/open path) keeps nothing", async () => {
    const { filePath, doc } = await openWithUnsavedEdits("api.md", "disk\n", "edits\n");

    await openFromDisk(filePath, { force: true });

    expect(extractText(doc)).toContain("disk");
    expect(await unsavedSnapshots(filePath)).toEqual([]);
  });

  it("refuses with BACKUP_FAILED and leaves the edits in place when the backup fails", async () => {
    const { filePath, doc } = await openWithUnsavedEdits("fail.md", "disk\n", "precious edits\n");
    await breakBackupFolder();

    await expect(
      openFromDisk(filePath, { force: true, keepUnsavedEdits: {} }),
    ).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    expect(extractText(doc)).toContain("precious edits");
  });

  it("brings the edits back: force-open, then restore the kept backup by name", async () => {
    const { filePath, id, doc } = await openWithUnsavedEdits(
      "roundtrip.md",
      "disk\n",
      "work in progress\n",
    );
    const holder: UnsavedEditsHolder = {};
    await openFromDisk(filePath, { force: true, keepUnsavedEdits: holder });
    expect(extractText(doc)).not.toContain("work in progress");

    await restoreDocumentFromBackup(id, holder.kept!.name);

    expect(extractText(doc)).toContain("work in progress");
  });
});

describe("the swap-time capture", () => {
  it("clearAndReload calls atSwap inside the swap, while the old content is still there", async () => {
    const { filePath, id, doc } = await openWithUnsavedEdits("swap.md", "disk\n", "old edits\n");
    let seen = "";

    await clearAndReload(id, doc, filePath, "md", getOpenDocs().get(id)!, "new content\n", {
      atSwap: () => {
        seen = extractText(doc);
      },
    });

    expect(seen).toContain("old edits");
    expect(extractText(doc)).toContain("new content");
  });

  it("reloadFromDisk calls atSwap inside the swap, while the old content is still there", async () => {
    const { filePath, id, doc } = await openWithUnsavedEdits("swap2.md", "disk\n", "old edits\n");
    let seen = "";

    await reloadFromDisk(id, filePath, "md", {
      atSwap: () => {
        seen = extractText(doc);
      },
    });

    expect(seen).toContain("old edits");
    expect(extractText(doc)).toContain("disk");
  });

  it("captureAtSwap reads the edits; keepEditsCapturedAtSwap keeps only what is new", async () => {
    const { filePath, id, doc } = await openWithUnsavedEdits("gap.md", "disk\n", "typed in gap\n");
    const swap = captureAtSwap(id, getOpenDocs().get(id)!);
    swap.capture(doc);
    expect(swap.text).toContain("typed in gap");

    // Same as the first capture, or as the incoming text: nothing new to keep.
    expect(await keepEditsCapturedAtSwap(filePath, swap.text, swap.text)).toBeUndefined();
    expect(await keepEditsCapturedAtSwap(filePath, swap.text, null, swap.text!)).toBeUndefined();
    // Text the first capture did not have (typed during the action's awaits): kept.
    const kept = await keepEditsCapturedAtSwap(filePath, swap.text, null, "disk\n");
    expect(kept?.name).toMatch(/-unsaved\.md$/);
    expect(await unsavedSnapshots(filePath)).toEqual([swap.text]);
  });

  it("keepEditsCapturedAtSwap never throws: a failed backup after the swap is only logged", async () => {
    await breakBackupFolder();
    await expect(
      keepEditsCapturedAtSwap(path.join(tmpDir, "x.md"), "edits\n", null),
    ).resolves.toBeUndefined();
  });
});

describe("tandem_restoreBackup keeps unsaved edits", () => {
  it("keeps the edits and the disk bytes, and reports the backup", async () => {
    const filePath = path.join(tmpDir, "restore.md");
    await fs.writeFile(filePath, "good version\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, "external version\n");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const adapter = getAdapter("md");
    const prepared = await adapter.parse("unsaved edits\n");
    withMcp(doc, () => adapter.apply(doc, prepared, { fileName: "restore.md" }));
    markDirty(opened.documentId);

    const result = await restoreDocumentFromBackup(opened.documentId, good.name, {
      keepUnsavedEdits: true,
    });

    expect(await fs.readFile(filePath, "utf-8")).toBe("good version\n");
    expect(result.unsavedEditsKept?.name).toMatch(/-unsaved\.md$/);
    expect((await unsavedSnapshots(filePath))[0]).toContain("unsaved edits");
    // The external version on disk was kept too, though the run's first-write
    // gate was already used by the snapshot of "good version" above.
    const disk = (await listDocBackups(filePath, resolveAppDataDir())).filter(
      (b) => b.kind === "disk",
    );
    const diskTexts = await Promise.all(
      disk.map((b) =>
        fs.readFile(docBackupSnapshotPath(filePath, resolveAppDataDir(), b.name)!, "utf-8"),
      ),
    );
    expect(diskTexts).toContain("external version\n");
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "unsaved-edits-kept", documentId: opened.documentId }),
    );
  });

  it("makes the kept edits the newest backup, so the palette's 'most recent' restores them", async () => {
    const filePath = path.join(tmpDir, "newest.md");
    await fs.writeFile(filePath, "good version\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id } = await openWithUnsavedEdits("newest.md", "good version\n", "my edits\n");
    await fs.writeFile(filePath, "external version\n");

    await restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true });

    const [newest] = await listDocBackups(filePath, resolveAppDataDir());
    expect(newest.kind).toBe("unsaved");
    expect(
      await fs.readFile(
        docBackupSnapshotPath(filePath, resolveAppDataDir(), newest.name)!,
        "utf-8",
      ),
    ).toContain("my edits");
  });

  it("an option-less restore keeps the once-per-run gate, so a second restore does not undo the first", async () => {
    const filePath = path.join(tmpDir, "browser.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, "mangled\n");
    const opened = await openFromDisk(filePath);

    await restoreDocumentFromBackup(opened.documentId, good.name);

    const all = await listDocBackups(filePath, resolveAppDataDir());
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe(good.name);
  });

  it("names the kept backup when the restore fails after keeping it", async () => {
    const filePath = path.join(tmpDir, "fail-late.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id } = await openWithUnsavedEdits("fail-late.md", "good\n", "edits\n");
    const watcher = await import("../../src/server/documents/watcher.js");
    const spy = vi.spyOn(watcher, "reloadFromDisk").mockResolvedValue(false);
    try {
      const err = await restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err?.code).toBe("RELOAD_IN_PROGRESS");
      expect(err?.message).toMatch(/-unsaved\.md/);
    } finally {
      spy.mockRestore();
    }
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unsaved-edits-kept",
        message: expect.stringMatching(/did not finish/),
      }),
    );
  });

  it("refuses before writing the file when the edits cannot be kept", async () => {
    const filePath = path.join(tmpDir, "refuse.md");
    await fs.writeFile(filePath, "good version\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, "current\n");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const adapter = getAdapter("md");
    const prepared = await adapter.parse("unsaved edits\n");
    withMcp(doc, () => adapter.apply(doc, prepared, { fileName: "refuse.md" }));
    markDirty(opened.documentId);
    // Keep the named snapshot readable, but make new backups fail: replace the
    // per-path subdir's parent with read-only permissions is platform-split, so
    // fail the unsaved kind by stubbing the store instead.
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi.spyOn(store, "snapshotUnsavedEdits").mockResolvedValue({ outcome: "failed" });
    try {
      await expect(
        restoreDocumentFromBackup(opened.documentId, good.name, { keepUnsavedEdits: true }),
      ).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(filePath, "utf-8")).toBe("current\n");
    expect(extractText(doc)).toContain("unsaved edits");
  });

  it("restores the oldest of several disk snapshots after Claude actions added unsaved ones", async () => {
    const filePath = path.join(tmpDir, "oldest.md");
    const names: string[] = [];
    for (let i = 0; i < MAX_DOC_BACKUPS; i++) {
      await fs.writeFile(filePath, `version ${i}\n`);
      _resetDocBackupGateForTests();
      await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    }
    for (const b of await listDocBackups(filePath, resolveAppDataDir())) names.push(b.name);
    const oldest = names[names.length - 1];
    const { id } = await openWithUnsavedEdits("oldest.md", "now\n", "fresh edits\n");

    await restoreDocumentFromBackup(id, oldest, { keepUnsavedEdits: true });

    expect(await fs.readFile(filePath, "utf-8")).toBe("version 0\n");
  });

  it("the tool reports backupKept with a note that names the backup", async () => {
    const filePath = path.join(tmpDir, "tool.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, "bad\n");
    const { id } = await openWithUnsavedEdits("tool.md", "bad\n", "edits\n");
    setActiveDocId(id);

    const parsed = JSON.parse((await restoreTool({ backup: good.name })).content[0].text);

    expect(parsed.error).toBe(false);
    expect(parsed.data.backupKept.name).toMatch(/-unsaved\.md$/);
    expect(parsed.data.backupKeptNote).toContain(parsed.data.backupKept.name);
    expect(parsed.data).not.toHaveProperty("unsavedEditsKept");
  });
});

describe("tandem_close keeps unsaved edits", () => {
  it("keeps the edits, closes, and reports the backup", async () => {
    const { filePath, id } = await openWithUnsavedEdits("close.md", "disk\n", "unsaved close\n");

    const result = await closeDocumentById(id, { keepUnsavedEdits: true });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.unsavedEditsKept?.name).toMatch(/-unsaved\.md$/);
    expect((await unsavedSnapshots(filePath))[0]).toContain("unsaved close");
    expect(getOpenDocs().has(id)).toBe(false);
  });

  it("refuses with BACKUP_FAILED and keeps the document open when the backup fails", async () => {
    const { id, doc } = await openWithUnsavedEdits("close-fail.md", "disk\n", "keep me\n");
    await breakBackupFolder();

    const result = await closeDocumentById(id, { keepUnsavedEdits: true });

    expect(result).toMatchObject({ success: false, code: "BACKUP_FAILED" });
    expect(getOpenDocs().has(id)).toBe(true);
    expect(extractText(doc)).toContain("keep me");
  });

  it("is opt-in: a close without the option (POST /api/close) keeps nothing", async () => {
    const { filePath, id } = await openWithUnsavedEdits("close-api.md", "disk\n", "edits\n");

    await closeDocumentById(id);

    expect(await unsavedSnapshots(filePath)).toEqual([]);
  });
});

describe("the tool envelopes", () => {
  it("tandem_open force reports backupKept and a note that names the backup", async () => {
    const { filePath } = await openWithUnsavedEdits("tool-open.md", "disk\n", "edits\n");

    const parsed = await callDocumentTool("tandem_open", { filePath, force: true });

    expect(parsed.error).toBe(false);
    expect(parsed.data.backupKept.name).toMatch(/-unsaved\.md$/);
    expect(parsed.data.backupKeptNote).toContain(JSON.stringify(parsed.data.backupKept.name));
    expect(parsed.data.backupKeptNote).not.toMatch(/reopen/);
  });

  it("tandem_open force answers BACKUP_FAILED when the edits cannot be kept", async () => {
    const { filePath, doc } = await openWithUnsavedEdits("tool-fail.md", "disk\n", "edits\n");
    await breakBackupFolder();

    const parsed = await callDocumentTool("tandem_open", { filePath, force: true });

    expect(parsed).toMatchObject({ error: true, code: "BACKUP_FAILED" });
    expect(extractText(doc)).toContain("edits");
  });

  it("tandem_close reports backupKept with a note that says to reopen first", async () => {
    const { id } = await openWithUnsavedEdits("tool-close.md", "disk\n", "edits\n");

    const parsed = await callDocumentTool("tandem_close", { documentId: id });

    expect(parsed.error).toBe(false);
    expect(parsed.data.backupKept.name).toMatch(/-unsaved\.md$/);
    expect(parsed.data.backupKeptNote).toMatch(/reopen the document with tandem_open/);
  });

  it("tandem_close answers BACKUP_FAILED and leaves the document open", async () => {
    const { id } = await openWithUnsavedEdits("tool-close-fail.md", "disk\n", "edits\n");
    await breakBackupFolder();

    const parsed = await callDocumentTool("tandem_close", { documentId: id });

    expect(parsed).toMatchObject({ error: true, code: "BACKUP_FAILED" });
    expect(getOpenDocs().has(id)).toBe(true);
  });
});

describe("what counts as unsaved edits", () => {
  it("a pending conflict counts even when the dirty flag is clear", async () => {
    const filePath = path.join(tmpDir, "conflict.md");
    await fs.writeFile(filePath, "text\n");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    flagExternalConflict(opened.documentId, doc, filePath, {
      kind: "external-edit",
      diskChanged: true,
      detectedAt: Date.now(),
    });

    expect(
      unsavedEditsOf(opened.documentId, doc, getOpenDocs().get(opened.documentId)!),
    ).not.toBeNull();
  });

  it("covers .txt, but not read-only documents, uploads or other formats", async () => {
    const { id, doc } = await openWithUnsavedEdits("plain.txt", "a\n", "b\n");
    const state = getOpenDocs().get(id)!;

    expect(unsavedEditsOf(id, doc, state)).not.toBeNull();
    expect(unsavedEditsOf(id, doc, { ...state, readOnly: true })).toBeNull();
    expect(unsavedEditsOf(id, doc, { ...state, source: "upload" })).toBeNull();
    expect(unsavedEditsOf(id, doc, { ...state, format: "html" })).toBeNull();
    expect(unsavedEditsOf(id, doc, { ...state, format: "docx" })).toBeNull();
  });

  it("a serializer that throws refuses with BACKUP_FAILED rather than lose the edits", async () => {
    const { id, doc } = await openWithUnsavedEdits("throw.md", "a\n", "b\n");
    const adapter = getAdapter("md");
    const spy = vi.spyOn(adapter, "save").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      expect(() => unsavedEditsOf(id, doc, getOpenDocs().get(id)!)).toThrow(
        expect.objectContaining({ code: "BACKUP_FAILED" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps nothing when the edits equal the incoming content", async () => {
    const filePath = path.join(tmpDir, "same.md");
    expect(await keepUnsavedEdits(filePath, "same\n", "same\n")).toBeUndefined();
    expect(await unsavedSnapshots(filePath)).toEqual([]);
  });

  it("a backup folder at its size limit refuses with BACKUP_FAILED", async () => {
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi
      .spyOn(store, "snapshotUnsavedEdits")
      .mockResolvedValue({ outcome: "skipped-size-cap" });
    try {
      await expect(keepUnsavedEdits(path.join(tmpDir, "cap.md"), "edits\n")).rejects.toMatchObject({
        code: "BACKUP_FAILED",
        message: expect.stringMatching(/full/),
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("close keeps its document identity across the backup's await", () => {
  it("closes nothing when the document was closed during the backup", async () => {
    const { id } = await openWithUnsavedEdits("race.md", "disk\n", "edits\n");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const real = store.snapshotUnsavedEdits;
    const spy = vi.spyOn(store, "snapshotUnsavedEdits").mockImplementation(async (...args) => {
      // A browser close lands while the backup is being written.
      await closeDocumentById(id);
      return real(...args);
    });
    try {
      const result = await closeDocumentById(id, { keepUnsavedEdits: true });
      expect(result).toMatchObject({ success: false });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("second cloud review (d2de584)", () => {
  it("tandem_close maps a serializer throw to BACKUP_FAILED, not INTERNAL_ERROR", async () => {
    const { id } = await openWithUnsavedEdits("close-throw.md", "disk\n", "edits\n");
    const spy = vi.spyOn(getAdapter("md"), "save").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const parsed = await callDocumentTool("tandem_close", { documentId: id });
      expect(parsed).toMatchObject({ error: true, code: "BACKUP_FAILED" });
    } finally {
      spy.mockRestore();
    }
    expect(getOpenDocs().has(id)).toBe(true);
  });

  it("tandem_close keeps no backup, and is not refused, when the file is read-only on disk (its session is kept)", async () => {
    const { id } = await openWithUnsavedEdits("ro.md", "disk\n", "edits\n");
    await breakBackupFolder();
    const readOnlyFile = await import("../../src/server/documents/read-only-file.js");
    const spy = vi.spyOn(readOnlyFile, "isWritableOnDisk").mockResolvedValue(false);
    try {
      const result = await closeDocumentById(id, { keepUnsavedEdits: true });
      expect(result.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("a force-open that fails after the swap keeps the edits typed during the action", async () => {
    const { filePath, doc } = await openWithUnsavedEdits("late.md", "disk\n", "first edits\n");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const registry = await import("../../src/server/documents/registry.js");
    const realSnapshot = store.snapshotUnsavedEdits;
    let typed = false;
    const snapSpy = vi.spyOn(store, "snapshotUnsavedEdits").mockImplementation(async (...args) => {
      const r = await realSnapshot(...args);
      if (!typed) {
        // The user types while the first backup is being written.
        typed = true;
        const adapter = getAdapter("md");
        const prepared = await adapter.parse("first edits plus more typed in the gap\n");
        withMcp(doc, () => adapter.apply(doc, prepared, { fileName: "late.md" }));
      }
      return r;
    });
    const readySpy = vi
      .spyOn(registry, "openDocumentWhenReady")
      .mockRejectedValue(new Error("wiring failed"));
    try {
      const err = await openFromDisk(filePath, { force: true, keepUnsavedEdits: {} }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/wiring failed/);
      expect(err?.message).toMatch(/-unsaved\.md/);
    } finally {
      snapSpy.mockRestore();
      readySpy.mockRestore();
    }
    const kept = await unsavedSnapshots(filePath);
    expect(kept.some((t) => t.includes("typed in the gap"))).toBe(true);
  });

  it("a Claude restore whose edits cannot be serialized writes no disk snapshot", async () => {
    const filePath = path.join(tmpDir, "no-prune.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id } = await openWithUnsavedEdits("no-prune.md", "good\n", "edits\n");
    await fs.writeFile(filePath, "external\n");
    const before = await listDocBackups(filePath, resolveAppDataDir());
    const spy = vi.spyOn(getAdapter("md"), "save").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      await expect(
        restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true }),
      ).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    } finally {
      spy.mockRestore();
    }
    expect(await listDocBackups(filePath, resolveAppDataDir())).toEqual(before);
    expect(await fs.readFile(filePath, "utf-8")).toBe("external\n");
  });

  it("edits already kept are touched, so they stay newer than the disk snapshot a restore just wrote", async () => {
    const filePath = path.join(tmpDir, "touch.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id } = await openWithUnsavedEdits("touch.md", "good\n", "same edits\n");
    // An earlier attempt already kept exactly these edits.
    const first = await keepUnsavedEdits(filePath, getAdapter("md").save!(getOrCreateDocument(id)));
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(filePath, "external\n");

    await restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true });

    const [newest] = await listDocBackups(filePath, resolveAppDataDir());
    expect(newest.kind).toBe("unsaved");
    expect(newest.name).toBe(first?.name);
  });
});

describe("third cloud review (829de9c)", () => {
  it("a restore refused because the edits cannot be kept writes and prunes no disk snapshot", async () => {
    const filePath = path.join(tmpDir, "refuse-first.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id } = await openWithUnsavedEdits("refuse-first.md", "good\n", "edits\n");
    await fs.writeFile(filePath, "external\n");
    const before = await listDocBackups(filePath, resolveAppDataDir());
    const store = await import("../../src/server/file-io/doc-backup.js");
    const spy = vi
      .spyOn(store, "snapshotUnsavedEdits")
      .mockResolvedValue({ outcome: "skipped-size-cap" });
    try {
      await expect(
        restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true }),
      ).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    } finally {
      spy.mockRestore();
    }
    expect(await listDocBackups(filePath, resolveAppDataDir())).toEqual(before);
  });

  it("a restore whose write fails reports no kept backup: nothing was discarded", async () => {
    const filePath = path.join(tmpDir, "write-fails.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id, doc } = await openWithUnsavedEdits("write-fails.md", "good\n", "edits\n");
    const io = await import("../../src/server/file-io/index.js");
    const spy = vi.spyOn(io, "atomicWrite").mockRejectedValue(new Error("EBUSY"));
    try {
      const err = await restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toBe("EBUSY");
    } finally {
      spy.mockRestore();
    }
    expect(extractText(doc)).toContain("edits");
    expect(pushNotificationMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "unsaved-edits-kept" }),
    );
  });
});

describe("second local review (8fa1493)", () => {
  it("an option-less restore of an unsaved backup snapshots the version it overwrites, gate or no gate", async () => {
    const filePath = path.join(tmpDir, "browser-unsaved.md");
    const { id } = await openWithUnsavedEdits("browser-unsaved.md", "first\n", "my edits\n");
    // An earlier save spent the run's gate.
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    // Claude force-opens onto an external version, keeping the edits.
    await fs.writeFile(filePath, "external version\n");
    const holder: UnsavedEditsHolder = {};
    await openFromDisk(filePath, { force: true, keepUnsavedEdits: holder });

    // A restore with no option writes the kept edits back.
    await restoreDocumentFromBackup(id, holder.kept!.name);

    const disk = (await listDocBackups(filePath, resolveAppDataDir())).filter(
      (b) => b.kind === "disk",
    );
    const texts = await Promise.all(
      disk.map((b) =>
        fs.readFile(docBackupSnapshotPath(filePath, resolveAppDataDir(), b.name)!, "utf-8"),
      ),
    );
    expect(texts).toContain("external version\n");
  });

  it("a restore whose document is closed during its backup writes nothing and names the kept backup", async () => {
    const filePath = path.join(tmpDir, "closed-mid.md");
    await fs.writeFile(filePath, "good\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [good] = await listDocBackups(filePath, resolveAppDataDir());
    const { id } = await openWithUnsavedEdits("closed-mid.md", "good\n", "edits\n");
    await fs.writeFile(filePath, "current\n");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const real = store.snapshotUnsavedEdits;
    const spy = vi.spyOn(store, "snapshotUnsavedEdits").mockImplementation(async (...args) => {
      const r = await real(...args);
      await closeDocumentById(id); // the browser closes the tab meanwhile
      return r;
    });
    try {
      const err = await restoreDocumentFromBackup(id, good.name, { keepUnsavedEdits: true }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err?.code).toBe("NO_DOCUMENT");
      expect(err?.message).toMatch(/-unsaved\.md/);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(filePath, "utf-8")).toBe("current\n");
  });
});

describe("fourth cloud review (8073f94)", () => {
  it("a force-open whose document is closed during its backup reloads nothing and names the backup", async () => {
    const { filePath, id } = await openWithUnsavedEdits("force-closed.md", "disk\n", "edits\n");
    const store = await import("../../src/server/file-io/doc-backup.js");
    const real = store.snapshotUnsavedEdits;
    const spy = vi.spyOn(store, "snapshotUnsavedEdits").mockImplementation(async (...args) => {
      const r = await real(...args);
      await closeDocumentById(id); // the browser closes the tab meanwhile
      return r;
    });
    try {
      const err = await openFromDisk(filePath, { force: true, keepUnsavedEdits: {} }).then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err?.code).toBe("NO_DOCUMENT");
      expect(err?.message).toMatch(/-unsaved\.md/);
    } finally {
      spy.mockRestore();
    }
    expect(getOpenDocs().has(id)).toBe(false);
  });

  it("an option-less restore of kept edits, run twice, restores the same edits both times", async () => {
    const filePath = path.join(tmpDir, "twice.md");
    const { id, doc } = await openWithUnsavedEdits("twice.md", "first\n", "my edits\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    await fs.writeFile(filePath, "external\n");
    const holder: UnsavedEditsHolder = {};
    await openFromDisk(filePath, { force: true, keepUnsavedEdits: holder });

    for (let i = 0; i < 2; i++) {
      const [newest] = await listDocBackups(filePath, resolveAppDataDir());
      expect(newest.name).toBe(holder.kept!.name);
      await restoreDocumentFromBackup(id, newest.name);
      expect(extractText(doc)).toContain("my edits");
    }
  });
});
