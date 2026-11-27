/**
 * ADR-057, PR 4: `GET /api/document/compare` — the document now against the
 * file on disk or a backup, loopback-only, bounded, never echoing a path.
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
import { markDirty } from "../../src/server/documents/dirty.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  _resetDocBackupGateForTests,
  docBackupsRoot,
  listDocBackups,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  COMPARE_MAX_BYTES,
  handleGetDocumentCompare,
} from "../../src/server/mcp/routes/compare.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { withMcp } from "../../src/shared/origins.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  _resetDocBackupGateForTests();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-cmp-"));
  await fs.rm(docBackupsRoot(resolveAppDataDir()), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

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

const req = (query: Record<string, unknown>, remoteAddress = "127.0.0.1"): Request =>
  ({ headers: {}, socket: { remoteAddress }, query, body: {} }) as unknown as Request;

async function call(query: Record<string, unknown>, remote?: string) {
  const res = mockRes();
  await handleGetDocumentCompare(req(query, remote), res);
  return res;
}

/** Open `name` with `disk` on disk, then give it unsaved edits `edited`. */
async function opened(name: string, disk: string, edited?: string) {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, disk);
  const { documentId: id } = await openFromDisk(filePath);
  if (edited !== undefined) {
    const doc = getOrCreateDocument(id);
    const adapter = getAdapter(name.endsWith(".txt") ? "txt" : "md");
    const prepared = await adapter.parse(edited);
    withMcp(doc, () => adapter.apply(doc, prepared, { fileName: name }));
    markDirty(id);
  }
  return { filePath, id };
}

const data = (res: { _json: unknown }) =>
  (
    res._json as {
      data: { current: string; other: string; otherLabel: string; truncated: boolean };
    }
  ).data;

describe("GET /api/document/compare", () => {
  it("refuses a non-loopback caller before looking anything up", async () => {
    const spy = vi.spyOn(fs, "open");
    const res = await call({ documentId: "anything", against: "disk" }, "192.168.1.9");
    expect(res._status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("compares the document now with the file on disk", async () => {
    const { filePath, id } = await opened("doc.md", "first version\n", "edited version\n");
    await fs.writeFile(filePath, "\uFEFFdisk line one\r\ndisk line two\r\n");
    const res = await call({ documentId: id, against: "disk" });
    expect(res._status).toBe(200);
    const d = data(res);
    expect(d.otherLabel).toBe("disk");
    expect(d.current).toContain("edited version");
    // BOM stripped, CRLF normalized.
    expect(d.other).toBe("disk line one\ndisk line two\n");
    expect(d.truncated).toBe(false);
  });

  it("compares with a backup named by the listing", async () => {
    const { filePath, id } = await opened("named.md", "the original\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const [snap] = await listDocBackups(filePath, resolveAppDataDir());
    const res = await call({ documentId: id, against: snap.name });
    expect(res._status).toBe(200);
    expect(data(res)).toMatchObject({ other: "the original\n", otherLabel: "disk-backup" });
  });

  it("answers 404 for an unknown or traversal-looking backup name, without reading it", async () => {
    const { filePath, id } = await opened("names.md", "x\n");
    await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() });
    const spy = vi.spyOn(fs, "open");
    for (const against of [
      "nope-20260101-000000-abcdef12.md",
      "../../../etc/passwd",
      "source.txt",
    ]) {
      const res = await call({ documentId: id, against });
      expect(res._status, against).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("validates its query", async () => {
    const { id } = await opened("q.md", "x\n");
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ against: "disk" }, 400],
      [{ documentId: `dir/${id}`, against: "disk" }, 400],
      [{ documentId: id }, 400],
      [{ documentId: id, against: ["a", "b"] }, 400],
      [{ documentId: id, against: "" }, 400],
      [{ documentId: "aaaaaaaaaaaa", against: "disk" }, 404],
    ];
    for (const [query, status] of cases) {
      const res = await call(query);
      expect(res._status, JSON.stringify(query)).toBe(status);
    }
  });

  it("refuses a format without plain text on both sides", async () => {
    const { id } = await opened("page.html", "<p>x</p>\n");
    const res = await call({ documentId: id, against: "disk" });
    expect(res._status).toBe(400);
  });

  it("answers 404 with no path when the file is gone", async () => {
    const { filePath, id } = await opened("gone.md", "x\n");
    await fs.rm(filePath);
    const res = await call({ documentId: id, against: "disk" });
    expect(res._status).toBe(404);
    expect(JSON.stringify(res._json)).not.toContain(tmpDir);
  });

  it("reads at most the cap of a file that grew, and says it was cut", async () => {
    const { filePath, id } = await opened("big.txt", "small\n");
    await fs.writeFile(filePath, "x".repeat(COMPARE_MAX_BYTES + 10));
    const res = await call({ documentId: id, against: "disk" });
    expect(res._status).toBe(200);
    expect(data(res).other.length).toBe(COMPARE_MAX_BYTES);
    expect(data(res).truncated).toBe(true);
  });
});

describe("registration", () => {
  it("sits behind the API middleware (its Host check is what stops DNS rebinding)", async () => {
    const src = await fs.readFile(
      path.join(__dirname, "../../src/server/mcp/api-routes.ts"),
      "utf-8",
    );
    expect(src).toMatch(/app\.get\(API_DOCUMENT_COMPARE, mw, handleGetDocumentCompare\)/);
  });
});
