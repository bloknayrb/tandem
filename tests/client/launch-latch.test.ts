// @vitest-environment happy-dom

/**
 * `createLaunchLatch` (#2198, #2199): a flag held until the next server
 * launch — the wizard's closed-for-launch and the chat offer's Not now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLaunchLatch } from "../../src/client/utils/launch-latch.svelte";

const KEY = "tandem:test-latch";

describe("createLaunchLatch", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("holds for the launch it was set in, and not for the next", () => {
    let launch: string | null = "launch-1";
    const latch = createLaunchLatch(KEY, () => launch);
    expect(latch.active).toBe(false);
    latch.mark();
    expect(latch.active).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("launch-1");
    launch = "launch-2";
    expect(latch.active).toBe(false);
  });

  it("is read back from storage, so a reload in the same launch keeps it", () => {
    localStorage.setItem(KEY, "launch-1");
    expect(createLaunchLatch(KEY, () => "launch-1").active).toBe(true);
  });

  it("an older server with no launchId: this page's memory is the launch", () => {
    const latch = createLaunchLatch(KEY, () => null);
    latch.mark();
    expect(latch.active).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(createLaunchLatch(KEY, () => null).active).toBe(false);
  });

  it("storage that throws still holds it in memory for this page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const latch = createLaunchLatch(KEY, () => "launch-1");
    latch.mark();
    expect(latch.active).toBe(true);
  });

  it("another tab's mark reaches this one through the storage event; other keys do not", () => {
    const latch = createLaunchLatch(KEY, () => "launch-1");
    latch.onStorage(new StorageEvent("storage", { key: "other", newValue: "launch-1" }));
    expect(latch.active).toBe(false);
    latch.onStorage(new StorageEvent("storage", { key: KEY, newValue: "launch-1" }));
    expect(latch.active).toBe(true);
  });
});
