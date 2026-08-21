import { describe, expect, it, vi } from "vitest";
import {
  messageForPendingUpdate,
  requestUpdateCheck,
  wirePendingUpdateHint,
} from "../../src/client/utils/pending-update-hint.js";

/**
 * A fake of the Rust buffer, including the property the whole design rests on:
 * `get_pending_update_hint` TAKES. A second reader gets null.
 */
function fakeBuffer(initial: string | null = null) {
  let slot = initial;
  return {
    put(code: string) {
      slot = code;
    },
    invoke: vi.fn(async (_cmd: string) => {
      const v = slot;
      slot = null;
      return v as never;
    }),
  };
}

/** Lets a test decide exactly when the listener finishes wiring. */
function deferredListen() {
  let resolveWired: (() => void) | undefined;
  const wired = new Promise<void>((r) => {
    resolveWired = r;
  });
  const handlers: Array<() => void> = [];
  const unlisten = vi.fn();
  return {
    finishWiring: () => resolveWired?.(),
    nudge: () => {
      for (const h of handlers) h();
    },
    unlisten,
    listen: vi.fn(async (_event: string, handler: () => void) => {
      handlers.push(handler);
      await wired;
      return unlisten;
    }),
  };
}

/** Flush enough microtask turns for the promise chains under test to settle. */
async function settle(turns = 12) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("messageForPendingUpdate", () => {
  it("maps the code the Rust side emits", () => {
    expect(messageForPendingUpdate("update-may-not-have-completed")).toBe(
      "Tandem may not have finished updating — it restarted on the previous version.",
    );
  });

  it("degrades to a vague-but-true message for an unknown code", () => {
    // A client older than the Rust side must never render a raw code.
    const msg = messageForPendingUpdate("some-future-code");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("some-future-code");
    expect(msg).toContain("Tandem");
  });

  it("never names a version", () => {
    for (const code of ["update-may-not-have-completed", "unknown"]) {
      expect(messageForPendingUpdate(code)).not.toMatch(/\d+\.\d+/);
    }
  });
});

describe("wirePendingUpdateHint", () => {
  it("raises the hint exactly once when the nudge and the init drain race", async () => {
    const buffer = fakeBuffer("update-may-not-have-completed");
    const ev = deferredListen();
    const onHint = vi.fn();

    wirePendingUpdateHint({
      loadCore: async () => ({ invoke: buffer.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      onHint,
    });

    ev.finishWiring();
    await settle();
    ev.nudge();
    await settle();

    // Take-once on the Rust side is what makes the doubled read safe: whichever
    // call arrives first gets the code, the other gets null.
    expect(onHint).toHaveBeenCalledTimes(1);
    expect(onHint).toHaveBeenCalledWith(
      "Tandem may not have finished updating — it restarted on the previous version.",
    );
  });

  it("raises nothing when the buffer is empty", async () => {
    const buffer = fakeBuffer(null);
    const ev = deferredListen();
    const onHint = vi.fn();

    wirePendingUpdateHint({
      loadCore: async () => ({ invoke: buffer.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      onHint,
    });
    ev.finishWiring();
    await settle();

    // A falsy check that let `null` through would show an empty banner on every
    // single clean boot.
    expect(onHint).not.toHaveBeenCalled();
  });

  it("warns and stays silent when the drain invoke rejects", async () => {
    const ev = deferredListen();
    const onHint = vi.fn();
    const warn = vi.fn();

    expect(() =>
      wirePendingUpdateHint({
        loadCore: async () => ({
          invoke: vi.fn(async () => {
            throw new Error("no such command");
          }) as never,
        }),
        loadEvent: async () => ({ listen: ev.listen }),
        onHint,
        warn,
      }),
    ).not.toThrow();

    ev.finishWiring();
    await settle();

    expect(onHint).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("still drains when the listener fails to wire", async () => {
    const buffer = fakeBuffer("update-may-not-have-completed");
    const onHint = vi.fn();
    const warn = vi.fn();

    // A failure to wire the listener must not lose a hint that was already
    // buffered at boot. What delivers that is the `.catch` before the drain,
    // which turns the rejection into a fulfilment — NOT the choice of `.finally`
    // over `.then`, which is indistinguishable here and is not asserted.
    wirePendingUpdateHint({
      loadCore: async () => ({ invoke: buffer.invoke }),
      loadEvent: async () => {
        throw new Error("event module unavailable");
      },
      onHint,
      warn,
    });
    await settle();

    expect(onHint).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("unlistens on cleanup and raises nothing afterwards", async () => {
    const buffer = fakeBuffer(null);
    const ev = deferredListen();
    const onHint = vi.fn();

    const cleanup = wirePendingUpdateHint({
      loadCore: async () => ({ invoke: buffer.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      onHint,
    });
    ev.finishWiring();
    await settle();

    cleanup();
    expect(ev.unlisten).toHaveBeenCalled();

    buffer.put("update-may-not-have-completed");
    ev.nudge();
    await settle();

    expect(onHint).not.toHaveBeenCalled();
  });
});

describe("requestUpdateCheck", () => {
  it("invokes check_for_update_now", async () => {
    const invoke = vi.fn(async () => undefined as never);
    await requestUpdateCheck(async () => ({ invoke }));

    // The command name is a cross-process contract with `invoke_handler!`. A
    // typo here is an inert CTA — and per the design note in the util, this CTA
    // is the ONLY remediation available for eight hours on the boot that raises
    // the banner.
    expect(invoke).toHaveBeenCalledWith("check_for_update_now");
  });

  it("never throws when the invoke rejects", async () => {
    const warn = vi.fn();
    await expect(
      requestUpdateCheck(
        async () => ({
          invoke: vi.fn(async () => {
            throw new Error("boom");
          }) as never,
        }),
        warn,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
