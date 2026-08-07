// @vitest-environment happy-dom

/**
 * Coverage for `createCwdDrift` (#1282).
 *
 * The hook holds an answer and the timing for asking; every judgement about
 * WHETHER a folder mismatch is worth mentioning lives server-side. So what is
 * worth testing here is exactly the timing and the failure behaviour:
 *
 *   - the settle delay actually suppresses a probe (a tab-flick must cost zero
 *     requests, and must never flash a pill mid-switch);
 *   - a superseded probe cannot write. An in-flight flag — the obvious
 *     alternative — would be actively wrong: it drops probes 2..N, so switching
 *     between three documents leaves the pill answering for the first one;
 *   - every failure clears to "nothing to say" rather than stranding the last
 *     answer, which would leave an amber pill asserting a relationship nobody
 *     has checked since the server started refusing to answer.
 */

import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CwdDriftState } from "../../src/client/hooks/useCwdDrift.svelte.js";
import CwdDriftHarness from "../../src/client/svelte-harness/CwdDriftHarness.svelte";

const SETTLE = 50;

const DRIFTED = {
  drifted: true,
  suggestedCwd: "~/projects/alpha",
  claudeCwd: "~/notes",
  label: "alpha",
  claudeLabel: "notes",
};

interface Recorder {
  fetchFn: typeof fetch;
  bodies: () => string[];
  calls: () => number;
}

/** A fetch stub that records each request body and replays a scripted response
 *  per call (the last entry repeats). A function entry is invoked, so a call can
 *  throw or resolve late. */
function recorder(script: Array<unknown | (() => unknown)>): Recorder {
  const bodies: string[] = [];
  let i = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const entry = script[Math.min(i, script.length - 1)];
    i += 1;
    const resolved = typeof entry === "function" ? (entry as () => unknown)() : entry;
    if (resolved instanceof Error) throw resolved;
    if (resolved instanceof Promise) return (await resolved) as unknown as Response;
    return resolved as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies: () => bodies, calls: () => i };
}

function ok(body: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

function mount(props: { cwd?: string | null; fetchFn?: typeof fetch }): {
  get(): CwdDriftState;
  rerender(next: Record<string, unknown>): Promise<void>;
  unmount(): void;
} {
  const holder: { state: CwdDriftState | null } = { state: null };
  const utils = render(CwdDriftHarness, {
    props: {
      onReady: (s: CwdDriftState) => {
        holder.state = s;
      },
      cwd: props.cwd ?? null,
      opts: { settleMs: SETTLE, fetchFn: props.fetchFn },
    },
  });
  return {
    get: () => {
      if (holder.state === null) throw new Error("harness never reported state");
      return holder.state;
    },
    rerender: (next) => utils.rerender(next as never),
    unmount: () => utils.unmount(),
  };
}

/** Advance past the settle delay and let the async continuation land. */
async function settle(extraTicks = 3): Promise<void> {
  await vi.advanceTimersByTimeAsync(SETTLE + 1);
  for (let i = 0; i < extraTicks; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCwdDrift", () => {
  it("reports drift after the inputs settle", async () => {
    const r = recorder([ok(DRIFTED)]);
    const h = mount({ cwd: "/home/u/projects/alpha", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).toEqual({
      suggestedCwd: "~/projects/alpha",
      claudeCwd: "~/notes",
      label: "alpha",
      claudeLabel: "notes",
    });
  });

  it("sends the caller's folder verbatim", async () => {
    // Not the document path, and not a re-derivation: the value on the wire has
    // to be the same one the relaunch will carry, or the preview and the action
    // are answering about different folders.
    const r = recorder([ok({ drifted: false })]);
    mount({ cwd: "/home/u/projects/alpha", fetchFn: r.fetchFn });
    await settle();
    expect(JSON.parse(r.bodies()[0] as string)).toEqual({ cwd: "/home/u/projects/alpha" });
  });

  it("asks nothing at all while the input is still moving", async () => {
    const r = recorder([ok(DRIFTED)]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    for (const cwd of ["/home/u/b", "/home/u/c", "/home/u/d"]) {
      await vi.advanceTimersByTimeAsync(SETTLE / 2);
      await h.rerender({ cwd });
    }
    // Four documents visited; the settle window never elapsed for any of them.
    expect(r.calls()).toBe(0);
    expect(h.get().drift).toBeNull();
  });

  it("answers for the LAST folder, not the first", async () => {
    // The in-flight-flag design fails exactly here: it would drop the second
    // probe and leave the pill naming the folder the user has already left.
    const r = recorder([ok({ ...DRIFTED, label: "first" }), ok({ ...DRIFTED, label: "second" })]);
    const h = mount({ cwd: "/home/u/first", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift?.label).toBe("first");
    await h.rerender({ cwd: "/home/u/second" });
    await settle();
    expect(h.get().drift?.label).toBe("second");
  });

  it("does not let a slow superseded response overwrite a fresher one", async () => {
    let releaseFirst: ((v: unknown) => void) | null = null;
    const r = recorder([
      () =>
        new Promise((res) => {
          releaseFirst = res;
        }),
      ok({ ...DRIFTED, label: "second" }),
    ]);
    const h = mount({ cwd: "/home/u/first", fetchFn: r.fetchFn });
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    await h.rerender({ cwd: "/home/u/second" });
    await settle();
    expect(h.get().drift?.label).toBe("second");
    // The first request only now resolves, with a different answer.
    releaseFirst?.(ok({ ...DRIFTED, label: "first" }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.get().drift?.label).toBe("second");
  });

  it("aborts the in-flight request when the input changes", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise(() => {}) as unknown as Response; // never resolves
    }) as unknown as typeof fetch;
    const h = mount({ cwd: "/home/u/first", fetchFn });
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    expect(signals[0]?.aborted).toBe(false);
    await h.rerender({ cwd: "/home/u/second" });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("clears to null when the server says no drift", async () => {
    const r = recorder([ok(DRIFTED), ok({ drifted: false })]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).not.toBeNull();
    await h.rerender({ cwd: "/home/u/b" });
    await settle();
    expect(h.get().drift).toBeNull();
  });

  it("clears to null on a non-OK response", async () => {
    const r = recorder([
      ok(DRIFTED),
      { ok: false, status: 403, json: async () => ({ error: "FORBIDDEN" }) },
    ]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).not.toBeNull();
    await h.rerender({ cwd: "/home/u/b" });
    await settle();
    expect(h.get().drift).toBeNull();
  });

  it("clears to null when the request throws", async () => {
    const r = recorder([ok(DRIFTED), new Error("offline")]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).not.toBeNull();
    await h.rerender({ cwd: "/home/u/b" });
    await settle();
    expect(h.get().drift).toBeNull();
  });

  it("clears to null on a malformed body", async () => {
    const r = recorder([
      ok(DRIFTED),
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      },
    ]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).not.toBeNull();
    await h.rerender({ cwd: "/home/u/b" });
    await settle();
    expect(h.get().drift).toBeNull();
  });

  it("asks nothing and clears when no eligible document is open", async () => {
    const r = recorder([ok(DRIFTED)]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).not.toBeNull();
    await h.rerender({ cwd: null });
    await settle();
    expect(h.get().drift).toBeNull();
    expect(r.calls()).toBe(1);
  });

  it("re-probes on refresh() without the document changing", async () => {
    // The launcher's cwd is not reactive state on this side, so a relaunch that
    // MOVES Claude changes nothing the effect watches. Without this the pill
    // survives its own success, naming the folder Claude just left.
    const r = recorder([ok(DRIFTED), ok({ drifted: false })]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).not.toBeNull();
    h.get().refresh();
    await settle();
    expect(r.calls()).toBe(2);
    expect(h.get().drift).toBeNull();
  });

  it("re-arms after a refresh() issued while nothing was open", async () => {
    const r = recorder([ok(DRIFTED)]);
    const h = mount({ cwd: null, fetchFn: r.fetchFn });
    await settle();
    h.get().refresh();
    await settle();
    expect(r.calls()).toBe(0);
    await h.rerender({ cwd: "/home/u/a" });
    await settle();
    expect(r.calls()).toBe(1);
  });

  it("rejects a drifted:true answer with missing fields", async () => {
    // The one path where a bad answer becomes a confident false statement rather
    // than silence: undefined fields would render "Claude is running in
    // undefined" AND poison the dismissal key, so dismissing that nonsense pair
    // suppresses every real drift afterwards.
    const r = recorder([ok({ drifted: true, suggestedCwd: "~/a" })]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).toBeNull();
  });

  it("rejects a drifted:true answer with non-string fields", async () => {
    const r = recorder([
      ok({ drifted: true, suggestedCwd: "~/a", claudeCwd: "~/b", label: 7, claudeLabel: "b" }),
    ]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await settle();
    expect(h.get().drift).toBeNull();
  });

  it("does not blank the pill when a superseding probe aborts the current one", async () => {
    // A real `fetch` REJECTS on abort, and the effect cleanup aborts on every
    // re-run — so guarding the failure paths on `mounted` alone blanks the chip
    // on every tab switch and on both `refresh()` calls fired after a launcher
    // action. The stub used elsewhere in this file never rejects on abort, which
    // is exactly why it could not catch this.
    let call = 0;
    const abortingFetch = (async (_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) return ok(DRIFTED) as unknown as Response;
      // Second and later probes hang until aborted, then reject like the real thing.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    const h = mount({ cwd: "/home/u/a", fetchFn: abortingFetch });
    await settle();
    expect(h.get().drift, "seed probe should have answered").not.toBeNull();

    // Probe 2 goes in flight...
    h.get().refresh();
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    // ...and is superseded, which aborts it and drives its rejection.
    h.get().refresh();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(h.get().drift, "an aborted probe cleared a live answer").not.toBeNull();
  });

  it("does not let a slow superseded NON-OK response clear a fresher answer", async () => {
    // The abort case above drives the `catch`; this drives the `!res.ok` branch,
    // which an abort never reaches. Same failure either way: a probe the user has
    // already moved past returns 403 late and blanks the answer on screen.
    let releaseFirst: ((v: Response) => void) | null = null;
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return ok(DRIFTED) as unknown as Response;
    }) as unknown as typeof fetch;

    const h = mount({ cwd: "/home/u/first", fetchFn });
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    // Supersede it; probe 2 answers with a real drift.
    await h.rerender({ cwd: "/home/u/second" });
    await settle();
    expect(h.get().drift, "second probe should have answered").not.toBeNull();

    // Probe 1 only now resolves — with a rejection the server sent late.
    releaseFirst?.({ ok: false, status: 403, json: async () => ({}) } as unknown as Response);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.get().drift, "a superseded non-OK response cleared a live answer").not.toBeNull();
  });

  it("writes nothing after unmount", async () => {
    let release: ((v: unknown) => void) | null = null;
    const r = recorder([
      () =>
        new Promise((res) => {
          release = res;
        }),
    ]);
    const h = mount({ cwd: "/home/u/a", fetchFn: r.fetchFn });
    await vi.advanceTimersByTimeAsync(SETTLE + 1);
    const state = h.get();
    h.unmount();
    release?.(ok(DRIFTED));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(state.drift).toBeNull();
  });
});
