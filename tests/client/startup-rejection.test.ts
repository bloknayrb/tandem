import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  messageForStartupRejection,
  wireStartupRejection,
} from "../../src/client/utils/startup-rejection.js";

/**
 * A fake of the Rust buffer, including the property the whole design rests on:
 * `get_startup_rejection` TAKES. A second reader gets null.
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
    wired,
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

describe("messageForStartupRejection", () => {
  it("maps every code the Rust side can emit", () => {
    expect(messageForStartupRejection("unsupported-extension")).toBe(
      "That file type can't be opened in Tandem.",
    );
    expect(messageForStartupRejection("not-a-file")).toContain("moved or been deleted");
    expect(messageForStartupRejection("non-file-url")).toContain("moved or been deleted");
    expect(messageForStartupRejection("suspicious-path")).toContain("safety reasons");
    expect(messageForStartupRejection("multiple-rejected")).toBe(
      "Some of those files couldn't be opened in Tandem.",
    );
  });

  it("degrades to a vague-but-true message for an unknown code", () => {
    // A client older than the Rust side must never render a raw code at the
    // user. `multiple-rejected` shipped after the other four and would have hit
    // exactly this branch on a stale WebView.
    expect(messageForStartupRejection("code-from-the-future")).toBe(
      "That file couldn't be opened in Tandem.",
    );
    expect(messageForStartupRejection("")).toBe("That file couldn't be opened in Tandem.");
  });

  it("is plural only for the batch code", () => {
    // Guards the specific regression the batch collapse exists to prevent: a
    // five-file drop where four opened must not say "That file".
    expect(messageForStartupRejection("multiple-rejected")).not.toContain("That file");
  });
});

describe("wireStartupRejection", () => {
  let push: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    push = vi.fn();
    warn = vi.fn();
  });

  it("toasts a code buffered before the client existed", async () => {
    const buf = fakeBuffer("unsupported-extension");
    const ev = deferredListen();
    ev.finishWiring();

    wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    await settle();

    expect(push).toHaveBeenCalledExactlyOnceWith("That file type can't be opened in Tandem.");
  });

  it("toasts a code that arrives later, via the payload-free nudge", async () => {
    const buf = fakeBuffer(null);
    const ev = deferredListen();
    ev.finishWiring();

    wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    await settle();
    expect(push).not.toHaveBeenCalled();

    buf.put("suspicious-path");
    ev.nudge();
    await settle();

    expect(push).toHaveBeenCalledExactlyOnceWith("That file path was rejected for safety reasons.");
    // The handler receives no arguments — the event is a nudge, not a delivery.
    expect(ev.listen.mock.calls[0]?.[0]).toBe("startup-file-rejected");
  });

  it("drains only AFTER the listener is wired, so nothing lands in the gap", async () => {
    // The ordering guarantee. Two independent chains have no guaranteed
    // completion order; if the drain could resolve first, a rejection arriving
    // between the two would be buffered with nobody left to read it — and there
    // is no second drain, because this runs once per WebView load.
    const buf = fakeBuffer(null);
    const ev = deferredListen();

    wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    await settle();

    expect(buf.invoke).not.toHaveBeenCalled();

    // The rejection lands while the listener is still resolving.
    buf.put("not-a-file");
    ev.finishWiring();
    await settle();

    expect(push).toHaveBeenCalledExactlyOnceWith(
      "That file couldn't be opened — it may have moved or been deleted.",
    );
  });

  it("toasts once when the nudge and the init drain both fire", async () => {
    // Take-once is what makes the two paths safe to run unordered against each
    // other. Whichever reads first wins; the other gets null.
    const buf = fakeBuffer("unsupported-extension");
    const ev = deferredListen();
    ev.finishWiring();

    wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    await settle();
    // The init drain has already taken it; the nudge reads the same take-once
    // slot and must come back empty rather than toasting a second time.
    ev.nudge();
    await settle();

    expect(push).toHaveBeenCalledOnce();
    expect(buf.invoke.mock.calls.length).toBeGreaterThan(1);
  });

  it("still drains cold-start rejections when the listener fails to wire", async () => {
    // `.finally`, not `.then`. A dead nudge path must not also cost the toast
    // for something already buffered.
    const buf = fakeBuffer("unsupported-extension");

    wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => {
        throw new Error("import failed");
      },
      push,
      warn,
    });
    await settle();

    expect(push).toHaveBeenCalledExactlyOnceWith("That file type can't be opened in Tandem.");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not toast on a failed drain, and leaves the buffer for a retry", async () => {
    const ev = deferredListen();
    ev.finishWiring();
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC not ready"))
      .mockResolvedValueOnce("not-a-file");

    wireStartupRejection({
      loadCore: async () => ({ invoke: invoke as never }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    await settle();

    expect(push).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();

    // A failed invoke does not consume the Rust-side buffer, so the next nudge
    // recovers it rather than the toast being lost.
    ev.nudge();
    await settle();
    expect(push).toHaveBeenCalledExactlyOnceWith(
      "That file couldn't be opened — it may have moved or been deleted.",
    );
  });

  it("stops toasting after cleanup, and unwires the listener", async () => {
    const buf = fakeBuffer(null);
    const ev = deferredListen();
    ev.finishWiring();

    const cleanup = wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    await settle();
    cleanup();

    expect(ev.unlisten).toHaveBeenCalledOnce();

    buf.put("unsupported-extension");
    ev.nudge();
    await settle();
    expect(push).not.toHaveBeenCalled();
  });

  it("unwires a listener that resolves after cleanup", async () => {
    // The component can be destroyed while the dynamic import is still in
    // flight; the late-arriving unlisten must not leak.
    const buf = fakeBuffer(null);
    const ev = deferredListen();

    const cleanup = wireStartupRejection({
      loadCore: async () => ({ invoke: buf.invoke }),
      loadEvent: async () => ({ listen: ev.listen }),
      push,
      warn,
    });
    cleanup();
    ev.finishWiring();
    await settle();

    expect(ev.unlisten).toHaveBeenCalledOnce();
  });
});
