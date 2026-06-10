/**
 * Tests for text-document backup restore (#1086):
 *  - `listDocBackups` snapshot enumeration (newest first, source.txt excluded)
 *  - `restoreDocumentFromBackup` routing through the reload lifecycle
 *    (Y.Doc content replaced, watcher suppressed, annotations preserved)
 *  - the extended `tandem_restoreBackup` MCP tool (list mode, restore mode,
 *    unchanged .docx sidecar behavior, error cases)
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted before module-level code, so outer `const`s
// are not accessible inside them (see file-opener-lifecycle.test.ts).

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-restore-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

// Mock the watcher so tests can assert suppressNextChange without real fs.watch.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

// Notification bus is irrelevant here; capture calls instead.
vi.mock("../../src/server/notifications.js", () => ({
  pushNotification: vi.fn(),
}));
// The Windows ACL helper spawns icacls/whoami — not for unit tests.
vi.mock("../../src/server/integrations/acl-win.js", () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  _resetDocBackupGateForTests,
  docBackupSnapshotPath,
  docBackupsRoot,
  listDocBackups,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { suppressNextChange } from "../../src/server/file-watcher.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { openFileByPath, restoreDocumentFromBackup } from "../../src/server/mcp/file-opener.js";
import { pushNotification } from "../../src/server/notifications.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withMcp } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

const suppressMock = vi.mocked(suppressNextChange);
const pushNotificationMock = vi.mocked(pushNotification);

// ---------------------------------------------------------------------------
// MCP tool handler capture — registerApplyTools against a fake McpServer
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const toolHandlers = new Map<string, ToolHandler>();
registerApplyTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
    toolHandlers.set(name, handler);
  },
} as unknown as McpServer);
const restoreTool = toolHandlers.get("tandem_restoreBackup")!;

function parseResult(result: ToolResult): {
  error: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
} {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  _resetDocBackupGateForTests();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-restore-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

// ---------------------------------------------------------------------------
// listDocBackups
// ---------------------------------------------------------------------------

describe("listDocBackups", () => {
  it("returns an empty array when no snapshots exist", async () => {
    const filePath = path.join(tmpDir, "empty.md");
    expect(await listDocBackups(filePath, resolveAppDataDir())).toEqual([]);
  });

  it("lists real snapshots written by snapshotBeforeFirstWrite, excluding source.txt", async () => {
    const filePath = path.join(tmpDir, "doc.md");
    await fs.writeFile(filePath, "v1 content\n");
    expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
      "written",
    );

    const backups = await listDocBackups(filePath, resolveAppDataDir());
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(/^doc-\d{8}-\d{6}-[0-9a-f]{8}\.md$/);
    expect(backups[0].size).toBe(Buffer.byteLength("v1 content\n"));
    // ISO 8601 timestamp, parseable
    expect(Number.isNaN(new Date(backups[0].timestamp).getTime())).toBe(false);
  });

  it("orders snapshots newest first by mtime", async () => {
    const filePath = path.join(tmpDir, "doc.md");
    const subdir = path.join(docBackupsRoot(resolveAppDataDir()), docHash(filePath));
    await fs.mkdir(subdir, { recursive: true });
    const older = path.join(subdir, "doc-20260101-100000-aaaaaaaa.md");
    const newer = path.join(subdir, "doc-20260102-100000-bbbbbbbb.md");
    await fs.writeFile(older, "older\n");
    await fs.writeFile(newer, "newer\n");
    await fs.writeFile(path.join(subdir, "source.txt"), `${filePath}\n`);
    await fs.utimes(older, new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T10:00:00Z"));
    await fs.utimes(newer, new Date("2026-01-02T10:00:00Z"), new Date("2026-01-02T10:00:00Z"));

    const backups = await listDocBackups(filePath, resolveAppDataDir());
    expect(backups.map((b) => b.name)).toEqual([
      "doc-20260102-100000-bbbbbbbb.md",
      "doc-20260101-100000-aaaaaaaa.md",
    ]);
  });

  it("breaks same-second name ties by mtime, not by the random uuid8 (CI regression)", async () => {
    // Two snapshots within the same second share the name's timestamp segment,
    // so lexicographic order falls to the random uuid8 — here deliberately
    // contradicting recency: the lexicographically-LARGER name is the OLDER file.
    const filePath = path.join(tmpDir, "doc.md");
    const subdir = path.join(docBackupsRoot(resolveAppDataDir()), docHash(filePath));
    await fs.mkdir(subdir, { recursive: true });
    const newerByMtime = path.join(subdir, "doc-20260101-100000-aaaaaaaa.md");
    const olderByMtime = path.join(subdir, "doc-20260101-100000-ffffffff.md");
    await fs.writeFile(newerByMtime, "newest bytes\n");
    await fs.writeFile(olderByMtime, "older bytes\n");
    await fs.utimes(
      olderByMtime,
      new Date("2026-01-01T10:00:00.100Z"),
      new Date("2026-01-01T10:00:00.100Z"),
    );
    await fs.utimes(
      newerByMtime,
      new Date("2026-01-01T10:00:00.900Z"),
      new Date("2026-01-01T10:00:00.900Z"),
    );

    const backups = await listDocBackups(filePath, resolveAppDataDir());
    expect(backups.map((b) => b.name)).toEqual([
      "doc-20260101-100000-aaaaaaaa.md",
      "doc-20260101-100000-ffffffff.md",
    ]);
  });
});

// ---------------------------------------------------------------------------
// docBackupSnapshotPath — the traversal boundary
// ---------------------------------------------------------------------------

describe("docBackupSnapshotPath", () => {
  const filePath = "/tmp/whatever.md";
  const appDataDir = "/tmp/app-data";

  it("resolves a valid snapshot name inside the per-path subdir", () => {
    const p = docBackupSnapshotPath(filePath, appDataDir, "doc-20260101-100000-aaaaaaaa.md");
    expect(p).toBe(
      path.join(docBackupsRoot(appDataDir), docHash(filePath), "doc-20260101-100000-aaaaaaaa.md"),
    );
  });

  it("rejects names with separators, source.txt, and non-snapshot names", () => {
    expect(docBackupSnapshotPath(filePath, appDataDir, "../../etc/passwd")).toBeNull();
    expect(docBackupSnapshotPath(filePath, appDataDir, "source.txt")).toBeNull();
    expect(docBackupSnapshotPath(filePath, appDataDir, "store.lock")).toBeNull();
    expect(
      docBackupSnapshotPath(filePath, appDataDir, "sub/doc-20260101-100000-aaaaaaaa.md"),
    ).toBeNull();
    expect(docBackupSnapshotPath(filePath, appDataDir, "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restoreDocumentFromBackup — restore-through-reload for an open document
// ---------------------------------------------------------------------------

describe("restoreDocumentFromBackup", () => {
  it("restores the snapshot bytes through the reload lifecycle", async () => {
    const filePath = path.join(tmpDir, "thesis.md");
    const v1 = "# Original\n\nHello world\n";
    const v2 = "# Mangled\n\nHello world, badly escaped\n";

    // v1 on disk, snapshotted (the pre-overwrite path the save flow runs)...
    await fs.writeFile(filePath, v1);
    expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
      "written",
    );
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());

    // ...then disk holds the bad rewrite, and the doc is open on it.
    await fs.writeFile(filePath, v2);
    const opened = await openFileByPath(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    expect(extractText(doc)).toContain("badly escaped");

    // Annotation present before restore — must survive the reload.
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "ann_restore_1",
      range: { from: toFlatOffset(2), to: toFlatOffset(9) },
      textSnapshot: "Hello w",
    });
    withMcp(doc, () => annotations.set(ann.id, ann));

    // Fresh run w.r.t. the once-per-run snapshot gate, so the restore's own
    // pre-overwrite snapshot of v2 is exercised too.
    _resetDocBackupGateForTests();
    suppressMock.mockClear();

    const result = await restoreDocumentFromBackup(opened.documentId, snapshot.name);

    // Disk holds the snapshot bytes again.
    expect(await fs.readFile(filePath, "utf-8")).toBe(v1);
    // Y.Doc was reloaded in place (not just bytes-on-disk).
    expect(extractText(doc)).toContain("Hello world");
    expect(extractText(doc)).not.toContain("badly escaped");
    // The restore write was suppressed so the watcher doesn't misread it
    // as an external edit.
    expect(suppressMock).toHaveBeenCalledWith(filePath);
    // Annotations survived the reload.
    expect(annotations.has("ann_restore_1")).toBe(true);
    // The pre-restore on-disk bytes (v2) were preserved as a new snapshot,
    // so the restore is itself reversible.
    const after = await listDocBackups(filePath, resolveAppDataDir());
    expect(after).toHaveLength(2);
    const newestPath = docBackupSnapshotPath(filePath, resolveAppDataDir(), after[0].name)!;
    expect(await fs.readFile(newestPath, "utf-8")).toBe(v2);
    // Result shape + user-facing notification.
    expect(result.restoredFrom.endsWith(snapshot.name)).toBe(true);
    expect(result.filePath).toBe(filePath);
    expect(pushNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "file-reloaded", documentId: opened.documentId }),
    );
  });

  it("rejects unknown documents", async () => {
    await expect(
      restoreDocumentFromBackup("not-open", "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "NO_DOCUMENT" });
  });

  it("rejects traversal-shaped and unknown snapshot names", async () => {
    const filePath = path.join(tmpDir, "doc.md");
    await fs.writeFile(filePath, "content\n");
    const opened = await openFileByPath(filePath);

    await expect(
      restoreDocumentFromBackup(opened.documentId, "../../../etc/passwd"),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(restoreDocumentFromBackup(opened.documentId, "source.txt")).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    // Valid shape, but no such snapshot on disk.
    await expect(
      restoreDocumentFromBackup(opened.documentId, "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("rejects read-only documents", async () => {
    const filePath = path.join(tmpDir, "CHANGELOG.md");
    await fs.writeFile(filePath, "content\n");
    const opened = await openFileByPath(filePath, { readOnly: true });
    await expect(
      restoreDocumentFromBackup(opened.documentId, "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("rejects non-text formats and upload sources", async () => {
    addDoc("docx-doc", {
      id: "docx-doc",
      filePath: path.join(tmpDir, "report.docx"),
      format: "docx",
      readOnly: false,
      source: "file",
    });
    await expect(
      restoreDocumentFromBackup("docx-doc", "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });

    addDoc("upload-doc", {
      id: "upload-doc",
      filePath: "upload://abc/notes.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    await expect(
      restoreDocumentFromBackup("upload-doc", "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

// ---------------------------------------------------------------------------
// tandem_restoreBackup tool — list + restore modes, .docx sidecar unchanged
// ---------------------------------------------------------------------------

describe("tandem_restoreBackup tool", () => {
  it("returns NO_DOCUMENT when nothing is open", async () => {
    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("NO_DOCUMENT");
  });

  it("lists snapshots for a text document when `backup` is omitted", async () => {
    const filePath = path.join(tmpDir, "notes.md");
    await fs.writeFile(filePath, "first version\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    await openFileByPath(filePath);

    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(false);
    const backups = parsed.data?.backups as Array<{ name: string; timestamp: string }>;
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(/^notes-\d{8}-\d{6}-[0-9a-f]{8}\.md$/);
  });

  it("returns FILE_NOT_FOUND for a text document with no snapshots", async () => {
    const filePath = path.join(tmpDir, "fresh.md");
    await fs.writeFile(filePath, "no backups yet\n");
    await openFileByPath(filePath);

    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FILE_NOT_FOUND");
  });

  it("restores a named snapshot for a text document", async () => {
    const filePath = path.join(tmpDir, "essay.md");
    await fs.writeFile(filePath, "good draft\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, "ruined draft\n");
    const opened = await openFileByPath(filePath);

    const parsed = parseResult(await restoreTool({ backup: snapshot.name }));
    expect(parsed.error).toBe(false);
    expect(await fs.readFile(filePath, "utf-8")).toBe("good draft\n");
    expect(extractText(getOrCreateDocument(opened.documentId))).toContain("good draft");
  });

  it("keeps the .docx sidecar restore unchanged", async () => {
    const filePath = path.join(tmpDir, "report.docx");
    const backupPath = path.join(tmpDir, "report.backup.docx");
    await fs.writeFile(filePath, "modified docx bytes");
    await fs.writeFile(backupPath, "original docx bytes");
    addDoc("docx-restore", {
      id: "docx-restore",
      filePath,
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId("docx-restore");

    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(false);
    expect(parsed.data?.restoredFrom).toBe(backupPath);
    expect(await fs.readFile(filePath, "utf-8")).toBe("original docx bytes");
  });

  it("rejects `backup` for .docx documents and missing sidecars", async () => {
    const filePath = path.join(tmpDir, "plain.docx");
    await fs.writeFile(filePath, "docx bytes");
    addDoc("docx-plain", {
      id: "docx-plain",
      filePath,
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId("docx-plain");

    const withBackup = parseResult(await restoreTool({ backup: "anything" }));
    expect(withBackup.error).toBe(true);
    expect(withBackup.code).toBe("FORMAT_ERROR");

    const noSidecar = parseResult(await restoreTool({}));
    expect(noSidecar.error).toBe(true);
    expect(noSidecar.code).toBe("FILE_NOT_FOUND");
  });

  it("rejects list mode for upload-source documents", async () => {
    addDoc("upload-list", {
      id: "upload-list",
      filePath: "upload://xyz/pasted.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    setActiveDocId("upload-list");

    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("FORMAT_ERROR");
  });
});
