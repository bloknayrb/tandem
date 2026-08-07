/**
 * #1294 follow-up — absolute paths the CALLER NEVER SUPPLIED must not reach a
 * non-loopback caller in a success body either.
 *
 * The grep that found these was derived from the defect class, not from the
 * list of already-fixed sites: any absolute path reaching a response body, on
 * any branch. Routes whose path IS the caller's own input (`/api/open`,
 * save-as's `targetPath`, convert with an explicit `outputPath`) are
 * deliberately absent — echoing back what you were handed discloses nothing.
 *
 * Every case pairs a non-loopback ABSENCE assertion with a loopback POSITIVE
 * CONTROL on the same sample.
 */
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeDocumentById = vi.fn();
const saveDocumentToDisk = vi.fn();
const persistSkippedSaveSession = vi.fn();
const getActiveDocId = vi.fn(() => "d1");
const saveDocumentAsToDisk = vi.fn();
const serializeDocument = vi.fn();
vi.mock("../../../src/server/mcp/document-service.js", () => ({
  closeDocumentById,
  saveDocumentToDisk,
  persistSkippedSaveSession,
  getActiveDocId,
  saveDocumentAsToDisk,
  serializeDocument,
}));

const convertToMarkdown = vi.fn();
vi.mock("../../../src/server/mcp/convert.js", () => ({ convertToMarkdown }));

const applyChangesCore = vi.fn();
vi.mock("../../../src/server/mcp/docx-apply.js", () => ({ applyChangesCore }));

const { handleClose } = await import("../../../src/server/mcp/routes/close.js");
const { handleConvert } = await import("../../../src/server/mcp/routes/convert.js");
const { handleSave } = await import("../../../src/server/mcp/routes/save.js");
const { handleApplyChanges } = await import("../../../src/server/mcp/routes/apply-changes.js");

const HOME_DOC = "/home/alice/Documents/Q3-plan.md";

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

const reqWith = (body: unknown, remoteAddress = "192.168.1.50") =>
  ({ body, headers: {}, socket: { remoteAddress } }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  getActiveDocId.mockReturnValue("d1");
});

describe("POST /api/close — closedPath", () => {
  beforeEach(() => {
    closeDocumentById.mockResolvedValue({
      success: true,
      closedPath: HOME_DOC,
      activeDocumentId: "d2",
    });
  });

  it("basenames closedPath for a LAN caller", async () => {
    // The caller supplied only a documentId; the path came from docState.
    const res = mockRes();
    await handleClose(reqWith({ documentId: "d1" }), res);
    expect(JSON.stringify(res._json)).not.toContain("alice");
    expect(res._json).toEqual({ data: { closedPath: "Q3-plan.md", activeDocumentId: "d2" } });
  });

  it("still returns the real path to a loopback caller", async () => {
    const res = mockRes();
    await handleClose(reqWith({ documentId: "d1" }, "127.0.0.1"), res);
    expect(JSON.stringify(res._json)).toContain(HOME_DOC);
  });
});

describe("POST /api/convert — outputPath", () => {
  beforeEach(() => {
    convertToMarkdown.mockResolvedValue({
      outputPath: "/home/alice/Documents/Q3-plan.md",
      documentId: "d9",
      fileName: "Q3-plan.md",
    });
  });

  it("basenames a server-derived outputPath for a LAN caller", async () => {
    const res = mockRes();
    await handleConvert(reqWith({ documentId: "d1" }), res);
    expect(JSON.stringify(res._json)).not.toContain("alice");
    expect((res._json as { data: { outputPath: string } }).data.outputPath).toBe("Q3-plan.md");
  });

  it("still returns the real path to a loopback caller", async () => {
    const res = mockRes();
    await handleConvert(reqWith({ documentId: "d1" }, "127.0.0.1"), res);
    expect(JSON.stringify(res._json)).toContain(HOME_DOC);
  });
});

describe("POST /api/save — the 200-with-error branch", () => {
  const RAW = `EACCES: permission denied, open '${HOME_DOC}'`;

  beforeEach(() => {
    saveDocumentToDisk.mockResolvedValue({ status: "error", reason: RAW, errorCode: "EACCES" });
  });

  it("drops the raw write error for a LAN caller", async () => {
    // This branch reports failure inside a 200 body, so sendApiError's scrub
    // never sees it — a different envelope for the same disclosure.
    const res = mockRes();
    await handleSave(reqWith({ documentId: "d1" }), res);
    expect(JSON.stringify(res._json)).not.toContain("alice");
    expect(JSON.stringify(res._json)).not.toContain("/home");
    // status still carries the actionable signal.
    expect((res._json as { data: { status: string } }).data.status).toBe("error");
  });

  it("still returns the raw reason to a loopback caller", async () => {
    const res = mockRes();
    await handleSave(reqWith({ documentId: "d1" }, "127.0.0.1"), res);
    expect(JSON.stringify(res._json)).toContain(HOME_DOC);
  });
});

describe("POST /api/apply-changes — derived backupPath", () => {
  beforeEach(() => {
    applyChangesCore.mockResolvedValue({
      applied: 2,
      rejected: 0,
      rejectedDetails: [],
      commentsResolved: 1,
      backupPath: "/home/alice/Documents/Q3-plan.backup.docx",
    });
  });

  it("basenames a backupPath the caller did not supply", async () => {
    const res = mockRes();
    await handleApplyChanges(reqWith({ documentId: "d1" }), res);
    expect(JSON.stringify(res._json)).not.toContain("alice");
    expect((res._json as { data: { backupPath: string } }).data.backupPath).toBe(
      "Q3-plan.backup.docx",
    );
  });

  it("still returns the real path to a loopback caller", async () => {
    const res = mockRes();
    await handleApplyChanges(reqWith({ documentId: "d1" }, "127.0.0.1"), res);
    expect(JSON.stringify(res._json)).toContain("/home/alice/Documents/Q3-plan.backup.docx");
  });
});
