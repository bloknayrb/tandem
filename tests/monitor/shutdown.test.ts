import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseFrame,
  sseResponse,
} from "./fetch-harness.js";

describe("graceful shutdown", () => {
  let stub: ReturnType<typeof createFetchStub>;

  beforeEach(() => {
    installMonitorFakeTimers();
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

  it("awaits in-flight awareness POSTs before exiting", async () => {
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    mod._setLastDocumentIdForTests("doc-123");

    let resolvePending: () => void = () => {};
    const pending = new Promise<void>((r) => {
      resolvePending = r;
    });
    mod._addOutstandingAwarenessForTests(pending);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    let exited = false;
    const shutdown = mod.shutdownForTests("SIGINT").catch(() => {
      exited = true;
    });

    // Let microtasks settle; shutdown must still be waiting on the pending POST.
    await vi.advanceTimersByTimeAsync(100);
    expect(exited).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();

    // Resolve the outstanding POST; shutdown should now proceed to exit.
    resolvePending();
    await shutdown;
    expect(exitSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("regression: chat:message with no documentId does not wipe lastDocumentId from a prior doc event", async () => {
    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    const p = mod.connectAndStream(undefined, () => {});

    // First event carries a documentId.
    stream.push(
      sseFrame(
        { id: "e1", type: "annotation:created", timestamp: 1, documentId: "doc-x", payload: {} },
        "e1",
      ),
    );
    await vi.advanceTimersByTimeAsync(600); // past AWARENESS_DEBOUNCE_MS

    // Second event: chat:message without documentId.
    stream.push(
      sseFrame({ id: "e2", type: "chat:message", timestamp: 2, payload: { text: "hi" } }, "e2"),
    );
    await vi.advanceTimersByTimeAsync(600);

    stream.end();
    await p.catch(() => {});

    expect(mod._getLastDocumentIdForTests()).toBe("doc-x");
  });

  it("exits 1 when the final awareness clear POST fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    stub.on("/api/channel-awareness", () => new Response("boom", { status: 500 }));

    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    mod._setLastDocumentIdForTests("doc-a");

    await expect(mod.shutdownMonitor("SIGINT")).rejects.toThrow("exit:1");
    exitSpy.mockRestore();
  });

  it("exits 0 when the final awareness clear POST succeeds", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    mod._setLastDocumentIdForTests("doc-a");

    await expect(mod.shutdownMonitor("SIGINT")).rejects.toThrow("exit:0");
    exitSpy.mockRestore();
  });
});
