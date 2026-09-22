import { describe, expect, it, vi } from "vitest";
import {
  buildSidecarRestartedNotification,
  SIDECAR_RESTARTED_MESSAGE,
  wireSidecarRestarted,
} from "../../src/client/utils/sidecar-restart-toast.js";
import type { TandemNotification } from "../../src/shared/types.js";

/** A fake Tauri event surface the test drives by hand. */
function fakeEvents() {
  const handlers: Array<() => void> = [];
  const unlisten = vi.fn();
  return {
    unlisten,
    emit: () => {
      for (const h of handlers) h();
    },
    loadEvent: async () => ({
      listen: vi.fn(async (_event: string, handler: () => void) => {
        handlers.push(handler);
        return unlisten;
      }),
    }),
  };
}

/** Flush enough microtask turns for the wiring chain to settle. */
async function settle(turns = 12) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("buildSidecarRestartedNotification", () => {
  it("is the notification the feature pushes, decisions and all", () => {
    const n = buildSidecarRestartedNotification(1234);
    expect(n).toEqual({
      id: "sidecar-restarted-1234",
      type: "general-error",
      severity: "info",
      message: SIDECAR_RESTARTED_MESSAGE,
      dedupKey: "sidecar-restarted",
      timestamp: 1234,
    });
    // Nothing failed, so no error code rides along.
    expect(n.errorCode).toBeUndefined();
  });
});

describe("wireSidecarRestarted", () => {
  it("pushes exactly one notification, and it is the module's own object", async () => {
    const events = fakeEvents();
    const pushed: TandemNotification[] = [];
    const cleanup = wireSidecarRestarted({
      loadEvent: events.loadEvent,
      push: (n) => pushed.push(n),
    });
    await settle();

    events.emit();

    expect(pushed).toHaveLength(1);
    const n = pushed[0];
    expect(n.severity).toBe("info");
    expect(n.type).toBe("general-error");
    expect(n.dedupKey).toBe("sidecar-restarted");
    expect(n.message).toBe(SIDECAR_RESTARTED_MESSAGE);
    expect(n.errorCode).toBeUndefined();
    cleanup();
  });

  it("pushes once per event — collapsing repeats is the toast layer's job", async () => {
    const events = fakeEvents();
    const push = vi.fn();
    const cleanup = wireSidecarRestarted({ loadEvent: events.loadEvent, push });
    await settle();

    events.emit();
    events.emit();

    expect(push).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("unlistens on cleanup, and an event after it pushes nothing", async () => {
    const events = fakeEvents();
    const push = vi.fn();
    const cleanup = wireSidecarRestarted({ loadEvent: events.loadEvent, push });
    await settle();

    cleanup();

    expect(events.unlisten).toHaveBeenCalledTimes(1);
    events.emit();
    expect(push).not.toHaveBeenCalled();
  });

  it("warns rather than throwing when the Tauri event module fails to load", async () => {
    const warn = vi.fn();
    const push = vi.fn();
    const cleanup = wireSidecarRestarted({
      loadEvent: async () => {
        throw new Error("no Tauri here");
      },
      push,
      warn,
    });
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    cleanup();
  });
});
