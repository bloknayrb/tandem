/**
 * `POST /api/save` — how `allowImageLoss` is PARSED (#1941).
 *
 * Every assertion is over the ARGUMENT handed to `saveDocumentToDisk`, never
 * over the outcome. `saveDocumentToDisk` is mocked here (as it is in
 * `response-path-scrub.test.ts`, the only other harness that drives this
 * handler without opening a document) and the refusal itself lives inside it,
 * so an outcome assertion would pass however the route parsed the field —
 * including not parsing it at all.
 *
 * `/api/save` overwrites the user's open document, and a `text/plain` POST is a
 * SIMPLE request: no preflight, `express.json()` leaves `req.body` undefined,
 * and the handler tolerates that. So the field's default under every parse
 * failure is the security-relevant half, not the happy path.
 *
 * Every case supplies an allowlisted Origin. Without one `assertOriginAllowlisted`
 * 403s at the top of the handler and these specs would measure the gate instead
 * of the parse.
 */
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveDocumentToDisk = vi.fn();
const persistSkippedSaveSession = vi.fn();
const getActiveDocId = vi.fn(() => "d1");
const saveDocumentAsToDisk = vi.fn();
const serializeDocument = vi.fn();
const closeDocumentById = vi.fn();
vi.mock(import("../../../src/server/mcp/document-service.js"), () => ({
  closeDocumentById,
  saveDocumentToDisk,
  persistSkippedSaveSession,
  getActiveDocId,
  saveDocumentAsToDisk,
  serializeDocument,
}));

const { handleSave } = await import("../../../src/server/mcp/routes/save.js");

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

/** `body` is passed as express would leave it — `undefined` for a `text/plain`
 * POST that `express.json()` never parsed. */
const reqWith = (body: unknown): Request =>
  ({
    body,
    headers: { origin: "http://127.0.0.1:5173" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  getActiveDocId.mockReturnValue("d1");
  saveDocumentToDisk.mockResolvedValue({ status: "saved", filePath: "/tmp/x.docx" });
});

describe("POST /api/save — allowImageLoss parsing (#1941)", () => {
  it("passes allowImageLoss: true only for a real boolean true", async () => {
    await handleSave(reqWith({ documentId: "d1", allowImageLoss: true }), mockRes());
    expect(saveDocumentToDisk).toHaveBeenCalledWith(
      "d1",
      "manual",
      expect.objectContaining({ allowImageLoss: true }),
    );
  });

  it("defaults to false when the body was never parsed (text/plain POST)", async () => {
    // The CSRF shape: a simple request whose body express.json() skipped. The
    // handler tolerates `undefined` by design, so the field must default to
    // refusing rather than to whatever truthiness says about `undefined`.
    await handleSave(reqWith(undefined), mockRes());
    expect(saveDocumentToDisk).toHaveBeenCalledWith(
      "d1",
      "manual",
      expect.objectContaining({ allowImageLoss: false }),
    );
  });

  it("defaults to false for the STRING 'true' — no truthiness parsing", async () => {
    await handleSave(reqWith({ documentId: "d1", allowImageLoss: "true" }), mockRes());
    expect(saveDocumentToDisk).toHaveBeenCalledWith(
      "d1",
      "manual",
      expect.objectContaining({ allowImageLoss: false }),
    );
  });

  it("defaults to false for the NUMBER 1", async () => {
    await handleSave(reqWith({ documentId: "d1", allowImageLoss: 1 }), mockRes());
    expect(saveDocumentToDisk).toHaveBeenCalledWith(
      "d1",
      "manual",
      expect.objectContaining({ allowImageLoss: false }),
    );
  });

  it("defaults to false when the field is absent from a parsed body", async () => {
    await handleSave(reqWith({ documentId: "d1" }), mockRes());
    expect(saveDocumentToDisk).toHaveBeenCalledWith(
      "d1",
      "manual",
      expect.objectContaining({ allowImageLoss: false }),
    );
  });

  it("still refuses a missing Origin — the field does not reach the save at all", async () => {
    // The gate this route gained to close the simple-request CSRF is unchanged
    // by #1941, and a new optional field must not open a path around it.
    const res = mockRes();
    await handleSave(
      {
        body: { documentId: "d1", allowImageLoss: true },
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as Request,
      res,
    );
    expect(res._status).toBe(403);
    expect(saveDocumentToDisk).not.toHaveBeenCalled();
  });
});
