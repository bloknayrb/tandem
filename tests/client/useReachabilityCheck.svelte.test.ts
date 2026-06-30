// @vitest-environment happy-dom

/**
 * Coverage for `createReachabilityCheck` (#1174 gap #1).
 *
 * The hook verifies, on the wizard's Done screen, that the Tandem MCP server
 * actually answers at the URL the config points at (HTTP targets), renders stdio
 * targets as not-applicable (no server to probe), and watches live for Claude
 * connecting (`/health.hasSession` → true). It calls `onDestroy` + `setInterval`,
 * so it must run inside a real component context — mounted via
 * `ReachabilityCheckHarness.svelte` (mirrors the `AiReadinessHarness` pattern).
 *
 * Reactive-correctness contract under test:
 *   - HTTP 200 → reachable / serverUp true; non-OK/throw → unreachable / false.
 *   - stdio-only → not-applicable, and NO `/health` call at all.
 *   - The live poll flips `claudeConnected` true and stops; the latch is
 *     monotonic (never demotes within an activation).
 *   - Deactivation clears the interval (no leak / no late writes).
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReachabilityCheckState,
  ReachabilityStatus,
} from "../../src/client/hooks/useReachabilityCheck.svelte.js";
import ReachabilityCheckHarness from "../../src/client/svelte-harness/ReachabilityCheckHarness.svelte";

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function mkResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return { ok, status, json: async () => body };
}

/** Build a `/health` stub that yields a scripted response per call (the verify
 *  GET is call #1, each poll tick is the next). A function entry is invoked so a
 *  call can throw. The last entry repeats for further ticks. */
function healthStub(script: Array<FetchResponse | Error | (() => FetchResponse | Error)>): {
  fetchFn: typeof fetch;
  calls: () => number;
} {
  let i = 0;
  const fetchFn = (async () => {
    const entry = script[Math.min(i, script.length - 1)] ?? mkResponse({ status: "ok" });
    i += 1;
    const resolved = typeof entry === "function" ? entry() : entry;
    if (resolved instanceof Error) throw resolved;
    return resolved as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => i };
}

const FAST = { verifyTimeoutMs: 1_000, pollIntervalMs: 100, pollDeadlineMs: 1_000 };

function mount(props: {
  targets?: { id: string; transport: "http" | "stdio" }[];
  active?: boolean;
  fetchFn?: typeof fetch;
  opts?: typeof FAST;
}): {
  get(): ReachabilityCheckState;
  rerender(next: Record<string, unknown>): Promise<void>;
} {
  const holder: { state: ReachabilityCheckState | null } = { state: null };
  const utils = render(ReachabilityCheckHarness, {
    props: {
      targets: props.targets ?? [],
      active: props.active ?? true,
      baseUrl: "",
      fetchFn: props.fetchFn,
      opts: props.opts ?? FAST,
      onReady: (s: ReachabilityCheckState) => (holder.state = s),
    },
  });
  return {
    get(): ReachabilityCheckState {
      if (holder.state === null) throw new Error("harness did not call onReady");
      return holder.state;
    },
    rerender: (next) => utils.rerender(next as never),
  };
}

function statusOf(state: ReachabilityCheckState, id: string): ReachabilityStatus | null {
  return state.results.find((r) => r.id === id)?.status ?? null;
}

/** Flush microtasks + Svelte reactivity (fake-timer safe — no real setTimeout). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

describe("createReachabilityCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("HTTP target + /health 200 → reachable, serverUp true", async () => {
    const { fetchFn } = healthStub([mkResponse({ status: "ok", hasSession: false })]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    expect(h.get().serverUp).toBe(true);
    expect(statusOf(h.get(), "claude-code")).toBe("reachable");
    expect(h.get().phase).toBe("done");
  });

  it("HTTP target + /health 500 → unreachable, serverUp false", async () => {
    const { fetchFn } = healthStub([mkResponse({}, false, 500)]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    expect(h.get().serverUp).toBe(false);
    expect(statusOf(h.get(), "claude-code")).toBe("unreachable");
  });

  it("HTTP target + /health throws → unreachable", async () => {
    const { fetchFn } = healthStub([new Error("network down")]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    expect(h.get().serverUp).toBe(false);
    expect(statusOf(h.get(), "claude-code")).toBe("unreachable");
  });

  it("stdio-only → not-applicable, never reachable even on 200, and NO /health call", async () => {
    const { fetchFn, calls } = healthStub([mkResponse({ status: "ok", hasSession: true })]);
    const h = mount({ targets: [{ id: "claude-desktop", transport: "stdio" }], fetchFn });
    await flush();
    expect(statusOf(h.get(), "claude-desktop")).toBe("not-applicable");
    expect(h.get().serverUp).toBeNull();
    expect(h.get().phase).toBe("done");
    expect(calls()).toBe(0); // no server to probe
  });

  it("mixed HTTP + stdio → http reachable, stdio not-applicable", async () => {
    const { fetchFn } = healthStub([mkResponse({ status: "ok", hasSession: false })]);
    const h = mount({
      targets: [
        { id: "claude-code", transport: "http" },
        { id: "claude-desktop", transport: "stdio" },
      ],
      fetchFn,
    });
    await flush();
    expect(statusOf(h.get(), "claude-code")).toBe("reachable");
    expect(statusOf(h.get(), "claude-desktop")).toBe("not-applicable");
  });

  it("live poll: hasSession false→true flips claudeConnected and stops polling", async () => {
    // Verify (#1) sees no session; poll tick (#2) sees the session.
    const { fetchFn, calls } = healthStub([
      mkResponse({ status: "ok", hasSession: false }),
      mkResponse({ status: "ok", hasSession: true }),
    ]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    expect(h.get().claudeConnected).toBe(false);
    expect(statusOf(h.get(), "claude-code")).toBe("reachable");

    await vi.advanceTimersByTimeAsync(100); // one poll tick
    await flush();
    expect(h.get().claudeConnected).toBe(true);

    const afterConnect = calls();
    await vi.advanceTimersByTimeAsync(500); // poll must have stopped
    expect(calls()).toBe(afterConnect);
  });

  it("hasSession already true on the verify read → connected immediately, no poll", async () => {
    const { fetchFn, calls } = healthStub([mkResponse({ status: "ok", hasSession: true })]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    expect(h.get().claudeConnected).toBe(true);
    const afterVerify = calls();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls()).toBe(afterVerify); // poll never started
  });

  it("latch is monotonic: once connected, a /health blip never demotes it", async () => {
    // Verify false, tick #2 true (latch), tick #3 throws — must stay connected.
    const { fetchFn } = healthStub([
      mkResponse({ status: "ok", hasSession: false }),
      mkResponse({ status: "ok", hasSession: true }),
      new Error("blip"),
    ]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.get().claudeConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(h.get().claudeConnected).toBe(true);
  });

  it("absent hasSession (redacted/non-loopback) keeps not-connected and keeps polling", async () => {
    const { fetchFn } = healthStub([mkResponse({ status: "ok" })]); // no hasSession field
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    expect(statusOf(h.get(), "claude-code")).toBe("reachable");
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.get().claudeConnected).toBe(false);
  });

  it("poll stops at the deadline", async () => {
    const { fetchFn, calls } = healthStub([mkResponse({ status: "ok", hasSession: false })]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], fetchFn });
    await flush();
    await vi.advanceTimersByTimeAsync(1_000); // reach pollDeadlineMs
    await flush();
    const atDeadline = calls();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls()).toBe(atDeadline); // no ticks past the deadline
    expect(h.get().claudeConnected).toBe(false);
  });

  it("deactivation resets phase to idle and clears the interval (no leak)", async () => {
    const { fetchFn, calls } = healthStub([mkResponse({ status: "ok", hasSession: false })]);
    const h = mount({ targets: [{ id: "claude-code", transport: "http" }], active: true, fetchFn });
    await flush();
    expect(h.get().phase).toBe("done");
    const beforeDeactivate = calls();

    await h.rerender({ active: false });
    await flush();
    expect(h.get().phase).toBe("idle");

    await vi.advanceTimersByTimeAsync(500); // interval must be cleared
    expect(calls()).toBe(beforeDeactivate);
  });

  it("no HTTP targets and empty target set → done with no rows, no fetch", async () => {
    const { fetchFn, calls } = healthStub([mkResponse({ status: "ok" })]);
    const h = mount({ targets: [], fetchFn });
    await flush();
    expect(h.get().phase).toBe("done");
    expect(h.get().results).toHaveLength(0);
    expect(calls()).toBe(0);
  });
});
