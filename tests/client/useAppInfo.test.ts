/**
 * Tests for useAppInfo helpers.
 *
 * The hook itself relies on React (useEffect/useState) which isn't available
 * in the Node test environment, so we test the extracted pure helpers:
 *   - fetchAppInfo(signal) — fetch + resp.ok guard + JSON parse
 *   - _resetAppInfoCache() — cache management
 *
 * The module-level cache means state leaks between tests unless we reset it;
 * _resetAppInfoCache() handles that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAppInfoCache, fetchAppInfo } from "../../src/client/hooks/useAppInfo.js";
import type { AppInfoData } from "../../src/client/types.js";

const MOCK_INFO: AppInfoData = {
  version: "1.2.3",
  toolCount: 28,
  mcpSdkVersion: "1.0.0",
  transport: "http",
};

function makeFetchStub(
  status: number,
  body: unknown,
  options: { throws?: Error } = {},
): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    if (options.throws) throw options.throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
    } as Response;
  });
}

beforeEach(() => {
  _resetAppInfoCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetAppInfoCache();
});

describe("fetchAppInfo", () => {
  it("resolves with parsed JSON on successful fetch", async () => {
    vi.stubGlobal("fetch", makeFetchStub(200, MOCK_INFO));
    const signal = new AbortController().signal;
    const result = await fetchAppInfo(signal);
    expect(result).toEqual(MOCK_INFO);
  });

  it("throws when resp.ok is false (non-2xx status)", async () => {
    vi.stubGlobal("fetch", makeFetchStub(403, { error: "forbidden" }));
    const signal = new AbortController().signal;
    await expect(fetchAppInfo(signal)).rejects.toThrow("403");
  });

  it("throws when fetch itself throws (network error)", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", makeFetchStub(0, null, { throws: networkError }));
    const signal = new AbortController().signal;
    await expect(fetchAppInfo(signal)).rejects.toThrow("Failed to fetch");
  });

  it("throws when the abort signal is already aborted", async () => {
    // fetch implementations throw DOMException with name 'AbortError' for aborted signals
    const abortError = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    vi.stubGlobal("fetch", makeFetchStub(0, null, { throws: abortError }));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchAppInfo(controller.signal)).rejects.toThrow("aborted");
  });

  it("includes optional loopback fields when server returns them", async () => {
    const withLoopback: AppInfoData = {
      ...MOCK_INFO,
      storagePath: "/home/user/.local/share/tandem/sessions",
      tokenRotatedAt: 1_700_000_000_000,
    };
    vi.stubGlobal("fetch", makeFetchStub(200, withLoopback));
    const signal = new AbortController().signal;
    const result = await fetchAppInfo(signal);
    expect(result.storagePath).toBe("/home/user/.local/share/tandem/sessions");
    expect(result.tokenRotatedAt).toBe(1_700_000_000_000);
  });

  it("fetches from the correct URL (API_BASE + /info)", async () => {
    const spy = makeFetchStub(200, MOCK_INFO);
    vi.stubGlobal("fetch", spy);
    const signal = new AbortController().signal;
    await fetchAppInfo(signal);
    const calledUrl = (spy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/\/api\/info$/);
  });
});

describe("_resetAppInfoCache", () => {
  it("is callable without throwing", () => {
    expect(() => _resetAppInfoCache()).not.toThrow();
  });

  it("after reset, calling reset again is idempotent", () => {
    _resetAppInfoCache();
    expect(() => _resetAppInfoCache()).not.toThrow();
  });
});

describe("fetchAppInfo — cache behaviour", () => {
  it("first call makes a network request; second call returns cached data without fetching again", async () => {
    const spy = makeFetchStub(200, MOCK_INFO);
    vi.stubGlobal("fetch", spy);

    const signal = new AbortController().signal;

    // First call — hits the network.
    const first = await fetchAppInfo(signal);
    expect(first).toEqual(MOCK_INFO);
    expect((spy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Second call — served from cache, no additional fetch.
    const second = await fetchAppInfo(signal);
    expect(second).toEqual(MOCK_INFO);
    expect((spy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("after _resetAppInfoCache(), the next call fetches again", async () => {
    const spy = makeFetchStub(200, MOCK_INFO);
    vi.stubGlobal("fetch", spy);

    const signal = new AbortController().signal;

    // Populate the cache.
    await fetchAppInfo(signal);
    expect((spy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Reset the cache.
    _resetAppInfoCache();

    // Should fetch again.
    await fetchAppInfo(signal);
    expect((spy as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});
