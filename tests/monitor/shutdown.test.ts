import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchStub } from "./fetch-harness.js";

describe("graceful shutdown", () => {
  let stub: ReturnType<typeof createFetchStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
  });

  it("POSTs a final clearAwareness when SIGINT fires (after an event set lastDocumentId)", async () => {
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    mod._setLastDocumentIdForTests("doc-123");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      await mod.shutdownForTests("SIGINT");
    } catch {
      // exit thrown is expected
    }

    const clears = stub.calls.filter(
      (c) =>
        c.url.includes("/api/channel-awareness") &&
        typeof c.init?.body === "string" &&
        c.init.body.includes('"active":false'),
    );
    expect(clears.length).toBeGreaterThanOrEqual(1);
    expect(exitSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("skips the awareness POST when no document is active (lastDocumentId === null)", async () => {
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      await mod.shutdownForTests("SIGINT");
    } catch {
      // exit thrown is expected
    }

    const clears = stub.calls.filter((c) => c.url.includes("/api/channel-awareness"));
    expect(clears.length).toBe(0);
    exitSpy.mockRestore();
  });
});
