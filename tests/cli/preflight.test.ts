import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTandemServer } from "../../src/cli/preflight.js";

// Helper: a throwing process.exit so ensureTandemServer's `never` return is
// observable in tests without actually exiting the vitest worker.
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe("ensureTandemServer", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves silently when /health returns 200", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    await expect(ensureTandemServer({ url: "http://localhost:3479" })).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    // Verify we actually hit /health, not / or /mcp.
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3479/health", expect.any(Object));
  });

  it("exits 1 with a single clear message when fetch rejects (server down)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(ensureTandemServer({ url: "http://localhost:55999" })).rejects.toBeInstanceOf(
      ExitSignal,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    const writes = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(writes).toContain("Tandem server preflight failed at http://localhost:55999");
    expect(writes).toContain("ECONNREFUSED");
    expect(writes).toContain("tandem start");
  });

  it("exits 1 when /health returns a non-OK status", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(ensureTandemServer({ url: "http://localhost:3479" })).rejects.toBeInstanceOf(
      ExitSignal,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    const writes = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(writes).toContain("HTTP 500");
  });

  it("exits 1 when the request times out (AbortError)", async () => {
    fetchSpy.mockImplementation(async (_url, opts) => {
      // Simulate a fetch that aborts when its signal fires.
      return new Promise((_resolve, reject) => {
        const signal = (opts as { signal?: AbortSignal })?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new Error("The operation was aborted."));
          });
        }
      });
    });
    await expect(
      ensureTandemServer({ url: "http://localhost:3479", timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("honors TANDEM_URL env when no explicit url is passed", async () => {
    const prev = process.env.TANDEM_URL;
    process.env.TANDEM_URL = "http://localhost:4000";
    try {
      fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
      await ensureTandemServer();
      expect(fetchSpy).toHaveBeenCalledWith("http://localhost:4000/health", expect.any(Object));
    } finally {
      if (prev === undefined) delete process.env.TANDEM_URL;
      else process.env.TANDEM_URL = prev;
    }
  });
});
