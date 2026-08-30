/**
 * Tests for document backup restore (#1086, extended to .docx):
 *  - `listDocBackups` snapshot enumeration (newest first, source.txt excluded)
 *  - `restoreDocumentFromBackup` routing through the reload lifecycle
 *    (Y.Doc content replaced, watcher suppressed, annotations preserved) — for
 *    .md/.txt (utf-8) and .docx (binary, byte-identical)
 *  - the `tandem_restoreBackup` MCP tool (list mode, restore mode, the .docx
 *    sidecar fallback when no snapshots exist, error cases)
 */

import { fileURLToPath } from "node:url";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

// vi.mock factories are hoisted before module-level code, so outer `const`s
// are not accessible inside them (see open-pipeline-lifecycle.test.ts).

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

// Mock the watcher so tests can assert the self-write filter without real
// fs.watch. BOTH layers are mocked, because both are asserted: the arrival
// counter (`suppressNextChange`) and the delivery fingerprint
// (`recordSelfWrite`). Mocking only the layer you assert is how the other one
// ends up unpinned.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
  recordSelfWrite: vi.fn(),
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
import { Document, Packer, Paragraph, TextRun } from "docx";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { restoreDocumentFromBackup } from "../../src/server/documents/reload-family.js";
import {
  _resetDocBackupGateForTests,
  docBackupSnapshotPath,
  docBackupsRoot,
  listDocBackups,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { recordSelfWrite, suppressNextChange } from "../../src/server/file-watcher.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { pushNotification } from "../../src/server/notifications.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";
import { INTERNAL_ORIGIN, RELOAD_ORIGIN, withMcp } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

const suppressMock = vi.mocked(suppressNextChange);
const recordSelfWriteMock = vi.mocked(recordSelfWrite);
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

/** Build a minimal, valid, mammoth-parseable .docx buffer with one paragraph. */
async function buildDocx(text: string): Promise<Buffer> {
  const document = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun(text)] })] }],
  });
  return Packer.toBuffer(document);
}

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
    const opened = await openFromDisk(filePath);
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
    recordSelfWriteMock.mockClear();

    const result = await restoreDocumentFromBackup(opened.documentId, snapshot.name);

    // Disk holds the snapshot bytes again.
    expect(await fs.readFile(filePath, "utf-8")).toBe(v1);
    // Y.Doc was reloaded in place (not just bytes-on-disk).
    expect(extractText(doc)).toContain("Hello world");
    expect(extractText(doc)).not.toContain("badly escaped");
    // The restore write was suppressed so the watcher doesn't misread it
    // as an external edit. **Both layers, because self-write filtering is two
    // of them and only one was pinned.** Replacing the `recordSelfWrite` call
    // in `restoreDocumentFromBackup` with `void 0;` passed 109 tests across
    // five suites — the arrival counter below was asserted and the delivery
    // fingerprint was not, so half of a pair CLAUDE.md calls load-bearing had
    // no gate at all.
    //
    // The layers are not redundant and the second is the one that fails
    // quietly. An NTFS atomic rename fires ~2 `change` events while
    // `suppressNextChange` arms once, so one leaks past it every time;
    // `recordSelfWrite` is what catches the leaked one. Lose it and the
    // restore triggers a second, spurious reload plus a "file changed" toast
    // for an edit the user did not make.
    expect(suppressMock, "layer 1: the arrival counter").toHaveBeenCalledWith(filePath);
    expect(
      recordSelfWriteMock,
      "layer 2: the delivery fingerprint, paired with the write's exact bytes",
    ).toHaveBeenCalledWith(filePath, v1);
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

  it("tags its saved-baseline write `internal`, so it emits no channel event", async () => {
    // Critical Rule 2, the second of the two `withInternal` sites in the reload
    // family. Its sibling in `resolveExternalConflict` is pinned in
    // `tests/server/external-conflict.test.ts`; a guard covering one of two
    // identical sites leaves the other one free, which is how this class of
    // mis-tag survives a move.
    //
    // The write re-baselines Y_MAP_SAVED_AT_VERSION so autosave's
    // external-modification guard does not read the restore as a foreign edit.
    // That is server-owned bookkeeping: `browser` would emit a channel event
    // for a write the user did not make, and `mcp` would be a lie about who
    // wrote it. Written ahead of ADR-034 Unit 7c, which moves this function.
    const filePath = path.join(tmpDir, "origin-probe.md");
    await fs.writeFile(filePath, "# One\n");
    expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
      "written",
    );
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, "# Two\n");
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    _resetDocBackupGateForTests();

    // **Filtered to the transaction that changed the key, not a bag of every
    // origin the flow emits.** The first version of this spec collected all
    // origins and asserted `toContain(INTERNAL_ORIGIN)`, and review measured
    // what that array actually holds: `["reload","internal","internal",
    // "internal"]`. Only ONE of those three is the write under test — the other
    // two come from `publishDirty` (`documents/dirty.ts`), also `withInternal`
    // on this doc, firing once when repopulation trips the fragment observer
    // and once from `markClean`. Two mutants passed it: `withInternal` ->
    // `withReload`, and the write DELETED ENTIRELY.
    //
    // Its sibling in `external-conflict.test.ts` is sound with that same shape,
    // and that is the trap worth naming: `resolveExternalConflict("keep")`
    // emits exactly one transaction, so `toContain` over a one-element array
    // IS attribution. That is a property of the SUBJECT, not of the test. The
    // two specs looked identical and one of them was correct by accident — so
    // do not copy either forward without counting the transactions first.
    const baselineWrites: unknown[] = [];
    // `txn.changed` is keyed by a widened `AbstractType` while `getMap` returns
    // the narrower `Y.Map`, so the lookup needs a cast. The key type is inferred
    // from `changed` itself rather than spelled out, so this cannot drift if
    // Yjs restates it. Only identity matters here, never the element type.
    type ChangedKey = Y.Transaction["changed"] extends Map<infer K, unknown> ? K : never;
    const metaMap = doc.getMap(Y_MAP_DOCUMENT_META) as unknown as ChangedKey;
    doc.on("afterTransaction", (txn: Y.Transaction) => {
      if (txn.changed.get(metaMap)?.has(Y_MAP_SAVED_AT_VERSION)) {
        baselineWrites.push(txn.origin);
      }
    });

    await restoreDocumentFromBackup(opened.documentId, snapshot.name);

    expect(extractText(doc), "control: the restore actually ran").toContain("One");

    // Two writes touch this key, in this order, and the ordering is a real
    // invariant nothing else asserts: `reloadFromDisk` sets it from the file's
    // mtime inside its `withReload` transact, then the restore overwrites it
    // with `Date.now()` under `withInternal`. Pinning the COUNT is the
    // load-bearing half — without it the filter could widen later and the
    // origin assertion below would quietly start describing a different write.
    expect(
      baselineWrites,
      "control: the baseline key is written exactly twice — reload, then the restore's own re-baseline",
    ).toHaveLength(2);
    expect(baselineWrites[0], "reloadFromDisk's content replacement").toBe(RELOAD_ORIGIN);
    expect(
      baselineWrites[1],
      "the restore's own re-baseline — `browser` would emit a channel event for a write the user did not make, and `mcp` would be a lie about who wrote it",
    ).toBe(INTERNAL_ORIGIN);
  });

  it("rejects unknown documents", async () => {
    await expect(
      restoreDocumentFromBackup("not-open", "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "NO_DOCUMENT" });
  });

  it("rejects traversal-shaped and unknown snapshot names", async () => {
    const filePath = path.join(tmpDir, "doc.md");
    await fs.writeFile(filePath, "content\n");
    const opened = await openFromDisk(filePath);

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
    const opened = await openFromDisk(filePath, { readOnly: true });
    await expect(
      restoreDocumentFromBackup(opened.documentId, "doc-20260101-100000-aaaaaaaa.md"),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("allows .docx but rejects other binary formats and upload sources", async () => {
    // .docx is now restorable — a missing snapshot surfaces FILE_NOT_FOUND
    // (the format guard no longer rejects it outright).
    addDoc("docx-doc", {
      id: "docx-doc",
      filePath: path.join(tmpDir, "report.docx"),
      format: "docx",
      readOnly: false,
      source: "file",
    });
    await expect(
      restoreDocumentFromBackup("docx-doc", "report-20260101-100000-aaaaaaaa.docx"),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });

    // A genuinely unsupported format is still rejected by the guard.
    addDoc("html-doc", {
      id: "html-doc",
      filePath: path.join(tmpDir, "page.html"),
      format: "html",
      readOnly: false,
      source: "file",
    });
    await expect(
      restoreDocumentFromBackup("html-doc", "page-20260101-100000-aaaaaaaa.html"),
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
// .docx backup + restore — binary byte-identity through the snapshot store
// ---------------------------------------------------------------------------

describe("docx backup + restore", () => {
  it("snapshots .docx bytes verbatim (binary-safe, byte-identical)", async () => {
    const filePath = path.join(tmpDir, "report.docx");
    const v1 = await buildDocx("Original docx content");
    await fs.writeFile(filePath, v1);

    expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
      "written",
    );
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());
    const snapshotPath = docBackupSnapshotPath(filePath, resolveAppDataDir(), snapshot.name)!;
    // Byte-identical — a utf-8 round-trip would have corrupted the ZIP.
    expect((await fs.readFile(snapshotPath)).equals(v1)).toBe(true);
  });

  it("restores .docx bytes byte-identical and re-anchors annotations to their new offset", async () => {
    const filePath = path.join(tmpDir, "thesis.docx");
    // "Hello world" sits at DIFFERENT offsets in the two versions (0 in v1, 3
    // in v2) so a stale re-anchor that kept the v2 offset would be caught.
    const v1 = await buildDocx("Hello world original");
    const v2 = await buildDocx("XX Hello world mangled");

    // v1 on disk, snapshotted (the pre-overwrite path the save flow runs)...
    await fs.writeFile(filePath, v1);
    expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
      "written",
    );
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());

    // ...then disk holds the mangled rewrite, and the doc is open on it.
    await fs.writeFile(filePath, v2);
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    expect(extractText(doc)).toContain("mangled");
    // Sanity: "Hello world" is at offset 3 in the open (v2) content.
    expect(extractText(doc).slice(3, 14)).toBe("Hello world");

    // Annotation on "Hello world" at its v2 offset — must survive the reload
    // AND relocate to v1's offset via textSnapshot.
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    const ann = makeAnnotation({
      id: "ann_docx_restore",
      range: { from: toFlatOffset(3), to: toFlatOffset(14) },
      textSnapshot: "Hello world",
    });
    withMcp(doc, () => annotations.set(ann.id, ann));

    // Fresh run w.r.t. the once-per-run gate so the restore's own pre-overwrite
    // snapshot of v2 is exercised too.
    _resetDocBackupGateForTests();

    const result = await restoreDocumentFromBackup(opened.documentId, snapshot.name);

    // Disk holds the snapshot's exact bytes again (byte-identical, not text-equal).
    expect((await fs.readFile(filePath)).equals(v1)).toBe(true);
    // Y.Doc was reloaded in place from the restored bytes.
    expect(extractText(doc)).toContain("original");
    expect(extractText(doc)).not.toContain("mangled");
    // The annotation survived AND re-anchored to "Hello world" at its NEW v1
    // offset (0), not the stale v2 offset (3) — range correctness, not just survival.
    expect(annotations.has("ann_docx_restore")).toBe(true);
    const restored = annotations.get("ann_docx_restore") as { range: { from: number; to: number } };
    expect(extractText(doc).slice(restored.range.from, restored.range.to)).toBe("Hello world");
    // The pre-restore on-disk bytes (v2) were preserved as a new snapshot.
    const after = await listDocBackups(filePath, resolveAppDataDir());
    expect(after).toHaveLength(2);
    const newestPath = docBackupSnapshotPath(filePath, resolveAppDataDir(), after[0].name)!;
    expect((await fs.readFile(newestPath)).equals(v2)).toBe(true);
    expect(result.filePath).toBe(filePath);
  });

  it("re-injects Word comments idempotently on restore (no duplication)", async () => {
    // A real .docx WITH Word comments: opening injects them as import
    // annotations; restoring the byte-identical snapshot must re-inject the
    // SAME annotations (deterministic importAnnotationId), not double them.
    const fixture = fileURLToPath(
      new URL("../e2e/fixtures/reviewer-comments.docx", import.meta.url),
    );
    const filePath = path.join(tmpDir, "commented.docx");
    await fs.copyFile(fixture, filePath);

    expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
      "written",
    );
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());

    const opened = await openFromDisk(filePath);
    const annotations = getOrCreateDocument(opened.documentId).getMap(Y_MAP_ANNOTATIONS);
    const initialCount = annotations.size;
    // The fixture carries imported Word comments.
    expect(initialCount).toBeGreaterThan(0);

    _resetDocBackupGateForTests();
    await restoreDocumentFromBackup(opened.documentId, snapshot.name);

    // Re-injection is idempotent — the same imported comments, not doubled.
    expect(annotations.size).toBe(initialCount);
  });
});

// ---------------------------------------------------------------------------
// tandem_restoreBackup tool — list + restore modes (.md/.txt + .docx),
// with the .docx sidecar as a no-snapshot fallback
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
    await openFromDisk(filePath);

    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(false);
    const backups = parsed.data?.backups as Array<{ name: string; timestamp: string }>;
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(/^notes-\d{8}-\d{6}-[0-9a-f]{8}\.md$/);
  });

  it("returns FILE_NOT_FOUND for a text document with no snapshots", async () => {
    const filePath = path.join(tmpDir, "fresh.md");
    await fs.writeFile(filePath, "no backups yet\n");
    await openFromDisk(filePath);

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
    const opened = await openFromDisk(filePath);

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

  // The severe half of the symlink pair, and the reason it is severe: the old
  // code probed the sidecar with `fs.access`, which follows links, then
  // `fs.copyFile` read THROUGH the link and overwrote the user's document with
  // whatever it pointed at. The size verification then compared the link's
  // target against the file it had just written from that same target --
  // identical by construction -- so it verified, and the tool returned
  // "Restored report.docx from backup." A silent whole-document replacement,
  // reported as a success.
  //
  // Which is exactly why the assertion below is not only on the error code: a
  // refusal that still clobbered the document would satisfy a code check. The
  // load-bearing line is that filePath still holds its own bytes.
  it.runIf(process.platform !== "win32")(
    "refuses to restore through a symlinked .docx sidecar, and leaves the document alone",
    async () => {
      const filePath = path.join(tmpDir, "linked.docx");
      const backupPath = path.join(tmpDir, "linked.backup.docx");
      const attacker = path.join(tmpDir, "attacker-payload.docx");
      await fs.writeFile(filePath, "the user's real document");
      await fs.writeFile(attacker, "attacker-chosen bytes");
      await fs.symlink(attacker, backupPath);

      addDoc("docx-symlink-restore", {
        id: "docx-symlink-restore",
        filePath,
        format: "docx",
        readOnly: false,
        source: "file",
      });
      setActiveDocId("docx-symlink-restore");

      const parsed = parseResult(await restoreTool({}));
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe("INVALID_PATH");
      expect(
        await fs.readFile(filePath, "utf-8"),
        "the document was overwritten through the symlink -- the refusal did not " +
          "happen before the write",
      ).toBe("the user's real document");
    },
  );

  it("reports FILE_NOT_FOUND for a .docx with no snapshots and no sidecar", async () => {
    const filePath = path.join(tmpDir, "plain.docx");
    await fs.writeFile(filePath, await buildDocx("plain"));
    const opened = await openFromDisk(filePath);
    setActiveDocId(opened.documentId);

    // A snapshot-shaped name that does not exist → FILE_NOT_FOUND (docx now
    // flows through the shared snapshot restore, no longer a FORMAT_ERROR).
    const missing = parseResult(
      await restoreTool({ backup: "plain-20260101-100000-aaaaaaaa.docx" }),
    );
    expect(missing.error).toBe(true);
    expect(missing.code).toBe("FILE_NOT_FOUND");

    // No snapshots and no sidecar → FILE_NOT_FOUND.
    const noBackup = parseResult(await restoreTool({}));
    expect(noBackup.error).toBe(true);
    expect(noBackup.code).toBe("FILE_NOT_FOUND");
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

  it("lists .docx snapshots when they exist (omit `backup`)", async () => {
    const filePath = path.join(tmpDir, "memo.docx");
    await fs.writeFile(filePath, await buildDocx("memo v1"));
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    addDoc("docx-list", {
      id: "docx-list",
      filePath,
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId("docx-list");

    const parsed = parseResult(await restoreTool({}));
    expect(parsed.error).toBe(false);
    const backups = parsed.data?.backups as Array<{ name: string }>;
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toMatch(/^memo-\d{8}-\d{6}-[0-9a-f]{8}\.docx$/);
  });

  it("restores a named .docx snapshot (byte-identical, reloads the doc)", async () => {
    const filePath = path.join(tmpDir, "draft.docx");
    const v1 = await buildDocx("draft good");
    await fs.writeFile(filePath, v1);
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());
    await fs.writeFile(filePath, await buildDocx("draft ruined"));
    const opened = await openFromDisk(filePath);
    setActiveDocId(opened.documentId);

    _resetDocBackupGateForTests();
    const parsed = parseResult(await restoreTool({ backup: snapshot.name }));
    expect(parsed.error).toBe(false);
    expect((await fs.readFile(filePath)).equals(v1)).toBe(true);
    expect(extractText(getOrCreateDocument(opened.documentId))).toContain("good");
  });
});
