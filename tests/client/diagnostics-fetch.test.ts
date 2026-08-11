import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDiagnosticsCache, fetchDiagnostics } from "../../src/client/utils/diagnostics-fetch";

/**
 * The point of this module is that `GET /api/diagnostics` is expensive — it
 * runs the whole `tandem doctor` collector, including an `npm ls -g`
 * subprocess. These tests pin the two properties that keep it from running
 * more than it must, and the failure mapping the About tab's error messages
 * depend on.
 */

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetDiagnosticsCache();
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => jsonResponse({ version: "1.2.3" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetDiagnosticsCache();
});

describe("fetchDiagnostics", () => {
  it("returns the parsed payload on success", async () => {
    const result = await fetchDiagnostics();
    expect(result).toEqual({ ok: true, payload: { version: "1.2.3" } });
  });

  it("joins a request already in flight instead of starting a second", async () => {
    const both = Promise.all([fetchDiagnostics(), fetchDiagnostics()]);
    await both;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent success — the hover-then-click path costs one run", async () => {
    // This is the regression the TTL exists for: a hover primes the link, then
    // the user clicks Copy Diagnostics seconds later. The two requests do not
    // overlap, so in-flight sharing alone would run the collector twice.
    await fetchDiagnostics();
    vi.advanceTimersByTime(5_000);
    await fetchDiagnostics();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maxAgeMs: 0 bypasses the cache — the explicit click must see current state", async () => {
    // A user who reads the report, fixes the problem, and clicks again must not
    // be handed the pre-fix report.
    await fetchDiagnostics();
    vi.advanceTimersByTime(1_000);
    await fetchDiagnostics({ maxAgeMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not join an in-flight run that is already too old for the caller", async () => {
    // The scenario: a hover starts a run, the user fixes the problem while it
    // is still going, then clicks Copy Diagnostics. Joining would hand them
    // probes that predate the fix. A fresh run must be chained instead.
    let releaseFirst: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const hover = fetchDiagnostics();
    await vi.advanceTimersByTimeAsync(1_000); // the run is now 1s old

    const click = fetchDiagnostics({ maxAgeMs: 0 });
    releaseFirst(jsonResponse({ version: "stale" }));

    await expect(hover).resolves.toEqual({ ok: true, payload: { version: "stale" } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(click).resolves.toEqual({ ok: true, payload: { version: "1.2.3" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still joins an in-flight run that is fresh enough", async () => {
    const both = Promise.all([
      fetchDiagnostics({ maxAgeMs: 0 }),
      fetchDiagnostics({ maxAgeMs: 0 }),
    ]);
    await both;
    // Both asked for maximum freshness, but the second arrives in the same tick
    // as the first started — no staleness to avoid, so one run serves both.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache has aged out", async () => {
    await fetchDiagnostics();
    vi.advanceTimersByTime(20_000);
    await fetchDiagnostics();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures — a retry must not look broken for 15s", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    expect(await fetchDiagnostics()).toEqual({ ok: false, reason: "unreachable" });

    fetchMock.mockResolvedValueOnce(jsonResponse({ version: "9.9.9" }));
    expect(await fetchDiagnostics()).toEqual({ ok: true, payload: { version: "9.9.9" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps a network throw to 'unreachable' and a bad status to 'server'", async () => {
    // The About tab shows two different messages off this distinction: "is it
    // running?" misdirects when the server answered.
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    expect(await fetchDiagnostics()).toEqual({ ok: false, reason: "unreachable" });

    _resetDiagnosticsCache();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false));
    expect(await fetchDiagnostics()).toEqual({ ok: false, reason: "server" });
  });

  it("maps unparseable JSON to 'server', not 'unreachable'", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response);
    expect(await fetchDiagnostics()).toEqual({ ok: false, reason: "server" });
  });
});
