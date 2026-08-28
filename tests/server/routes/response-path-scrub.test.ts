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

// An allowlisted Origin is now required by handleSave/handleConvert/
// handleApplyChanges (assertOriginAllowlisted). These specs are about path
// scrubbing, not about the gate, so the stub supplies one and the gate gets its
// own specs at the bottom of the file. `origin` is overridable so those can
// omit it.
const reqWith = (
  body: unknown,
  remoteAddress = "192.168.1.50",
  headers: Record<string, string> = { origin: "http://127.0.0.1:5173" },
) => ({ body, headers, socket: { remoteAddress } }) as unknown as Request;

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

describe("the simple-request CSRF gate (#1295's class, second instance)", () => {
  // These run the ACTUAL attack shape rather than asserting a gate exists: no
  // Origin header, which is what a page's `no-cors` POST looks like from the
  // handler's side once express.json has declined to parse a `text/plain` body.
  //
  // Each asserts BOTH halves, and the second is the load-bearing one. A status
  // check alone is satisfied by a handler that calls the gate WITHOUT the
  // `return` -- res.status(403) fires, the handler runs on, the side effect
  // happens anyway, and the later res.json throws ERR_HTTP_HEADERS_SENT after
  // the damage. So every spec here also asserts the side-effect mock was never
  // reached.
  const noOrigin = (body: unknown) => reqWith(body, "127.0.0.1", {});

  it("refuses handleSave and does not touch the file on disk", async () => {
    const res = mockRes();
    await handleSave(noOrigin({ documentId: "d1" }), res);
    expect(res._status).toBe(403);
    expect(
      saveDocumentToDisk,
      "the save happened before the refusal -- the gate is missing its `return`",
    ).not.toHaveBeenCalled();
  });

  it("refuses handleConvert and does not write a new file", async () => {
    const res = mockRes();
    await handleConvert(noOrigin({ documentId: "d1" }), res);
    expect(res._status).toBe(403);
    expect(convertToMarkdown).not.toHaveBeenCalled();
  });

  it("refuses handleApplyChanges and does not apply", async () => {
    const res = mockRes();
    await handleApplyChanges(noOrigin({ documentId: "d1" }), res);
    expect(res._status).toBe(403);
    expect(applyChangesCore).not.toHaveBeenCalled();
  });

  it("still admits an allowlisted Origin — the required-GREEN control", async () => {
    // Without this, "refuse everything" passes all three specs above.
    const res = mockRes();
    await handleConvert(reqWith({ documentId: "d1" }, "127.0.0.1"), res);
    expect(res._status).not.toBe(403);
    expect(convertToMarkdown).toHaveBeenCalled();
  });
});
