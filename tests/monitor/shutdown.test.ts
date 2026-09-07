import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
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
      await mod.shutdownMonitor("SIGINT");
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

  it("skips the shutdown awareness POST when no event with a documentId ever arrived", async () => {
    const writes: unknown[] = [];
    stub.on("/api/channel-awareness", async (_url, init) => {
      if (typeof init?.body === "string") writes.push(JSON.parse(init.body));
      return new Response("", { status: 200 });
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();

    await expect(mod.shutdownMonitor("SIGINT")).rejects.toThrow("exit:0");
    expect(writes).toEqual([]);
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
    const shutdown = mod.shutdownMonitor("SIGINT").catch(() => {
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    stub.on("/api/channel-awareness", () => new Response("boom", { status: 500 }));

    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    mod._setLastDocumentIdForTests("doc-a");

    await expect(mod.shutdownMonitor("SIGINT")).rejects.toThrow("exit:1");
    // A silent exit(1) is nearly as bad as exit(0) for support debugging —
    // the reason must land on stderr before the process dies.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown awareness clear returned 500"),
    );
    errorSpy.mockRestore();
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

describe("channel shim stdin-EOF shutdown (#1804)", () => {
  it("registers a stdin 'end' listener beside the stdio connect", async () => {
    // Removing the retry cap deleted the shim's only self-termination path for
    // the case #1804 targets, so a shim armed while Tandem is down whose
    // session then ends uncleanly would probe forever.
    //
    // A source-text pin, deliberately: driving `runChannel()` here would need
    // a live MCP transport, and the pin's known weakness — it cannot tell a
    // firing handler from an inert one — does not bite on this host, where
    // `StdioServerTransport` puts stdin in flowing mode before the listener is
    // registered. The monitor needed its own `resume()` for that reason; its
    // arming is driven for real in the describe below.
    // `fileURLToPath`, not `new URL(...).pathname`: the latter stays
    // percent-encoded, so a checkout under a path holding a space or a
    // non-ASCII character (`C:\Users\My Name\tandem`) would resolve to a
    // `%20` path that does not exist and fail this pin with ENOENT.
    const src = await readFile(
      fileURLToPath(new URL("../../src/channel/run.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain('process.stdin.once("end"');
  });
});

describe("monitor stdin-EOF shutdown", () => {
  beforeEach(() => {
    // `Date` is faked here, which is what lets a spec age the EOF without
    // waiting out the real grace window.
    installMonitorFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("arms on a socket-like stdin, resumes it, and exits 0 on an aged EOF", async () => {
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    const { _monitorTestExports } = mod;
    // A real `net.Socket` — a piped stdin is one, and `tty.ReadStream`
    // extends it, so this is exactly what the guard admits.
    const readable = new Socket();
    const resumeSpy = vi.spyOn(readable, "resume");

    expect(_monitorTestExports.armStdinEndExit(readable)).toBe(true);
    // Without this the `'end'` listener never fires — nothing in the monitor
    // reads stdin, so the stream stays paused.
    expect(resumeSpy).toHaveBeenCalled();
    // Identity, not count: `net.Socket` registers an internal `'end'`
    // listener of its own the moment it is resumed.
    expect(readable.listeners("end")).toContain(_monitorTestExports.onStdinEnd);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.advanceTimersByTime(_monitorTestExports.STDIN_LIVENESS_GRACE_MS + 1);
    expect(() => readable.emit("end")).toThrow("exit:0");
    exitSpy.mockRestore();
  });

  it("does NOT exit on an EOF inside the grace window (a stdin closed at spawn)", async () => {
    // The `Socket` guard rejects only the null-device shape. A pipe the host
    // closes right after spawn, and an inherited stdin already at EOF under
    // `spawn(cmd, [], { shell: true })`, are both `net.Socket` — so a bare
    // handler would exit at STARTUP and kill the push path in every session.
    // Whether the plugin host pipes our stdin is unmeasured, so the ambiguous
    // case must fail toward staying up.
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    const { _monitorTestExports } = mod;
    const readable = new Socket();

    expect(_monitorTestExports.armStdinEndExit(readable)).toBe(true);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => readable.emit("end")).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    // Not silent: the run has no host-exit detection and that must be legible.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no stdin liveness channel"));
  });

  it("does NOT arm on a non-socket stdin (the null device would EOF at startup)", async () => {
    const { _monitorTestExports } = await import("../../src/monitor/index.js");
    // `fs.ReadStream` is what Node hands a process spawned with stdin ignored,
    // and it reaches EOF immediately. Arming there would kill the monitor at
    // startup instead of at host exit.
    const nullish = new Readable({ read() {} });
    const resumeSpy = vi.spyOn(nullish, "resume");

    expect(_monitorTestExports.armStdinEndExit(nullish)).toBe(false);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(nullish.listenerCount("end")).toBe(0);
  });
});
