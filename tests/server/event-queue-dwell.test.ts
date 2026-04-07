import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { SELECTION_DWELL_DEFAULT_MS, Y_MAP_USER_AWARENESS } from "../../src/shared/constants.js";

afterEach(() => {
  vi.useRealTimers();
  resetForTesting();
});

function collectEvents(): { events: TandemEvent[]; cleanup: () => void } {
  const events: TandemEvent[] = [];
  const cb = (event: TandemEvent) => {
    events.push(event);
  };
  subscribe(cb);
  return { events, cleanup: () => unsubscribe(cb) };
}

describe("selection dwell timer", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new Y.Doc();
    attachObservers("dwell-test", doc);
  });

  afterEach(() => {
    detachObservers("dwell-test");
    doc.destroy();
  });

  it("does NOT fire immediately when a selection is written", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });

    // No time has passed — event should not have fired
    expect(events).toHaveLength(0);
    cleanup();
  });

  it("fires after dwell time elapses", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("selection:changed");
    expect(events[0].payload).toMatchObject({ from: 0, to: 5, selectedText: "hello" });
    cleanup();
  });

  it("resets the timer when a new selection arrives before expiry — only the latest fires", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    expect(events).toHaveLength(0);

    // Second selection resets the timer
    awareness.set("selection", { from: 6, to: 12, selectedText: "world!" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    expect(events).toHaveLength(0);

    // Now the second dwell completes
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ from: 6, to: 12, selectedText: "world!" });
    cleanup();
  });

  it("cancels the timer when selection is cleared (from === to)", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    expect(events).toHaveLength(0);

    // Clearing the selection cancels the pending timer
    awareness.set("selection", { from: 3, to: 3 });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS * 2);

    // Still no event — cleared selection cancelled the original timer
    expect(events).toHaveLength(0);
    cleanup();
  });

  it("does not fire for undefined selection", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", undefined);
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS * 2);

    expect(events).toHaveLength(0);
    cleanup();
  });
});
