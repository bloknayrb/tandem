/**
 * Security gate tests for issue #1121 (F5 path-stripping + F6 origin/loopback
 * gates) on the document-mutation and content-exposure routes.
 *
 * Tests use direct handler calls with mock req/res so they run without spinning
 * up a real HTTP server. The isLoopback mock lets us simulate non-loopback
 * callers for the F5 path-stripping assertions.
 */

import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";

// ---------------------------------------------------------------------------
// Mocks must be declared before any module imports that transitively load them.
// vi.hoisted() ensures these are initialized before the hoisted vi.mock() calls.
// ---------------------------------------------------------------------------

const {
  isLoopbackMock,
  getCurrentDoc,
  listDocBackups,
  resolveAppDataDir,
  restoreDocumentFromBackup,
  reloadDocumentFromMarkdown,
  resolveExternalConflict,
  getActiveDocId,
  hasDoc,
} = vi.hoisted(() => ({
  isLoopbackMock: vi.fn(() => true),
  getCurrentDoc: vi.fn(),
  listDocBackups: vi.fn(),
  resolveAppDataDir: vi.fn(() => "/tmp/app-data"),
  restoreDocumentFromBackup: vi.fn(),
  reloadDocumentFromMarkdown: vi.fn(),
  resolveExternalConflict: vi.fn(),
  getActiveDocId: vi.fn(),
  hasDoc: vi.fn(() => true),
}));

vi.mock("../../src/server/auth/middleware.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/auth/middleware.js")>();
  return { ...original, isLoopback: (...args: unknown[]) => isLoopbackMock(...args) };
});

vi.mock("../../src/server/mcp/document-service.js", () => ({ getCurrentDoc }));
vi.mock("../../src/server/file-io/doc-backup.js", () => ({ listDocBackups }));
vi.mock("../../src/server/platform.js", () => ({ resolveAppDataDir }));
vi.mock("../../src/server/mcp/file-opener.js", () => ({
  restoreDocumentFromBackup,
  reloadDocumentFromMarkdown,
  resolveExternalConflict,
}));
vi.mock("../../src/server/documents/registry.js", () => ({ getActiveDocId, hasDoc }));

import { handleListBackups, handleRestoreBackup } from "../../src/server/mcp/routes/backups.js";
import { handleGetDocumentRaw } from "../../src/server/mcp/routes/document-raw.js";
import { handleReloadFromMarkdown } from "../../src/server/mcp/routes/document-reload.js";
import { handleResolveDocxConflict } from "../../src/server/mcp/routes/docx-conflict.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const loopbackReq = (extra: Partial<Request> = {}): Request =>
  ({
    headers: { origin: `http://${TAURI_HOSTNAME}` },
    socket: { remoteAddress: "127.0.0.1" },
    query: {},
    body: {},
    ...extra,
  }) as unknown as Request;

const nonLoopbackReq = (extra: Partial<Request> = {}): Request =>
  ({
    headers: { origin: `http://${TAURI_HOSTNAME}` },
    socket: { remoteAddress: "192.168.1.42" },
    query: {},
    body: {},
    ...extra,
  }) as unknown as Request;

const badOriginReq = (extra: Partial<Request> = {}): Request =>
  ({
    headers: { origin: "http://attacker.example" },
    socket: { remoteAddress: "127.0.0.1" },
    query: {},
    body: {},
    ...extra,
  }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  isLoopbackMock.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// F5: GET /api/backups — path stripping for non-loopback callers
// ---------------------------------------------------------------------------

describe("GET /api/backups — path stripping (#1121 F5)", () => {
  it("returns full filePath for loopback callers", async () => {
    isLoopbackMock.mockReturnValue(true);
    getCurrentDoc.mockReturnValue({
      id: "d1",
      filePath: "/home/user/Documents/work.md",
      source: "file",
    });
    listDocBackups.mockResolvedValue([]);
    const res = mockRes();
    await handleListBackups(loopbackReq(), res);
    expect(res._status).toBe(200);
    expect((res._json as { data: { filePath: string } }).data.filePath).toBe(
      "/home/user/Documents/work.md",
    );
  });

  it("strips filePath to basename for non-loopback callers", async () => {
    isLoopbackMock.mockReturnValue(false);
    getCurrentDoc.mockReturnValue({
      id: "d1",
      filePath: "/home/user/Documents/work.md",
      source: "file",
    });
    listDocBackups.mockResolvedValue([]);
    const res = mockRes();
    await handleListBackups(nonLoopbackReq(), res);
    expect(res._status).toBe(200);
    expect((res._json as { data: { filePath: string } }).data.filePath).toBe("work.md");
  });

  it("returns filePath: null for non-file source documents regardless of caller", async () => {
    isLoopbackMock.mockReturnValue(false);
    getCurrentDoc.mockReturnValue({ id: "s1", filePath: "upload://x/f.md", source: "upload" });
    const res = mockRes();
    await handleListBackups(nonLoopbackReq(), res);
    expect(res._status).toBe(200);
    expect((res._json as { data: { filePath: null } }).data.filePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F5: GET /api/document/raw — loopback-only gate
// ---------------------------------------------------------------------------

describe("GET /api/document/raw — loopback-only gate (#1121 F5)", () => {
  it("returns 403 for non-loopback callers", async () => {
    isLoopbackMock.mockReturnValue(false);
    const res = mockRes();
    handleGetDocumentRaw(nonLoopbackReq(), res);
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe("FORBIDDEN");
  });

  it("does not return 403 for loopback callers (proceeds to document lookup)", async () => {
    isLoopbackMock.mockReturnValue(true);
    getActiveDocId.mockReturnValue(null);
    const res = mockRes();
    handleGetDocumentRaw(loopbackReq({ query: {} }), res);
    // Reaches the "no active document" check (not the loopback gate).
    expect(res._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// F6: POST /api/backups/restore — origin gate
// ---------------------------------------------------------------------------

describe("POST /api/backups/restore — origin gate (#1121 F6)", () => {
  it("rejects a non-allowlisted Origin before restoring", async () => {
    const res = mockRes();
    await handleRestoreBackup(badOriginReq({ body: { backup: "snap.md" } }), res);
    expect(res._status).toBe(403);
    expect(restoreDocumentFromBackup).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin before restoring", async () => {
    const res = mockRes();
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      body: { backup: "s.md" },
    } as unknown as Request;
    await handleRestoreBackup(req, res);
    expect(res._status).toBe(403);
    expect(restoreDocumentFromBackup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6: POST /api/document/reload — origin gate
// ---------------------------------------------------------------------------

describe("POST /api/document/reload — origin gate (#1121 F6)", () => {
  it("rejects a non-allowlisted Origin before reloading", async () => {
    const res = mockRes();
    await handleReloadFromMarkdown(badOriginReq({ body: { markdown: "# hi" } }), res);
    expect(res._status).toBe(403);
    expect(reloadDocumentFromMarkdown).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin before reloading", async () => {
    const res = mockRes();
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      body: { markdown: "# hi" },
    } as unknown as Request;
    await handleReloadFromMarkdown(req, res);
    expect(res._status).toBe(403);
    expect(reloadDocumentFromMarkdown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6: POST /api/docx-conflict/resolve — origin gate
// ---------------------------------------------------------------------------

describe("POST /api/docx-conflict/resolve — origin gate (#1121 F6)", () => {
  it("rejects a non-allowlisted Origin before resolving", async () => {
    const res = mockRes();
    await handleResolveDocxConflict(badOriginReq({ body: { choice: "keep" } }), res);
    expect(res._status).toBe(403);
    expect(resolveExternalConflict).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin before resolving", async () => {
    const res = mockRes();
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      body: { choice: "reload" },
    } as unknown as Request;
    await handleResolveDocxConflict(req, res);
    expect(res._status).toBe(403);
    expect(resolveExternalConflict).not.toHaveBeenCalled();
  });
});
