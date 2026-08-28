// @vitest-environment happy-dom

/**
 * Behavioural coverage for the lifecycle-bound action executor (Unit 9).
 *
 * The four properties under test, in the order the unit's review question asks
 * them:
 *
 *  1. An action cannot execute with **stale** dependencies — neither at entry
 *     (a new run after teardown) nor **in flight** (a body that captured `d`
 *     before teardown and re-enters it after an `await`). The in-flight half is
 *     the one an entry-only check misses, and it is the one that actually bites:
 *     `relaunchHere` notifies from a `finally` after a blocking `confirm()`.
 *  2. An action cannot survive App unmount unnoticed — a post-teardown call is
 *     reported, not silently dropped.
 *  3. An action cannot produce an unhandled promise rejection.
 *  4. Catching those rejections does not cost the crash report they used to
 *     generate through `sentry.ts`'s `unhandledrejection` listener.
 *
 * `reportError` is mocked so (4) is asserted directly rather than inferred.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionDeps,
  type ActionExecutor,
  currentActionDeps,
  mountActionExecutor,
  notifyUser,
  runAction,
  runBoundAction,
} from "../../../src/client/actions/executor.js";
import {
  type Action,
  registerAction,
  unregisterAction,
} from "../../../src/client/actions/registry.svelte.js";
import { makeActionDeps } from "./deps-bag.js";

const reportErrorSpy = vi.fn();
vi.mock("../../../src/client/sentry.js", () => ({
  reportError: (...args: unknown[]) => reportErrorSpy(...args),
}));

type Notify = ActionDeps["notify"];

/** Only `notify` varies across these specs, so it is the one parameter. */
function depsBag(notify: Notify = vi.fn()): ActionDeps {
  return makeActionDeps({ notify });
}

const live: ActionExecutor[] = [];
function mount(deps: ActionDeps): ActionExecutor {
  const e = mountActionExecutor(deps);
  live.push(e);
  return e;
}

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reportErrorSpy.mockClear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  while (live.length) live.pop()?.dispose();
  vi.restoreAllMocks();
});

/**
 * Run `body` with a private `unhandledRejection` listener installed, handing it
 * the rejections that actually escaped.
 *
 * Node's `process` is the emitter, NOT `window`: the first draft of this file
 * listened on `window`, and the positive control below is what caught that
 * **happy-dom never dispatches `unhandledrejection` on `window`** — the
 * negative specs would have passed forever without observing anything.
 *
 * Vitest's own handler is detached for the duration and restored afterwards;
 * otherwise the deliberate rejection in the control would fail the run it exists
 * to validate.
 */
function withRejectionListener<T>(body: (seen: unknown[]) => Promise<T>): Promise<T> {
  const seen: unknown[] = [];
  const previous = process.listeners("unhandledRejection");
  const onRejection = (reason: unknown) => void seen.push(reason);
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", onRejection);
  return body(seen).finally(() => {
    process.removeListener("unhandledRejection", onRejection);
    for (const l of previous) process.on("unhandledRejection", l);
  });
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

describe("binding", () => {
  it("routes a bound action to the mounted bag", () => {
    const deps = depsBag();
    mount(deps);

    runBoundAction("focus-chat", (d) => d.focusChat());

    expect(deps.focusChat).toHaveBeenCalledTimes(1);
  });

  it("exposes the live bag to non-action callers via currentActionDeps", () => {
    const notify = vi.fn();
    mount(depsBag(notify));

    currentActionDeps()?.notify("info", "hello");

    expect(notify).toHaveBeenCalledWith("info", "hello");
  });

  it("reports and no-ops with no executor mounted", () => {
    expect(currentActionDeps()).toBeNull();

    const ran = vi.fn();
    runBoundAction("focus-chat", ran);

    expect(ran).not.toHaveBeenCalled();
    expect(reportErrorSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Disposal and staleness
// ---------------------------------------------------------------------------

describe("disposal", () => {
  it("stops routing new runs after dispose", () => {
    const deps = depsBag();
    const executor = mount(deps);

    executor.dispose();
    runBoundAction("focus-chat", (d) => d.focusChat());

    expect(deps.focusChat).not.toHaveBeenCalled();
    expect(currentActionDeps()).toBeNull();
  });

  it("keeps the newer executor live when a SUPERSEDED one is disposed", () => {
    // The ordering a naive `current = null` in dispose() gets wrong. Mount B
    // supersedes A; disposing A afterwards must not unwire B.
    const depsA = depsBag();
    const depsB = depsBag();
    const a = mount(depsA);
    mount(depsB);

    runBoundAction("focus-chat", (d) => d.focusChat());
    expect(depsB.focusChat).toHaveBeenCalledTimes(1);
    expect(depsA.focusChat).not.toHaveBeenCalled();

    a.dispose();

    runBoundAction("focus-chat", (d) => d.focusChat());
    expect(depsB.focusChat).toHaveBeenCalledTimes(2);
    expect(currentActionDeps()).not.toBeNull();
  });

  it("is idempotent", () => {
    const executor = mount(depsBag());
    executor.dispose();
    executor.dispose();
    expect(currentActionDeps()).toBeNull();
  });

  it("does NOT let an IN-FLIGHT body reach the disposed bag after an await", async () => {
    // This is the failure `guardedRun` structurally could not detect and that
    // an entry-time-only check still misses: the body captured `d` while the
    // executor was live, suspends, and re-enters it after teardown — exactly
    // the shape of `relaunchHere`'s `finally` after a blocking confirm().
    const notify = vi.fn();
    const deps = depsBag(notify);
    const executor = mount(deps);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    runBoundAction("launcher-relaunch-here", async (d) => {
      await gate;
      d.notify("info", "Claude restarting.");
    });

    executor.dispose();
    release();
    await vi.waitFor(() => expect(consoleWarn).toHaveBeenCalled());

    expect(notify).not.toHaveBeenCalled();
    // Dropped, and *said so* — a silent drop is the thing being removed.
    expect(consoleWarn.mock.calls.flat().join(" ")).toContain("notify");
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ droppedMember: "notify" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Failure funnel
// ---------------------------------------------------------------------------

describe("failure reporting", () => {
  it("catches a synchronous throw, reports it, and does not propagate", () => {
    const notify = vi.fn();
    mount(depsBag(notify));

    expect(() =>
      runBoundAction("save", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();

    expect(consoleError).toHaveBeenCalled();
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "actionExecutor", actionId: "save" }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("error");
  });

  it("names the command by its registry LABEL, never its id", () => {
    // This file does not import `builtin.svelte.ts`, so the registry starts
    // empty here — the action has to be planted for the label path to exist at
    // all, which is also what keeps the fallback spec below honest.
    registerAction({
      id: "executor-label-probe",
      label: "Save document",
      group: "document",
      run: () => {},
    });
    const notify = vi.fn();
    mount(depsBag(notify));

    runBoundAction("executor-label-probe", () => {
      throw new Error("boom");
    });

    expect(notify.mock.calls[0][1]).toContain("Save document");
    expect(notify.mock.calls[0][1]).not.toContain("executor-label-probe");
    unregisterAction("executor-label-probe");
  });

  it("never shows a raw action id to the user for an unregistered reporting id", () => {
    // `relaunchClaudeCode` reports under "launcher-relaunch" so its telemetry is
    // distinguishable from the palette command it shares code with — and that id
    // is not in the registry. The fallback must drop the name, not print it.
    const notify = vi.fn();
    mount(depsBag(notify));

    runBoundAction("launcher-relaunch", () => {
      throw new Error("boom");
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).not.toContain("launcher-relaunch");
    expect(notify.mock.calls[0][1]).toContain("That command didn't finish");
  });

  it("catches a rejected promise and reports it once", async () => {
    const notify = vi.fn();
    mount(depsBag(notify));

    runBoundAction("save", () => Promise.reject(new Error("nope")));
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(notify).toHaveBeenCalledTimes(1);
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ actionId: "save" }),
    );
  });

  it("classifies the failure toast so it does not land in the tray as a launcher event", async () => {
    const notify = vi.fn();
    mount(depsBag(notify));

    runBoundAction("save", () => Promise.reject(new Error("nope")));
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    // The id must be deterministic: ToastContainer keys its {#each} on it, and
    // App's default is millisecond-derived, so two same-ms pushes collide.
    expect(notify.mock.calls[0][2]).toMatchObject({
      type: "general-error",
      dedupKey: "action-failed-save",
      id: "action-failed-save",
    });
  });

  it("survives a notify that itself throws, and still emits the console line", async () => {
    // A throw inside a rejection handler is a FRESH unhandled rejection — the
    // exact defect, relocated one frame outward.
    //
    // "still emits the console line" cannot be asserted as a bare
    // `expect(consoleError).toHaveBeenCalled()`: `report` logs the ORIGINAL
    // failure before it ever touches `notify`, so that expectation is satisfied
    // whether or not the notify throw was caught. The load-bearing assertions
    // are the SECOND console line (only the catch emits it) and the absence of
    // a fresh unhandled rejection.
    const notify = vi.fn(() => {
      throw new Error("notify exploded");
    });
    mount(depsBag(notify as unknown as Notify));

    await withRejectionListener(async (seen) => {
      runBoundAction("save", () => Promise.reject(new Error("nope")));
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));

      const lines = consoleError.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(lines.some((l: string) => l.includes('"save" failed'))).toBe(true);
      expect(lines.some((l: string) => l.includes('reporting "save" failed'))).toBe(true);
      expect(seen).toHaveLength(0);
    });
  });

  it("reports into a LIVE successor App rather than the dead one", async () => {
    // The ErrorBoundary recovery case: the executor that ran the action is gone
    // by the time it fails, but there is a working App on screen. Reporting into
    // the dead one (or nowhere) loses the toast in the case that most needs it.
    const oldNotify = vi.fn();
    const newNotify = vi.fn();
    const first = mount(depsBag(oldNotify));

    let reject!: (e: unknown) => void;
    runBoundAction(
      "save",
      () =>
        new Promise<void>((_, rj) => {
          reject = rj;
        }),
    );
    first.dispose();
    mount(depsBag(newNotify));
    reject(new Error("late"));
    await vi.waitFor(() => expect(newNotify).toHaveBeenCalled());

    expect(oldNotify).not.toHaveBeenCalled();
    expect(newNotify.mock.calls[0][0]).toBe("error");
  });

  it("does not notify when the executor was disposed before the rejection landed", async () => {
    const notify = vi.fn();
    const executor = mount(depsBag(notify));

    let reject!: (e: unknown) => void;
    runBoundAction(
      "save",
      () =>
        new Promise<void>((_, rj) => {
          reject = rj;
        }),
    );
    executor.dispose();
    reject(new Error("late"));
    await vi.waitFor(() => expect(reportErrorSpy).toHaveBeenCalled());

    // The App that would have rendered the toast is gone; the crash report and
    // console line are what survive.
    expect(notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Telemetry — the regression this unit could silently have caused
// ---------------------------------------------------------------------------

describe("crash-report telemetry", () => {
  /**
   * `sentry.ts` installs a `window.addEventListener("unhandledrejection", ...)`
   * handler, so before this unit a rejected action DID reach crash reporting.
   * Attaching a rejection handler here marks those rejections handled, and they
   * stop arriving. Asserting only "no unhandled rejection fires" would therefore
   * be green whether or not the report was preserved — and greener still if the
   * environment never emits the event at all, which is why the positive control
   * below is a required part of this pair. See `withRejectionListener`.
   */
  it("positive control: the listener DOES fire for a genuinely unhandled rejection", async () => {
    await withRejectionListener(async (seen) => {
      void Promise.reject(new Error("control"));
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000 });
    });
  });

  it("a failing action produces no unhandled rejection, but still reports to crash reporting", async () => {
    mount(depsBag());
    await withRejectionListener(async (seen) => {
      runBoundAction("save", () => Promise.reject(new Error("handled")));
      await vi.waitFor(() => expect(reportErrorSpy).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// The revalidating facade
// ---------------------------------------------------------------------------

describe("revalidating facade", () => {
  it("ABORTS the rest of a body that touches a dep after teardown", async () => {
    // The facade throws rather than returning a plausible value. An earlier
    // draft returned `null` — "the documented no-active-document value" — which
    // would have let a body continue past the check it just failed and reach a
    // destructive call with the wrong argument.
    const deps = depsBag();
    const executor = mount(deps);
    const after = vi.fn();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    runBoundAction("launcher-relaunch-here", async (d) => {
      await gate;
      d.notify("info", "still here");
      after();
    });

    executor.dispose();
    release();
    await vi.waitFor(() => expect(reportErrorSpy).toHaveBeenCalled());

    expect(after).not.toHaveBeenCalled();
  });

  it("classifies a dropped call as a DROP, never as an action failure", async () => {
    // The distinction is user-visible: a drop is not something that went wrong
    // with the command, so it must not raise an error toast on the successor.
    const executor = mount(depsBag());
    const successorNotify = vi.fn();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    runBoundAction("save", async (d) => {
      await gate;
      d.focusChat();
    });

    executor.dispose();
    mount(depsBag(successorNotify));
    release();
    await vi.waitFor(() => expect(reportErrorSpy).toHaveBeenCalled());

    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ droppedMember: "focusChat" }),
    );
    expect(reportErrorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionId: "save" }),
    );
    expect(successorNotify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// notifyUser — the non-action toast path
// ---------------------------------------------------------------------------

describe("notifyUser", () => {
  it("delivers through the live bag", () => {
    const notify = vi.fn();
    mount(depsBag(notify));

    notifyUser("warning", "heads up", { dedupKey: "k" });

    expect(notify).toHaveBeenCalledWith("warning", "heads up", { dedupKey: "k" });
  });

  it("REPORTS the drop when no App is mounted rather than swallowing it", () => {
    // The optional-chained `currentActionDeps()?.notify(...)` this replaced was
    // a silent failure. The integrity advisory ("some content may not have been
    // preserved") is the message whose disappearance is worst.
    expect(currentActionDeps()).toBeNull();

    notifyUser("error", "some content may not have been preserved");

    expect(consoleWarn.mock.calls.flat().join(" ")).toContain("no App mounted");
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ droppedToast: "error" }),
    );
  });
});

// ---------------------------------------------------------------------------
// runAction — the palette entry point
// ---------------------------------------------------------------------------

describe("runAction", () => {
  const shell = (run: Action["run"]): Action => ({
    id: "third-party",
    label: "Third party",
    group: "document",
    run,
  });

  it("catches a synchronous throw from an arbitrary Action", () => {
    mount(depsBag());
    expect(() =>
      runAction(
        shell(() => {
          throw new Error("sync");
        }),
      ),
    ).not.toThrow();
    expect(reportErrorSpy).toHaveBeenCalled();
  });

  it("catches a rejection from an arbitrary Action", async () => {
    mount(depsBag());
    runAction(shell(() => Promise.reject(new Error("async"))));
    await vi.waitFor(() => expect(reportErrorSpy).toHaveBeenCalled());
  });

  it("works with no executor mounted", () => {
    expect(() =>
      runAction(
        shell(() => {
          throw new Error("sync");
        }),
      ),
    ).not.toThrow();
  });
});
