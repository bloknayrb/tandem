// @vitest-environment happy-dom

/**
 * Regression test for the refcount-flap race in `useUpdaterChannel`
 * (M6 + L30 of the Wave-1 simplify pass).
 *
 * Scenario: a consumer mounts and lets the singleton's listen() request
 * start (refCount 0→1, pending=1, branch A awaiting `listen(...)`),
 * then unmounts AND a fresh consumer mounts BEFORE branch A resolves.
 * Pre-fix, branch A's `off` would be stored as `unlisten` and then
 * overwritten by branch B — leaking branch A's listener (its off()
 * never called).
 *
 * The in-flight token defeats this: each async subscribe captures
 * `++pending`; on resume the branch bails (and calls its own `off()` if
 * it already got that far) unless its `myToken` still equals the
 * current `pending`.
 *
 * Asserts the *outcome* — exactly one persistent listener, no leaked
 * uncalled off()s — rather than internal call counts (which are
 * sensitive to vitest+Svelte dynamic-import mocking quirks).
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track every off() returned by listen(), so the test can assert that no
// listener leaks across the race. Each listen() call resolution is
// deferred so the test can interleave mounts/unmounts before any
// listen() promise settles.
const listenResolvers: Array<() => void> = [];
const offSpies: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (_event: string, _cb: (e: { payload: { version: string } }) => void) =>
      new Promise<() => void>((resolve) => {
        const off = vi.fn();
        offSpies.push(off);
        // Defer until the test releases the resolvers — gives us a
        // window inside which to flap refcount and start a second
        // branch before either listen() settles.
        listenResolvers.push(() => resolve(off));
      }),
  ),
}));

import {
  __hasActiveListenerForTests,
  __resetUpdaterChannelForTests,
} from "../../src/client/hooks/useUpdaterChannel.svelte";
import UpdateAvailableHarness from "../../src/client/svelte-harness/UpdateAvailableHarness.svelte";

describe("useUpdaterChannel refcount-flap race", () => {
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    listenResolvers.length = 0;
    offSpies.length = 0;
    __resetUpdaterChannelForTests();
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("mount → unmount → mount with deferred listen() resolution leaves no leaked off()s", async () => {
    // Mount #1: $effect subscribes. refCount 0 → 1, pending=1, branch A
    // starts and pauses at `await import` then `await listen(...)`.
    const consumer1 = render(UpdateAvailableHarness);
    // Give the effect time to run and the dynamic import to resolve.
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    // Branch A has now called listen(...) — its promise is pending
    // (held open by listenResolvers).
    expect(offSpies.length).toBeGreaterThanOrEqual(1);

    // Unmount triggers $effect cleanup → unsubscribe. refCount → 0,
    // cancelled = true. Branch A's off() can NOT run yet because
    // branch A's `await listen` is still pending — `unlisten` is null.
    consumer1.unmount();

    // Re-mount synchronously: a fresh $effect runs. refCount 0 → 1,
    // pending=2, cancelled reset to false, branch B starts.
    const consumer2 = render(UpdateAvailableHarness);
    await tick();
    await new Promise((r) => setTimeout(r, 0));

    // Branch B has called listen too.
    expect(offSpies.length).toBeGreaterThanOrEqual(2);

    // Now release both listen() promises so the post-listen guards run.
    for (const resolver of listenResolvers) resolver();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    // Outcome: exactly one persistent listener attached (branch B's).
    expect(__hasActiveListenerForTests()).toBe(true);

    // No leaks: pre-fix, branch A would have stored its off() as
    // `unlisten` only to be overwritten by branch B, leaving branch A's
    // off() forever uncalled (two uncalled offs). With the token fix,
    // branch A bails post-listen and calls its own off() immediately.
    const uncalledOffs = offSpies.filter((s) => s.mock.calls.length === 0);
    expect(uncalledOffs.length).toBeLessThanOrEqual(1);
    expect(uncalledOffs.length).toBeGreaterThanOrEqual(1);

    // Final teardown: unmounting the live consumer must call off() on
    // the surviving listener and return the singleton to idle.
    consumer2.unmount();
    await tick();
    expect(uncalledOffs[0]).toHaveBeenCalledTimes(1);
    expect(__hasActiveListenerForTests()).toBe(false);
  });
});
