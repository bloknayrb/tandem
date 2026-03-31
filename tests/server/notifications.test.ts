import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushNotification,
  subscribe,
  getBuffer,
  resetForTesting,
} from "../../src/server/notifications";
import type { TandemNotification } from "../../src/shared/types";

function makeNotification(overrides?: Partial<TandemNotification>): TandemNotification {
  return {
    id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "annotation-error",
    severity: "error",
    message: "Test notification",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("notifications", () => {
  beforeEach(() => {
    resetForTesting();
  });

  it("pushNotification adds to buffer", () => {
    const n = makeNotification();
    pushNotification(n);
    expect(getBuffer()).toHaveLength(1);
    expect(getBuffer()[0]).toEqual(n);
  });

  it("subscribers receive pushed notifications", () => {
    const handler = vi.fn();
    subscribe(handler);

    const n = makeNotification();
    pushNotification(n);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(n);
  });

  it("unsubscribe stops delivery", () => {
    const handler = vi.fn();
    const unsub = subscribe(handler);

    pushNotification(makeNotification());
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    pushNotification(makeNotification());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("buffer respects max size (circular eviction)", () => {
    // NOTIFICATION_BUFFER_SIZE is 50
    for (let i = 0; i < 60; i++) {
      pushNotification(makeNotification({ id: `ntf_${i}` }));
    }

    const buf = getBuffer();
    expect(buf).toHaveLength(50);
    // Oldest 10 should have been evicted; first remaining should be ntf_10
    expect(buf[0].id).toBe("ntf_10");
    expect(buf[49].id).toBe("ntf_59");
  });

  it("multiple subscribers all receive notifications", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    subscribe(h1);
    subscribe(h2);

    pushNotification(makeNotification());

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("subscriber error does not prevent other subscribers from receiving", () => {
    const h1 = vi.fn(() => {
      throw new Error("boom");
    });
    const h2 = vi.fn();
    subscribe(h1);
    subscribe(h2);

    pushNotification(makeNotification());

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("resetForTesting clears buffer and subscribers", () => {
    const handler = vi.fn();
    subscribe(handler);
    pushNotification(makeNotification());

    resetForTesting();

    expect(getBuffer()).toHaveLength(0);
    pushNotification(makeNotification());
    // Handler should not be called after reset
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
