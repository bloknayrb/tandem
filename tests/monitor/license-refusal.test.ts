import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/monitor/index.js";
import { LICENSE_REFUSED_RETRY_MS, licenseRefusalMessage } from "../../src/shared/sse-consumer.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseResponse,
} from "./fetch-harness.js";

/**
 * The shared SSE consumer under a licence refusal (#1521), driven through
 * the plugin monitor. A 403 whose body says `LICENSE_REQUIRED` is NOT an
 * outage: no retry ladder, no exhaustion report, no `channel-error` POST, a
 * long flat wait — and the monitor tells the model once, on stdout, why its
 * wakes stopped.
 */
describe("SSE consumer: licence refusal", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", () => new Response("", { status: 200 }));
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });

  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const refusalBody = JSON.stringify({
    error: "LICENSE_REQUIRED",
    kind: "unlicensed",
    message: "Tandem is unlicensed, so its AI features are turned off.",
  });

  function errorReports(): number {
    return stub.calls.filter((c) => c.url.includes("/api/channel-error")).length;
  }

  it("backs off flat, reports no outage, and tells the model once", async () => {
    let attempts = 0;
    stub.on("/api/events", () => {
      attempts++;
      return new Response(refusalBody, {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(LICENSE_REFUSED_RETRY_MS * 3 + 1_000);

    const seen = attempts;
    const stdout: string[] = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // 1 + 3 retries: flat at the licence interval, not the 2/4/8/16/30 s ladder.
    expect(seen).toBe(4);
    expect(errorReports()).toBe(0);
    expect(stdout.filter((l) => /unlicensed/.test(l))).toHaveLength(1);
    expect(stdout.some((l) => /retrying in the background/.test(l))).toBe(false);
  });

  it("an ordinary 403 still climbs the ladder and reports (positive twin)", async () => {
    let attempts = 0;
    stub.on("/api/events", () => {
      attempts++;
      return new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
    });

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);

    expect(attempts).toBeGreaterThanOrEqual(8);
    expect(errorReports()).toBe(1);
  });

  it("a 403 whose body never ends is read under a deadline, then treated as an outage", async () => {
    let attempts = 0;
    let aborted = 0;
    stub.on("/api/events", (_url, init) => {
      attempts++;
      // Something other than Tandem on the port: headers, then a body that
      // stalls. Like real fetch, aborting the request's signal errors the body.
      const body = new ReadableStream({
        start(ctrl) {
          init?.signal?.addEventListener("abort", () => {
            aborted++;
            ctrl.error(init.signal?.reason);
          });
        },
      });
      return new Response(body, { status: 403 });
    });

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);

    // Without the deadline the first `res.json()` never settles: one attempt, forever.
    expect(attempts).toBeGreaterThanOrEqual(8);
    // Each stalled read is released by aborting its request, not left open.
    expect(aborted).toBeGreaterThanOrEqual(attempts - 1);
    expect(errorReports()).toBe(1);
  });

  it("picks the stream back up after activation", async () => {
    let refused = true;
    let streams = 0;
    stub.on("/api/events", () => {
      if (refused) {
        return new Response(refusalBody, { status: 403 });
      }
      streams++;
      return sseResponse(new ControllableStream());
    });

    void main().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(streams).toBe(0);
    refused = false;
    await vi.advanceTimersByTimeAsync(LICENSE_REFUSED_RETRY_MS + 1_000);
    expect(streams).toBe(1);
  });
});

/**
 * The body-only refusal reader the channel shim's permission relay shares with
 * the SSE consumer (#1521). Total: anything but a 403 carrying
 * `LICENSE_REQUIRED` is `null`, never a throw.
 */
describe("licenseRefusalMessage", () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

  it("returns the server's message for a licence refusal", async () => {
    expect(
      await licenseRefusalMessage(json({ error: "LICENSE_REQUIRED", message: "AI off" }, 403)),
    ).toBe("AI off");
  });

  it("is null for a 403 with another error", async () => {
    expect(await licenseRefusalMessage(json({ error: "FORBIDDEN", message: "x" }, 403))).toBeNull();
  });

  it("is null for a 500, even one carrying the licence body", async () => {
    expect(
      await licenseRefusalMessage(json({ error: "LICENSE_REQUIRED", message: "x" }, 500)),
    ).toBeNull();
  });

  it("is null for an unparsable body", async () => {
    expect(await licenseRefusalMessage(new Response("<html>", { status: 403 }))).toBeNull();
  });
});
