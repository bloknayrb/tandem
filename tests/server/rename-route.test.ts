import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorCodeToHttpStatus } from "../../src/server/mcp/routes/_shared.js";

// Mock the service so the route test exercises only the handler's contract:
// param validation + error-code → HTTP-status mapping. The migration itself is
// covered by rename-document.test.ts.
const renameDocument = vi.fn();
vi.mock("../../src/server/mcp/document-service.js", () => ({ renameDocument }));

const { handleRename } = await import("../../src/server/mcp/routes/rename.js");

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

const reqWith = (body: unknown) => ({ body }) as Request;

beforeEach(() => renameDocument.mockReset());

describe("handleRename — param validation", () => {
  it("400s when documentId is missing", async () => {
    const res = mockRes();
    await handleRename(reqWith({ newName: "x.md" }), res);
    expect(res._status).toBe(400);
    expect(renameDocument).not.toHaveBeenCalled();
  });

  it("400s when newName is missing", async () => {
    const res = mockRes();
    await handleRename(reqWith({ documentId: "d1" }), res);
    expect(res._status).toBe(400);
    expect(renameDocument).not.toHaveBeenCalled();
  });

  it("400s when newName is the wrong type", async () => {
    const res = mockRes();
    await handleRename(reqWith({ documentId: "d1", newName: 42 }), res);
    expect(res._status).toBe(400);
    expect(renameDocument).not.toHaveBeenCalled();
  });

  it("tolerates a missing body object", async () => {
    const res = mockRes();
    await handleRename(reqWith(undefined), res);
    expect(res._status).toBe(400);
  });
});

describe("handleRename — success + error mapping", () => {
  it("returns the rename data on success", async () => {
    renameDocument.mockResolvedValue({
      status: "renamed",
      oldPath: "/d/a.md",
      newPath: "/d/b.md",
      fileName: "b.md",
    });
    const res = mockRes();
    await handleRename(reqWith({ documentId: "d1", newName: "b.md" }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      data: { oldPath: "/d/a.md", newPath: "/d/b.md", fileName: "b.md" },
    });
  });

  it.each([
    { code: "NOT_FOUND", status: 404 },
    { code: "READ_ONLY", status: 403 },
    { code: "NOT_RENAMABLE", status: 409 },
    { code: "ALREADY_EXISTS", status: 409 },
    { code: "RENAME_IN_PROGRESS", status: 409 },
    { code: "INVALID_NAME", status: 400 },
    { code: "EXTENSION_MISMATCH", status: 400 },
    { code: "PATH_REJECTED", status: 400 },
    { code: "INVALID_PATH", status: 400 },
  ])("maps $code → $status", async ({ code, status }) => {
    renameDocument.mockResolvedValue({ status: "error", errorCode: code, reason: "nope" });
    const res = mockRes();
    await handleRename(reqWith({ documentId: "d1", newName: "b.md" }), res);
    expect(res._status).toBe(status);
    expect(res._json).toEqual({ error: code, message: "nope" });
  });
});

describe("handleRename — boundary sanitization (CodeQL path-injection barrier)", () => {
  // path.basename() on both inputs is the live taint-barrier the CodeQL gate
  // requires, and the basename'd binding is what flows to the (mocked here)
  // renameDocument sink. The handler NORMALIZES a path-like input to its last
  // component (matching the `tandem_rename` MCP handler, which basenames the
  // same way) rather than rejecting it — so separators and single-char drive
  // prefixes are stripped, while every other illegal name survives basename and
  // is rejected downstream by renameDocument's validateRenameFilename. These go
  // RED if the basename() calls are ever removed as "redundant".
  it("strips path separators from newName before calling renameDocument", async () => {
    renameDocument.mockResolvedValue({
      status: "renamed",
      oldPath: "/d/a.md",
      newPath: "/d/b.md",
      fileName: "b.md",
    });
    await handleRename(reqWith({ documentId: "d1", newName: "sub/b.md" }), mockRes());
    expect(renameDocument).toHaveBeenCalledWith("d1", "b.md");
  });

  it("strips path separators from documentId before calling renameDocument", async () => {
    renameDocument.mockResolvedValue({
      status: "renamed",
      oldPath: "/d/a.md",
      newPath: "/d/b.md",
      fileName: "b.md",
    });
    await handleRename(reqWith({ documentId: "../../etc/d1", newName: "b.md" }), mockRes());
    expect(renameDocument).toHaveBeenCalledWith("d1", "b.md");
  });

  it("400s (INVALID_PATH) when newName basenames to empty, without calling renameDocument", async () => {
    const res = mockRes();
    await handleRename(reqWith({ documentId: "d1", newName: "/" }), res);
    expect(res._status).toBe(400);
    expect(res._json).toEqual({ error: "INVALID_PATH", message: "newName must not be empty" });
    expect(renameDocument).not.toHaveBeenCalled();
  });
});

describe("errorCodeToHttpStatus — rename codes", () => {
  it.each([
    ["INVALID_NAME", 400],
    ["EXTENSION_MISMATCH", 400],
    ["PATH_REJECTED", 400],
    ["READ_ONLY", 403],
    ["NOT_RENAMABLE", 409],
    ["ALREADY_EXISTS", 409],
    ["RENAME_IN_PROGRESS", 409],
  ])("%s → %i", (code, status) => {
    expect(errorCodeToHttpStatus(code)).toBe(status);
  });
});
