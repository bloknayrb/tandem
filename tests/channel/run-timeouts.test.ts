/**
 * Static-analysis smoke tests for `src/channel/run.ts` timeout coverage (#364).
 *
 * `runChannel` builds an MCP `Server` and registers handlers inline — there
 * is no exported `tandem_reply` function we can call in isolation. Rather
 * than ship a refactor solely for testability, we assert on the source that:
 *
 *   1. The three `authFetch`-shaped callsites (tandem_reply via
 *      /api/channel-reply, /api/channel-permission, plus the event-bridge
 *      proxies) all flow through `fetchWithTimeout`.
 *   2. The JSON-parse catch in `tandem_reply` re-throws AbortError /
 *      TimeoutError instead of swallowing them as fake-success "Non-JSON
 *      response" — this is the silent-failure pattern #364 closes.
 *
 * Static asserts catch a regression where a future edit adds a fresh
 * `authFetch` call to run.ts without a deadline. Behavior tests for the
 * underlying primitive live in `fetch-with-timeout.test.ts`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countMatches, expectFetchWithTimeoutEndpoint } from "../helpers/fetch-source-asserts.js";

const RUN_TS_PATH = fileURLToPath(new URL("../../src/channel/run.ts", import.meta.url));
const EVENT_BRIDGE_PATH = fileURLToPath(
  new URL("../../src/channel/event-bridge.ts", import.meta.url),
);

describe("channel/run.ts timeout coverage", () => {
  it("does not import authFetch directly — all HTTP goes through fetchWithTimeout", async () => {
    const src = await readFile(RUN_TS_PATH, "utf8");
    // No bare `authFetch(` call sites. The import line is also gone since
    // run.ts now only consumes redirectConsoleToStderr + resolveTandemUrl.
    expect(src).not.toMatch(/\bauthFetch\s*\(/);
  });

  it("wraps /api/channel-reply with fetchWithTimeout", async () => {
    const src = await readFile(RUN_TS_PATH, "utf8");
    expectFetchWithTimeoutEndpoint(src, "/api/channel-reply", "CHANNEL_REPLY_FETCH_TIMEOUT_MS");
  });

  it("wraps /api/channel-permission with fetchWithTimeout", async () => {
    const src = await readFile(RUN_TS_PATH, "utf8");
    expectFetchWithTimeoutEndpoint(
      src,
      "/api/channel-permission",
      "CHANNEL_PERMISSION_FETCH_TIMEOUT_MS",
    );
  });

  it("re-throws AbortError/TimeoutError from the JSON-parse catch", async () => {
    const src = await readFile(RUN_TS_PATH, "utf8");
    // The inner catch now uses `isAbortOrTimeoutError(parseErr)` then throws.
    // Without this, a body-side timeout reads as fake-success "Non-JSON response".
    expect(src).toMatch(/isAbortOrTimeoutError\(parseErr\)\s*\)\s*throw\s+parseErr/);
  });
});

describe("channel/event-bridge.ts timeout coverage", () => {
  it("wraps every authFetch callsite with fetchWithTimeout (handshake exempt)", async () => {
    const src = await readFile(EVENT_BRIDGE_PATH, "utf8");
    // The SSE handshake retains a raw authFetch (intentional — the split
    // controller pattern is documented inline). Assert exactly one bare
    // authFetch call remains, and it is the handshake.
    const bareAuthFetch = src.match(/\bauthFetch\s*\(/g) ?? [];
    expect(bareAuthFetch.length).toBe(1);
    expect(src).toMatch(/authFetch\(`\$\{tandemUrl\}(?:\/api\/events|\$\{API_EVENTS\})`/);
  });

  it("pairs every request-response endpoint with fetchWithTimeout and its timeout budget", async () => {
    const src = await readFile(EVENT_BRIDGE_PATH, "utf8");
    expectFetchWithTimeoutEndpoint(src, "/api/channel-error", "CHANNEL_ERROR_REPORT_TIMEOUT_MS");
    expectFetchWithTimeoutEndpoint(src, "/api/mode", "CHANNEL_MODE_FETCH_TIMEOUT_MS");

    expect(
      countMatches(
        src,
        /fetchWithTimeout\([\s\S]*?(?:\/api\/channel-awareness|API_CHANNEL_AWARENESS)/g,
      ),
    ).toBe(2);
    expect(countMatches(src, /CHANNEL_AWARENESS_FETCH_TIMEOUT_MS/g)).toBeGreaterThanOrEqual(2);
  });

  it("uses split AbortController for the SSE handshake (not AbortSignal.timeout on the body)", async () => {
    const src = await readFile(EVENT_BRIDGE_PATH, "utf8");
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/clearTimeout\(connectTimer\)/);
  });

  it("includes an SSE inactivity watchdog and bounded buffer", async () => {
    const src = await readFile(EVENT_BRIDGE_PATH, "utf8");
    expect(src).toMatch(/CHANNEL_SSE_INACTIVITY_TIMEOUT_MS/);
    expect(src).toMatch(/CHANNEL_MAX_SSE_BUFFER_BYTES/);
    expect(src).toMatch(/reader\.cancel\(/);
  });

  it("clears watchdog and awareness timers in finally (no leaked timers across reconnects)", async () => {
    const src = await readFile(EVENT_BRIDGE_PATH, "utf8");
    expect(src).toMatch(/finally\s*\{[\s\S]*?clearInterval\(watchdog\)/);
    expect(src).toMatch(/finally\s*\{[\s\S]*?clearTimeout\(awarenessTimer\)/);
    expect(src).toMatch(/finally\s*\{[\s\S]*?clearTimeout\(clearAwarenessTimer\)/);
  });
});
