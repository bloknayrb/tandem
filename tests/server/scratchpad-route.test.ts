import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openScratchpad = vi.hoisted(() =>
  vi.fn(async (content?: string) => ({
    kind: "fresh" as const,
    documentId: "scratch",
    filePath: "scratchpad://scratch",
    fileName: "Scratchpad.md",
    format: "md",
    readOnly: false,
    source: "upload" as const,
    tokenEstimate: content?.length ?? 0,
    pageEstimate: 1,
  })),
);
// Mocked at the module the route actually imports (ADR-034 seam), not at the
// implementation behind it. A partial factory for `file-opener.js` left the
// seam's other two re-exports resolving to `undefined` — tolerated by Vite's
// SSR transform, a link error under a real ESM linker.
//
// Spread over `importActual` for the same reason, and it is load-bearing: the
// route also calls `toWireResult`, and a factory naming only `openScratchpad`
// made it `undefined`, so every success turned into a 500 the route reported
// as INTERNAL. Re-stating the projector here instead would be a second copy of
// the one thing Unit 7b exists to keep single.
vi.mock("../../src/server/documents/open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/documents/open.js")>()),
  openScratchpad,
}));

import { handleScratchpad } from "../../src/server/mcp/routes/scratchpad";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";

/**
 * Since #1295 L1 this route gates on origin + loopback like every sibling
 * mutator, so a request double must carry both. The bare `{ body }` doubles
 * these tests used before modelled a caller that cannot exist.
 */
function reqDouble(body: unknown, over: { origin?: string; remoteAddress?: string } = {}): Request {
  return {
    body,
    headers: { origin: over.origin ?? `http://${TAURI_HOSTNAME}` },
    socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" },
  } as unknown as Request;
}

function responseDouble(): {
  response: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  const json = vi.fn();
  const response = { status, json } as unknown as Response;
  status.mockReturnValue(response);
  json.mockReturnValue(response);
  return { response, status, json };
}

describe("POST /api/scratchpad input", () => {
  beforeEach(() => openScratchpad.mockClear());

  it("passes validated inline Markdown to the seeded scratchpad", async () => {
    const { response, json } = responseDouble();
    await handleScratchpad(reqDouble({ content: "# Export\n\nbody" }), response);
    expect(openScratchpad).toHaveBeenCalledWith("# Export\n\nbody");
    expect(json).toHaveBeenCalledWith({ data: expect.objectContaining({ documentId: "scratch" }) });
  });

  it("rejects non-string, unknown, and over-1-MiB bodies without opening a blank scratchpad", async () => {
    for (const body of [
      { content: 42 },
      { content: "ok", path: "C:\\private.md" },
      { content: "x".repeat(1024 * 1024 + 1) },
    ]) {
      const { response, status } = responseDouble();
      await handleScratchpad(reqDouble(body), response);
      expect(status).toHaveBeenCalledWith(body.content === 42 || "path" in body ? 400 : 413);
    }
    expect(openScratchpad).not.toHaveBeenCalled();
  });
});

describe("POST /api/scratchpad gates (#1295 L1)", () => {
  beforeEach(() => openScratchpad.mockClear());

  it("rejects a cross-origin drive-by before opening anything", async () => {
    // The concrete attack: any page the user visits issues a SIMPLE request
    // (text/plain ⇒ no preflight), the socket is loopback so auth is bypassed,
    // and express.json leaves req.body undefined — which this handler
    // explicitly permits. openScratchpad would then call setActiveDocId,
    // silently flipping the server's active document, which becomes the
    // implicit target of any later documentId-less MCP call.
    const { response, status } = responseDouble();
    await handleScratchpad(reqDouble(undefined, { origin: "https://evil.example" }), response);
    expect(status).toHaveBeenCalledWith(403);
    expect(openScratchpad).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin at all", async () => {
    // Unlike /api/shutdown, which deliberately permits an absent Origin for the
    // Tauri shell's reqwest client, every caller of this route is a browser
    // fetch (App.svelte and actions/builtin.svelte.ts) and always sends one.
    const { response, status } = responseDouble();
    const req = { body: undefined, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
    await handleScratchpad(req as unknown as Request, response);
    expect(status).toHaveBeenCalledWith(403);
    expect(openScratchpad).not.toHaveBeenCalled();
  });

  it("still opens a blank scratchpad for the real local caller", async () => {
    // Positive control on the same sample: the assertions above would also pass
    // against a handler that rejected everything, which is not the fix.
    const { response, json } = responseDouble();
    await handleScratchpad(reqDouble(undefined), response);
    expect(openScratchpad).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ data: expect.objectContaining({ documentId: "scratch" }) });
  });
});
