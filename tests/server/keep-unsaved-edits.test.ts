/**
 * ADR-057: a Claude action that discards unsaved edits keeps them as a backup
 * first — `tandem_open force` (`openFromDisk`'s `keepUnsavedEdits`), the
 * `tandem_restoreBackup` restore arm (`restoreDocumentFromBackup`'s
 * `keepUnsavedEdits`) and `tandem_close` (`closeDocumentById`'s
 * `keepUnsavedEdits`). If the backup cannot be kept, the action is refused with
 * the document untouched. The browser's paths, which pass no option, are
 * unchanged.
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
import { markDirty } from "../../src/server/documents/dirty.js";
import { captureAtSwap, keepEditsCapturedAtSwap } from "../../src/server/documents/keep-unsaved.js";
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
import { extractText } from "../../src/server/mcp/document-model.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { pushNotification } from "../../src/server/notifications.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { withMcp } from "../../src/shared/origins.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

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
    const swap = captureAtSwap(id, doc, getOpenDocs().get(id)!);
    swap.capture();
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
