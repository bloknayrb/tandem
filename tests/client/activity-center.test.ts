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
import { formatActivityMessage } from "../../src/client/components/activityCenter.js";
import {
  loadActivity,
  type NotificationsState,
} from "../../src/client/hooks/useNotifications.svelte";
import NotificationsHarness from "../../src/client/svelte-harness/NotificationsHarness.svelte";
import {
  ACTIVITY_HISTORY_CAP,
  ACTIVITY_INFO_TTL_MS,
  MAX_VISIBLE_TOASTS,
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

const toastIds = (api: NotificationsState) => api.toasts.map((t) => t.id);

describe("toasts — existing pop and eviction paths (regression guard for `stay`)", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("six ordinary toasts: the first is evicted, the other five remain in push order", async () => {
    expect(MAX_VISIBLE_TOASTS).toBe(5);
    const api = await mountStore();
    for (let i = 1; i <= 6; i++) api.push(note({ id: `o${i}`, severity: "error" }));
    await tick();
    expect(toastIds(api)).toEqual(["o2", "o3", "o4", "o5", "o6"]);
  });

  it("an ordinary coalesce re-arms the timer: re-pushed at 3 s, present at 6 s, gone after 7 s", async () => {
    const api = await mountStore();
    api.push(note({ id: "c1", dedupKey: "k", severity: "info" }));
    vi.advanceTimersByTime(3_000);
    api.push(note({ id: "c2", dedupKey: "k", severity: "info" }));
    vi.advanceTimersByTime(3_000);
    await tick();
    expect(toastIds(api)).toEqual(["c2"]);
    vi.advanceTimersByTime(1_000);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("an error toast is present at 7.9 s and gone after 8 s", async () => {
    expect(TOAST_DISMISS_MS.error).toBe(8_000);
    const api = await mountStore();
    api.push(note({ id: "err", severity: "error" }));
    vi.advanceTimersByTime(7_900);
    await tick();
    expect(toastIds(api)).toEqual(["err"]);
    vi.advanceTimersByTime(100);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("a warning toast is present at 5.9 s and gone after 6 s", async () => {
    expect(TOAST_DISMISS_MS.warning).toBe(6_000);
    const api = await mountStore();
    api.push(note({ id: "warn", severity: "warning" }));
    vi.advanceTimersByTime(5_900);
    await tick();
    expect(toastIds(api)).toEqual(["warn"]);
    vi.advanceTimersByTime(100);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });
});

const STAY = { label: "Use it", onClick: () => {}, stay: true } as const;

describe("toasts — an action with `stay` keeps its toast until pressed or closed", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a staying info toast and a staying warning toast outlive their pop timers", async () => {
    const api = await mountStore();
    api.push(note({ id: "si", severity: "info" }), STAY);
    api.push(note({ id: "sw", severity: "warning" }), STAY);
    vi.advanceTimersByTime(TOAST_DISMISS_MS.info + 1_000);
    await tick();
    expect(toastIds(api)).toEqual(["si", "sw"]);
    vi.advanceTimersByTime(TOAST_DISMISS_MS.warning + 1_000);
    await tick();
    expect(toastIds(api)).toEqual(["si", "sw"]);
  });

  it("a coalescing re-push whose action also stays keeps the toast, under the new id", async () => {
    const api = await mountStore();
    api.push(note({ id: "a1", dedupKey: "k", severity: "info" }), STAY);
    vi.advanceTimersByTime(3_000);
    api.push(note({ id: "a2", dedupKey: "k", severity: "info" }), STAY);
    vi.advanceTimersByTime(5_000);
    await tick();
    expect(toastIds(api)).toEqual(["a2"]);
  });

  it("a coalescing re-push with no action stops staying: gone 4 s after the re-push", async () => {
    const api = await mountStore();
    api.push(note({ id: "b1", dedupKey: "k", severity: "info" }), STAY);
    vi.advanceTimersByTime(10_000);
    api.push(note({ id: "b2", dedupKey: "k", severity: "info" }));
    vi.advanceTimersByTime(3_999);
    await tick();
    expect(toastIds(api)).toEqual(["b2"]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("a coalescing re-push with an action without `stay` stops staying: gone 4 s after the re-push", async () => {
    const api = await mountStore();
    api.push(note({ id: "c1", dedupKey: "k", severity: "info" }), STAY);
    vi.advanceTimersByTime(10_000);
    api.push(note({ id: "c2", dedupKey: "k", severity: "info" }), {
      label: "Undo",
      onClick: () => {},
    });
    vi.advanceTimersByTime(3_999);
    await tick();
    expect(toastIds(api)).toEqual(["c2"]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("an ordinary toast re-pushed with a staying action becomes staying", async () => {
    const api = await mountStore();
    api.push(note({ id: "d1", dedupKey: "k", severity: "info" }));
    vi.advanceTimersByTime(2_000);
    api.push(note({ id: "d2", dedupKey: "k", severity: "info" }), STAY);
    vi.advanceTimersByTime(TOAST_DISMISS_MS.error + 1_000);
    await tick();
    expect(toastIds(api)).toEqual(["d2"]);
  });

  it("a warning coalescing onto a staying toast with an action without `stay` is gone 6 s later", async () => {
    const api = await mountStore();
    api.push(note({ id: "e1", dedupKey: "k", severity: "info" }), STAY);
    vi.advanceTimersByTime(10_000);
    api.push(note({ id: "e2", dedupKey: "k", severity: "warning" }), {
      label: "Open",
      onClick: () => {},
    });
    vi.advanceTimersByTime(5_999);
    await tick();
    expect(toastIds(api)).toEqual(["e2"]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("the info TTL removes a staying toast's tray row but not the toast", async () => {
    const api = await mountStore();
    api.push(note({ id: "ttl", severity: "info" }), STAY);
    await tick();
    // Same id on both surfaces, so the TTL timer's filter really meets this toast.
    expect(toastIds(api)).toEqual(["ttl"]);
    expect(api.activity.map((a) => a.id)).toEqual(["ttl"]);
    vi.advanceTimersByTime(ACTIVITY_INFO_TTL_MS + 1_000);
    await tick();
    expect(toastIds(api)).toEqual(["ttl"]);
    expect(api.activity.map((a) => a.id)).not.toContain("ttl");
  });

  it("one staying toast then five ordinary: the first ordinary one is evicted, order holds", async () => {
    const api = await mountStore();
    api.push(note({ id: "s1", severity: "error" }), STAY);
    for (let i = 1; i <= 5; i++) api.push(note({ id: `o${i}`, severity: "error" }));
    await tick();
    expect(toastIds(api)).toEqual(["s1", "o2", "o3", "o4", "o5"]);
  });

  it("six staying toasts: the first is evicted", async () => {
    const api = await mountStore();
    for (let i = 1; i <= 6; i++) api.push(note({ id: `s${i}`, severity: "error" }), STAY);
    await tick();
    expect(toastIds(api)).toEqual(["s2", "s3", "s4", "s5", "s6"]);
  });

  it("five staying toasts then one ordinary: the new one is shown, the oldest staying one evicted", async () => {
    const api = await mountStore();
    for (let i = 1; i <= 5; i++) api.push(note({ id: `s${i}`, severity: "error" }), STAY);
    api.push(note({ id: "o1", severity: "error" }));
    await tick();
    expect(toastIds(api)).toEqual(["s2", "s3", "s4", "s5", "o1"]);
  });

  it("dismiss(id) removes a staying toast", async () => {
    const api = await mountStore();
    api.push(note({ id: "x", severity: "info" }), STAY);
    await tick();
    api.dismiss("x");
    await tick();
    expect(toastIds(api)).toEqual([]);
  });
});

describe("toasts — existing toasts that carry an action are unchanged by `stay`", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("an Undo-like info toast is gone at 4 s", async () => {
    const api = await mountStore();
    api.push(note({ id: "undo", severity: "info" }), { label: "Undo", onClick: () => {} });
    vi.advanceTimersByTime(3_999);
    await tick();
    expect(toastIds(api)).toEqual(["undo"]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("an Undo-like info toast is evicted as the oldest", async () => {
    const api = await mountStore();
    api.push(note({ id: "undo", severity: "info" }), { label: "Undo", onClick: () => {} });
    for (let i = 1; i <= 5; i++) api.push(note({ id: `o${i}`, severity: "error" }));
    await tick();
    expect(toastIds(api)).toEqual(["o1", "o2", "o3", "o4", "o5"]);
  });

  it("a warning with a CTA-like action is gone at 6 s", async () => {
    const api = await mountStore();
    api.push(note({ id: "cta", severity: "warning" }), {
      label: "Set up Claude",
      onClick: () => {},
    });
    vi.advanceTimersByTime(5_999);
    await tick();
    expect(toastIds(api)).toEqual(["cta"]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(toastIds(api)).toEqual([]);
  });

  it("an info toast with no action, pushed beside a staying one, is gone at 4 s", async () => {
    const api = await mountStore();
    api.push(note({ id: "keep", severity: "info" }), STAY);
    api.push(note({ id: "plain", severity: "info" }));
    vi.advanceTimersByTime(3_999);
    await tick();
    expect(toastIds(api)).toEqual(["keep", "plain"]);
    vi.advanceTimersByTime(1);
    await tick();
    expect(toastIds(api)).toEqual(["keep"]);
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

// cr-1 (J2 review): `errorCode` reached both toast/tray surfaces on the wire
// but nothing read it back out, so an MCP-triggered `tandem_save` failure
// (no HTTP body to carry a details line) toasted only the generic sentence
// with no reason or errno at all. `formatActivityMessage` is the read side.
describe("formatActivityMessage (cr-1)", () => {
  it("appends the errno as a parenthetical suffix on a save-error", () => {
    expect(
      formatActivityMessage({
        type: "save-error",
        message: "Save failed for report.docx.",
        errorCode: "EACCES",
      }),
    ).toBe("Save failed for report.docx. (EACCES)");
  });

  it("omits the suffix when errorCode is absent", () => {
    expect(
      formatActivityMessage({
        type: "save-error",
        message: "Save failed for report.docx.",
        errorCode: undefined,
      }),
    ).toBe("Save failed for report.docx.");
  });

  it('omits the suffix for the "UNKNOWN" fallback code — it carries no information', () => {
    expect(
      formatActivityMessage({
        type: "save-error",
        message: "Save failed for report.docx.",
        errorCode: "UNKNOWN",
      }),
    ).toBe("Save failed for report.docx.");
  });

  // (post-ship review of #1816/#1897) `SaveVerificationError`'s message is a
  // deliberately complete, content-free sentence (the #1123-0e "your original
  // file was left unchanged" reassurance) — a jargon suffix here would
  // undercut it rather than add a diagnostic detail.
  it('omits the suffix for "VERIFY_BLOCKED" — its message is already complete', () => {
    expect(
      formatActivityMessage({
        type: "save-error",
        message:
          "Save failed for report.docx: the regenerated file did not re-open cleanly — your original file was left unchanged",
        errorCode: "VERIFY_BLOCKED",
      }),
    ).toBe(
      "Save failed for report.docx: the regenerated file did not re-open cleanly — your original file was left unchanged",
    );
  });

  it("leaves non-save-error notifications untouched even when errorCode is set", () => {
    // general-error notifications stash a semantic sentinel in errorCode
    // (SIDECAR_RESTART_FAILED, LINK_NOT_OPENABLE, …), not a raw fs code — a
    // parenthetical there would be noise, not a diagnostic detail.
    expect(
      formatActivityMessage({
        type: "general-error",
        message: "Tandem server failed to restart.",
        errorCode: "SIDECAR_RESTART_FAILED",
      }),
    ).toBe("Tandem server failed to restart.");
  });
});
