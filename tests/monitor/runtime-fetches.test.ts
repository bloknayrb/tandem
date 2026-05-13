import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countMatches, expectFetchWithTimeoutEndpoint } from "../helpers/fetch-source-asserts.js";
import {
  ControllableStream,
  createFetchStub,
  installMonitorFakeTimers,
  sseResponse,
} from "./fetch-harness.js";

const MONITOR_PATH = fileURLToPath(new URL("../../src/monitor/index.ts", import.meta.url));

describe("monitor authenticated fetch surface", () => {
  let stub: ReturnType<typeof createFetchStub>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL = "http://plugin-host:4567";
    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = "M".repeat(32);
    delete process.env.TANDEM_AUTH_TOKEN;
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    vi.resetModules();
  });

  afterEach(() => {
    stub.restore();
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.resetModules();
  });

  it("keeps monitor request-response endpoints on the shared timeout helper", async () => {
    const src = await readFile(MONITOR_PATH, "utf8");
    // Assert path + each named import individually so the test survives
    // import-statement reordering or formatter rewrites.
    expect(src).toContain('"../shared/fetch-with-timeout.js"');
    expect(src).toMatch(
      /import\s+\{[^}]*\bdescribeFetchError\b[^}]*\}\s+from\s+["']\.\.\/shared\/fetch-with-timeout\.js["']/,
    );
    expect(src).toMatch(
      /import\s+\{[^}]*\bfetchWithTimeout\b[^}]*\}\s+from\s+["']\.\.\/shared\/fetch-with-timeout\.js["']/,
    );
    expect(src).not.toMatch(/async function fetchWithTimeout\(/);
    expectFetchWithTimeoutEndpoint(src, "/api/channel-error", "ERROR_REPORT_TIMEOUT_MS");
    expectFetchWithTimeoutEndpoint(src, "/api/mode", "MODE_FETCH_TIMEOUT_MS");
    expect(
      countMatches(
        src,
        /fetchWithTimeout\([\s\S]*?(?:\/api\/channel-awareness|API_CHANNEL_AWARENESS)/g,
      ),
    ).toBe(3);
    expect(src.match(/\bauthFetch\s*\(/g)?.length ?? 0).toBe(1);
    expect(src).toMatch(/authFetch\(`\$\{TANDEM_URL\}(?:\/api\/events|\$\{API_EVENTS\})`/);
  });

  it("authenticates the SSE handshake with plugin URL and token", async () => {
    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));

    const { connectAndStream, _resetMonitorStateForTests } = await import(
      "../../src/monitor/index.js"
    );
    _resetMonitorStateForTests();
    const p = connectAndStream(undefined, () => {});

    await vi.waitFor(() => expect(stub.calls.length).toBe(1));
    const call = stub.calls[0];
    expect(call.url).toBe("http://plugin-host:4567/api/events");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${"M".repeat(32)}`);
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);

    stream.end();
    await expect(p).rejects.toThrow("SSE stream ended");
  });
});
