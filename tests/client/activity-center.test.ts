// @vitest-environment happy-dom

/**
 * Activity center (sub-PR 1.10a0): the notification store feeds two surfaces —
 * transient pops (`toasts`) and a persistent tray (`activity`) — from one
 * ingest. The discriminating behaviors covered here:
 *  - Info-pop gating by ENTRY POINT: client `push` info pops; SSE info is quiet.
 *  - warning/error pop regardless of source.
 *  - Activity dedup keeps the FIRST id (stable testids/keyed-each/storage).
 *  - dismiss() removes the pop only; the tray entry survives.
 *  - dismissActivity()/clearActivity()/total.
 *  - loadActivity() rehydrate: prune expired info, cap, drop malformed.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadActivity,
  type NotificationsState,
} from "../../src/client/hooks/useNotifications.svelte";
import NotificationsHarness from "../../src/client/svelte-harness/NotificationsHarness.svelte";
import {
  ACTIVITY_HISTORY_CAP,
  ACTIVITY_INFO_TTL_MS,
  TOAST_DISMISS_MS,
} from "../../src/shared/constants.js";
import type { TandemNotification } from "../../src/shared/types.js";

// happy-dom has no EventSource; capture instances so a test can drive onmessage.
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = FakeEventSource.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(notification: TandemNotification) {
    this.onmessage?.({ data: JSON.stringify(notification) } as MessageEvent);
  }
}

function note(overrides: Partial<TandemNotification> = {}): TandemNotification {
  return {
    id: "id-default",
    type: "general-error",
    severity: "error",
    message: "Something happened",
    timestamp: Date.now(),
    ...overrides,
  };
}

async function mountStore(
  props: { persist?: boolean; storageKey?: string } = {},
): Promise<NotificationsState> {
  let state: NotificationsState | null = null;
  render(NotificationsHarness, {
    props: { ...props, onReady: (s: NotificationsState) => (state = s) },
  });
  await tick();
  if (!state) throw new Error("harness did not call onReady");
  return state;
}

describe("activity center — entry-point info gating", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("client push of info pops AND lands in the tray", async () => {
    const api = await mountStore();
    api.push(note({ id: "echo-1", severity: "info", message: "Document is read-only" }));
    await tick();
    expect(api.toasts.map((t) => t.id)).toContain("echo-1"); // popped
    expect(api.activity.map((a) => a.id)).toContain("echo-1"); // tray
  });

  it("SSE info is quiet — tray only, no pop", async () => {
    const api = await mountStore();
    FakeEventSource.last?.emit(
      note({ id: "ambient-1", severity: "info", message: "Session restored" }),
    );
    await tick();
    expect(api.toasts.map((t) => t.id)).not.toContain("ambient-1"); // no pop
    expect(api.activity.map((a) => a.id)).toContain("ambient-1"); // tray
  });

  it("warning/error pop regardless of source", async () => {
    const api = await mountStore();
    FakeEventSource.last?.emit(note({ id: "sse-err", severity: "error" }));
    api.push(note({ id: "client-warn", severity: "warning" }));
    await tick();
    const toastIds = api.toasts.map((t) => t.id);
    expect(toastIds).toContain("sse-err");
    expect(toastIds).toContain("client-warn");
  });
});

describe("activity center — dedup + dismissal", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("activity dedup keeps the FIRST id and bumps count", async () => {
    const api = await mountStore();
    api.push(note({ id: "first", dedupKey: "k", severity: "error" }));
    api.push(note({ id: "second", dedupKey: "k", severity: "error" }));
    api.push(note({ id: "third", dedupKey: "k", severity: "error" }));
    await tick();
    const matching = api.activity.filter((a) => a.dedupKey === "k");
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe("first"); // first id preserved
    expect(matching[0].count).toBe(3);
  });

  it("dismiss() removes the pop but keeps the tray entry", async () => {
    const api = await mountStore();
    api.push(note({ id: "e1", severity: "error" }));
    await tick();
    expect(api.toasts.map((t) => t.id)).toContain("e1");

    api.dismiss("e1");
    await tick();
    expect(api.toasts.map((t) => t.id)).not.toContain("e1"); // pop gone
    expect(api.activity.map((a) => a.id)).toContain("e1"); // tray survives
  });

  it("dismissActivity() removes the tray entry; clearActivity() empties; total tracks", async () => {
    const api = await mountStore();
    api.push(note({ id: "a", severity: "error" }));
    api.push(note({ id: "b", severity: "warning" }));
    await tick();
    expect(api.total).toBe(2);

    api.dismissActivity("a");
    await tick();
    expect(api.activity.map((x) => x.id)).toEqual(["b"]);
    expect(api.total).toBe(1);

    api.clearActivity();
    await tick();
    expect(api.activity).toHaveLength(0);
    expect(api.total).toBe(0);
  });
});

describe("activity center — info-TTL timer lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tray info outlives its toast — TTLs are decoupled", async () => {
    const api = await mountStore();
    api.push(note({ id: "copied", severity: "info", message: "Diagnostics copied to clipboard" }));
    await tick();

    // Past the toast's lifetime: the pop is gone, the tray entry is not.
    vi.advanceTimersByTime(TOAST_DISMISS_MS.info + 1_000);
    await tick();
    expect(api.toasts.map((t) => t.id)).not.toContain("copied");
    expect(api.activity.map((a) => a.id)).toContain("copied");

    // Past the tray TTL: now it expires.
    vi.advanceTimersByTime(ACTIVITY_INFO_TTL_MS);
    await tick();
    expect(api.activity.map((a) => a.id)).not.toContain("copied");
  });

  it("a dedup severity upgrade (info→error) cancels the stale info-expiry timer", async () => {
    const api = await mountStore();
    api.push(note({ id: "i", dedupKey: "net", severity: "info", message: "Reconnecting…" }));
    api.push(note({ id: "e", dedupKey: "net", severity: "error", message: "Connection lost" }));
    await tick();

    const row = api.activity.find((a) => a.dedupKey === "net");
    expect(row?.severity).toBe("error");
    expect(row?.id).toBe("i"); // first id preserved by coalesce

    // The original info timer must NOT fire and delete the upgraded error.
    vi.advanceTimersByTime(ACTIVITY_INFO_TTL_MS + 1_000);
    await tick();
    expect(api.activity.some((a) => a.dedupKey === "net")).toBe(true);
  });

  it("rehydrated within-TTL info re-arms its timer and still expires", async () => {
    const KEY = "test:rehydrate-rearm";
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "fresh",
          message: "Session restored",
          timestamp: Date.now(),
          severity: "info",
          type: "session-restored",
          count: 1,
        },
      ]),
    );
    try {
      const api = await mountStore({ persist: true, storageKey: KEY });
      expect(api.activity.map((a) => a.id)).toContain("fresh");

      vi.advanceTimersByTime(ACTIVITY_INFO_TTL_MS + 1_000);
      await tick();
      expect(api.activity.map((a) => a.id)).not.toContain("fresh");
    } finally {
      localStorage.clear();
    }
  });
});

describe("loadActivity — rehydrate/prune", () => {
  const KEY = "test:activityHistory";
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("returns [] for missing or non-array data", () => {
    expect(loadActivity(KEY)).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ not: "an array" }));
    expect(loadActivity(KEY)).toEqual([]);
    localStorage.setItem(KEY, "{ broken json");
    expect(loadActivity(KEY)).toEqual([]);
  });

  it("drops entries with missing or out-of-range severity", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "ok",
          message: "m",
          timestamp: Date.now(),
          severity: "error",
          type: "general-error",
          count: 1,
        },
        { id: "no-sev", message: "m", timestamp: Date.now(), type: "general-error", count: 1 },
        {
          id: "bad-sev",
          message: "m",
          timestamp: Date.now(),
          severity: "critical",
          type: "general-error",
          count: 1,
        },
      ]),
    );
    expect(loadActivity(KEY).map((a) => a.id)).toEqual(["ok"]);
  });

  it("drops malformed entries (missing id/message/timestamp)", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "ok",
          message: "m",
          timestamp: Date.now(),
          severity: "error",
          type: "general-error",
          count: 1,
        },
        { id: "no-msg", timestamp: Date.now() },
        "a bare string",
        null,
      ]),
    );
    const loaded = loadActivity(KEY);
    expect(loaded.map((a) => a.id)).toEqual(["ok"]);
  });

  it("prunes info older than its TTL but keeps warn/error and fresh info", () => {
    const old = Date.now() - (ACTIVITY_INFO_TTL_MS + 60_000); // well past info TTL
    const now = Date.now();
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "old-info",
          message: "m",
          timestamp: old,
          severity: "info",
          type: "session-restored",
          count: 1,
        },
        {
          id: "old-error",
          message: "m",
          timestamp: old,
          severity: "error",
          type: "general-error",
          count: 1,
        },
        {
          id: "fresh-info",
          message: "m",
          timestamp: now,
          severity: "info",
          type: "launcher",
          count: 1,
        },
      ]),
    );
    const ids = loadActivity(KEY).map((a) => a.id);
    expect(ids).not.toContain("old-info"); // pruned
    expect(ids).toContain("old-error"); // persists
    expect(ids).toContain("fresh-info"); // within TTL
  });

  it("caps to the newest ACTIVITY_HISTORY_CAP entries", () => {
    const now = Date.now();
    const many = Array.from({ length: ACTIVITY_HISTORY_CAP + 10 }, (_, i) => ({
      id: `n-${i}`,
      message: "m",
      timestamp: now,
      severity: "error" as const,
      type: "general-error" as const,
      count: 1,
    }));
    localStorage.setItem(KEY, JSON.stringify(many));
    const loaded = loadActivity(KEY);
    expect(loaded).toHaveLength(ACTIVITY_HISTORY_CAP);
    // Keeps the newest (tail) — last id survives, first is dropped.
    expect(loaded.at(-1)?.id).toBe(`n-${ACTIVITY_HISTORY_CAP + 9}`);
    expect(loaded.map((a) => a.id)).not.toContain("n-0");
  });
});
