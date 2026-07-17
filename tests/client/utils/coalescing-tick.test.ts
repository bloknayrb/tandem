import { describe, expect, it, vi } from "vitest";
import { createCoalescingTick } from "../../../src/client/utils/coalescing-tick";

/**
 * These pin the two properties StatusBar depends on. The first is the bug fix
 * itself: #1189's follow-up crash was a `$state` write landing synchronously
 * inside a Tiptap event, which ProseMirror dispatches from a native `blur` that
 * can fire mid-render — Svelte throws `state_unsafe_mutation` there, in
 * production as well as dev. "Never synchronous" is the contract that makes the
 * write safe, so it's asserted directly rather than inferred from a mounted
 * component.
 */
describe("createCoalescingTick", () => {
  it("never invokes the bump synchronously", () => {
    const bump = vi.fn();
    const tick = createCoalescingTick(bump, () => {});
    tick();
    expect(bump).not.toHaveBeenCalled();
  });

  it("collapses a burst into a single bump", async () => {
    const bump = vi.fn();
    const tick = createCoalescingTick(bump);
    for (let i = 0; i < 25; i++) tick();
    expect(bump).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the scheduled bump runs", async () => {
    const bump = vi.fn();
    const tick = createCoalescingTick(bump);
    tick();
    await Promise.resolve();
    expect(bump).toHaveBeenCalledTimes(1);

    // A later burst must schedule again rather than latch off permanently —
    // otherwise the word count would freeze after the first edit.
    tick();
    tick();
    await Promise.resolve();
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it("defers via queueMicrotask by default", async () => {
    // Pins the default scheduler: a macrotask (setTimeout) would also dodge the
    // reaction, but would let a paint land between the edit and the count.
    const spy = vi.spyOn(globalThis, "queueMicrotask");
    const tick = createCoalescingTick(() => {});
    tick();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
