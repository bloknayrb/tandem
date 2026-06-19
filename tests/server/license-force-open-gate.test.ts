import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1116 H1: the DESTRUCTIVE force-reload sub-path of open must be license-gated
 * on BOTH transports (MCP `tandem_open` + HTTP `/api/open`), while PLAIN open
 * stays ungated (the read/export escape hatch). force=true runs `clearAndReload`,
 * which wipes the durable annotation store — an editing-class op a restricted
 * user must not reach.
 *
 * Outcome test (not a source scan): mock `licenseGate` to restrict, and use a
 * NONEXISTENT path. If the gate fires first, the handler returns the block
 * envelope and never reaches `openFileByPath`. If the gate is missing,
 * `openFileByPath` runs and throws FILE_NOT_FOUND — a DIFFERENT envelope. So
 * "returned the block" ⟺ "gate ran before the destructive open". `gatedTool` is
 * left real (spread `...actual`) so the other tool registrations still wire up.
 */

const BLOCK = { content: [{ type: "text", text: "RESTRICTED" }], isError: true } as const;

vi.mock("../../src/server/mcp/license-gate.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, licenseGate: vi.fn() };
});

import { registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs, removeDoc } from "../../src/server/mcp/document-service.js";
import { licenseGate } from "../../src/server/mcp/license-gate.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import { removeDocument } from "../../src/server/yjs/provider.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function captureTandemOpen(): Handler {
  const tools: Record<string, Handler> = {};
  // registerDocumentTools registers via BOTH server.tool(name, desc, schema, handler)
  // and server.registerTool(name, config, handler) — the handler is the LAST arg in
  // either form, so capture it generically by name.
  const capture = (name: string, ...rest: unknown[]) => {
    tools[name] = rest[rest.length - 1] as Handler;
  };
  const fakeServer = { tool: capture, registerTool: capture };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDocumentTools(fakeServer as any);
  return tools.tandem_open;
}

function mockRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}

const MISSING = path.join(os.tmpdir(), "tandem-no-such-file-xyz.md");

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const id of getOpenDocs().keys()) {
    removeDoc(id);
    removeDocument(id);
  }
});

describe("MCP tandem_open — force sub-path gate", () => {
  it("restricted + force:true ⇒ returns the block envelope (never reaches open)", async () => {
    (licenseGate as ReturnType<typeof vi.fn>).mockReturnValue(BLOCK);
    const tandemOpen = captureTandemOpen();
    const result = await tandemOpen({ filePath: MISSING, force: true });
    expect(result).toBe(BLOCK);
  });

  it("restricted + plain open ⇒ NOT blocked (proceeds to open → FILE_NOT_FOUND)", async () => {
    (licenseGate as ReturnType<typeof vi.fn>).mockReturnValue(BLOCK);
    const tandemOpen = captureTandemOpen();
    const result = await tandemOpen({ filePath: MISSING });
    // The gate isn't consulted on a non-force open, so it proceeds and the
    // missing file yields an error envelope — anything but the block sentinel.
    expect(result).not.toBe(BLOCK);
  });

  it("licensed/trial + force:true ⇒ NOT blocked (gate returns null)", async () => {
    (licenseGate as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const tandemOpen = captureTandemOpen();
    const result = await tandemOpen({ filePath: MISSING, force: true });
    expect(result).not.toBe(BLOCK);
  });
});

describe("HTTP /api/open (handleOpen) — force sub-path gate", () => {
  it("restricted + force:true ⇒ 403 LICENSE_REQUIRED", async () => {
    (licenseGate as ReturnType<typeof vi.fn>).mockReturnValue(BLOCK);
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleOpen({ body: { filePath: MISSING, force: true } } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ error: "LICENSE_REQUIRED" });
  });

  it("restricted + plain open ⇒ NOT a LICENSE_REQUIRED rejection", async () => {
    (licenseGate as ReturnType<typeof vi.fn>).mockReturnValue(BLOCK);
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleOpen({ body: { filePath: MISSING } } as any, res);
    expect(res.body?.error).not.toBe("LICENSE_REQUIRED");
  });
});
