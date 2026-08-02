import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openScratchpad = vi.hoisted(() =>
  vi.fn(async (content?: string) => ({
    documentId: "scratch",
    fileName: "Scratchpad.md",
    content,
  })),
);
vi.mock("../../src/server/mcp/file-opener.js", () => ({ openScratchpad }));

import { handleScratchpad } from "../../src/server/mcp/routes/scratchpad";

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
    await handleScratchpad({ body: { content: "# Export\n\nbody" } } as Request, response);
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
      await handleScratchpad({ body } as Request, response);
      expect(status).toHaveBeenCalledWith(body.content === 42 || "path" in body ? 400 : 413);
    }
    expect(openScratchpad).not.toHaveBeenCalled();
  });
});
