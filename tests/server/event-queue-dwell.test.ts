import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  attachObservers,
  detachObservers,
  getBufferedSelection,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  Y_MAP_DWELL_MS,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";

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

  it("does NOT buffer immediately when a selection is written", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });

    // No time has passed — should not be buffered yet
    expect(getBufferedSelection("dwell-test")).toBeUndefined();
  });

  it("buffers after dwell time elapses", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
    expect(getBufferedSelection("dwell-test")).toBeUndefined();

    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    // No event emitted — selection is buffered instead
    expect(events).toHaveLength(0);
    expect(getBufferedSelection("dwell-test")).toEqual({ from: 0, to: 5, selectedText: "hello" });
    cleanup();
  });

  it("resets the timer when a new selection arrives before expiry — only the latest is buffered", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    expect(getBufferedSelection("dwell-test")).toBeUndefined();

    // Second selection resets the timer
    awareness.set("selection", { from: 6, to: 12, selectedText: "world!" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    expect(getBufferedSelection("dwell-test")).toBeUndefined();

    // Now the second dwell completes
    vi.advanceTimersByTime(200);
    expect(getBufferedSelection("dwell-test")).toEqual({ from: 6, to: 12, selectedText: "world!" });
  });

  it("cancels the timer when selection is cleared (from === to)", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);

    // Clearing the selection cancels the pending timer
    awareness.set("selection", { from: 3, to: 3 });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS * 2);

    // Still no buffer — cleared selection cancelled the original timer
    expect(getBufferedSelection("dwell-test")).toBeUndefined();
  });

  it("does not buffer for undefined selection", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", undefined);
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS * 2);

    expect(getBufferedSelection("dwell-test")).toBeUndefined();
  });

  it("respects custom dwell time from CTRL_ROOM awareness", () => {
    const customDwell = 2000;
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    ctrlAwareness.set(Y_MAP_DWELL_MS, customDwell);

    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });

    // Should NOT buffer at the default 1000ms
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);
    expect(getBufferedSelection("dwell-test")).toBeUndefined();

    // Should buffer after the custom 2000ms
    vi.advanceTimersByTime(customDwell - SELECTION_DWELL_DEFAULT_MS);
    expect(getBufferedSelection("dwell-test")).toEqual({ from: 0, to: 5, selectedText: "hello" });

    // Cleanup CTRL_ROOM setting
    ctrlAwareness.delete(Y_MAP_DWELL_MS);
  });

  describe("getDwellMs fallback branches", () => {
    let ctrlAwareness: Y.Map<unknown>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
      ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      ctrlAwareness.delete(Y_MAP_DWELL_MS);
      warnSpy.mockRestore();
    });

    it("falls back to default when CTRL_ROOM has no dwell key set", () => {
      // Sanity: ensure no stale value from a prior test
      ctrlAwareness.delete(Y_MAP_DWELL_MS);

      const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

      awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
      vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

      expect(getBufferedSelection("dwell-test")).toBeDefined();
      // Absent key is the normal cold-startup path — should NOT warn
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("falls back to default and warns when value is above the max bound", () => {
      ctrlAwareness.set(Y_MAP_DWELL_MS, SELECTION_DWELL_MAX_MS + 1);

      const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

      awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
      // Should buffer at the default, not at the invalid larger value
      vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

      expect(getBufferedSelection("dwell-test")).toBeDefined();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toContain("Invalid dwell time");
    });

    it("falls back to default and warns when value is below the min bound", () => {
      ctrlAwareness.set(Y_MAP_DWELL_MS, 100); // below SELECTION_DWELL_MIN_MS = 500

      const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

      awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
      // Advance by the invalid 100ms first — nothing should buffer
      vi.advanceTimersByTime(100);
      expect(getBufferedSelection("dwell-test")).toBeUndefined();
      // Default kicks in at 1000ms total
      vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);

      expect(getBufferedSelection("dwell-test")).toBeDefined();
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("falls back to default and warns when value is the wrong type (string)", () => {
      ctrlAwareness.set(Y_MAP_DWELL_MS, "2000");

      const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

      awareness.set("selection", { from: 0, to: 5, selectedText: "hello" });
      vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

      expect(getBufferedSelection("dwell-test")).toBeDefined();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toContain("type=string");
    });
  });
});
