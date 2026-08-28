// @vitest-environment happy-dom

/**
 * The funnel, asserted against the REAL builtin action bodies (Unit 9).
 *
 * `executor.test.ts` proves the executor reports a failing body. That says
 * nothing about whether the shipped actions actually route through it: the whole
 * live defect this unit removes was a `void`-ed promise in a builtin body, and
 * re-adding `void` to any one of them is invisible to a suite that only ever
 * runs bodies it wrote itself. So these specs take the action out of the
 * registry and call its `run()` — the same object the command palette calls.
 *
 * `reportError` is mocked so "the failure was reported" is asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScratchpad,
  relaunchClaudeCode,
} from "../../../src/client/actions/builtin.svelte.js";
import {
  type ActionDeps,
  type ActionExecutor,
  mountActionExecutor,
} from "../../../src/client/actions/executor.js";
import { getActionsMap } from "../../../src/client/actions/registry.svelte.js";
import {
  API_LAUNCHER_NONCE,
  API_LAUNCHER_STATUS,
  API_SCRATCHPAD,
} from "../../../src/shared/api-paths.js";
import { makeActionDeps } from "./deps-bag.js";

const reportErrorSpy = vi.fn();
vi.mock("../../../src/client/sentry.js", () => ({
  reportError: (...args: unknown[]) => reportErrorSpy(...args),
}));

let executor: ActionExecutor | null = null;
function mount(overrides: Partial<ActionDeps>): ActionDeps {
  const deps = makeActionDeps(overrides);
  executor = mountActionExecutor(deps);
  return deps;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reportErrorSpy.mockClear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  executor?.dispose();
  executor = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a shipped builtin's rejection reaches the funnel", () => {
  it("reports when the save action's dependency rejects", async () => {
    // The regression guard for the defect itself: a `void d.save()` in the
    // action body would leave this rejection unhandled and this spec red.
    const notify = vi.fn();
    mount({ notify, save: vi.fn(() => Promise.reject(new Error("save blew up"))) });

    const action = getActionsMap().get("save");
    expect(action, "the save builtin must be registered").toBeDefined();
    action?.run();

    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "actionExecutor", actionId: "save" }),
    );
    // Named by its registry label, which is what the user sees.
    expect(String(notify.mock.calls[0][1])).toContain("Save document");
  });

  it("reports when the new-scratchpad action's request rejects", async () => {
    const notify = vi.fn();
    mount({ notify });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    const action = getActionsMap().get("new-scratchpad");
    expect(action, "the new-scratchpad builtin must be registered").toBeDefined();
    action?.run();

    // createScratchpad handles its own failure, so the SPECIFIC toast is what
    // arrives — the generic funnel toast would be a second, less useful one.
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(String(notify.mock.calls[0][1])).toContain("check your connection");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("createScratchpad failure copy", () => {
  it("carries the server's own message on a non-ok response", async () => {
    const notify = vi.fn();
    mount({ notify });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes(API_SCRATCHPAD)
            ? new Response(JSON.stringify({ message: "disk is full" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
              })
            : new Response("{}", { status: 200 }),
        ),
      ),
    );

    await createScratchpad();

    expect(notify).toHaveBeenCalledTimes(1);
    const [severity, message, opts] = notify.mock.calls[0];
    expect(severity).toBe("error");
    // The server's words survive: dropping them left the one actionable detail
    // in a console the user cannot see.
    expect(String(message)).toContain("disk is full");
    // And the copy makes no claim about intent that a 500 does not support.
    expect(String(message)).not.toContain("refused");
    expect(opts).toMatchObject({ dedupKey: "scratchpad-failed", id: "scratchpad-failed" });
  });

  it("notifies on a network failure", async () => {
    const notify = vi.fn();
    mount({ notify });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    await createScratchpad();

    expect(notify).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("check your connection"),
      expect.objectContaining({ dedupKey: "scratchpad-failed" }),
    );
  });
});

describe("createScratchpad re-entry", () => {
  /** Hold the POST open so a second call lands while the first is in flight. */
  function pendingFetch(): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response("{}", { status: 200 });
      }),
    );
    return { release };
  }

  it("tells a user who pressed twice that it is still working", async () => {
    const notify = vi.fn();
    mount({ notify });
    const { release } = pendingFetch();

    const first = createScratchpad({ announceBusy: true });
    await createScratchpad({ announceBusy: true });

    expect(notify).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("Still creating"),
      expect.objectContaining({ dedupKey: "scratchpad-inflight" }),
    );
    release();
    await first;
  });

  it("stays silent for the empty-state auto-open, which has no gesture behind it", async () => {
    // The auto-open effect fires on a debounce timer. A toast there would be the
    // app talking to itself, so silence is the default and opting in is explicit.
    const notify = vi.fn();
    mount({ notify });
    const { release } = pendingFetch();

    const first = createScratchpad();
    await createScratchpad();

    expect(notify).not.toHaveBeenCalled();
    release();
    await first;
  });
});

describe("launcher reporting identity", () => {
  it("reports relaunchClaudeCode under launcher-relaunch, not the palette id", async () => {
    // The chip / empty-state path shares code with the palette command. A report
    // naming "launcher-relaunch-here" would point a reader at the wrong surface,
    // and the two ids are one suffix apart, so nothing but a spec catches a swap.
    //
    // `afterLauncherAction` is the forcing function: `relaunchHere` calls it from
    // its `finally`, unconditionally, so throwing there reaches the central
    // funnel no matter which branch the launcher fetches took. That keeps this
    // spec deterministic rather than dependent on the fetch shape.
    const notify = vi.fn();
    mount({
      notify,
      afterLauncherAction: vi.fn(() => {
        throw new Error("refresh blew up");
      }),
    });
    // The launcher has to reach its mutation for the `finally` to run at all:
    // `checkLauncherAvailable` returns early on a status failure, before the
    // try/finally exists. So status says available, the nonce resolves, and the
    // relaunch POST is what fails.
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes(API_LAUNCHER_STATUS)) {
          return Promise.resolve(
            new Response(JSON.stringify({ available: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes(API_LAUNCHER_NONCE)) {
          return Promise.resolve(
            new Response(JSON.stringify({ nonce: "n1" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 500 }));
      }),
    );

    relaunchClaudeCode();

    await vi.waitFor(() =>
      expect(
        reportErrorSpy.mock.calls.some(
          ([, ctx]) => (ctx as Record<string, unknown>)?.source === "actionExecutor",
        ),
      ).toBe(true),
    );

    const ids = reportErrorSpy.mock.calls
      .map(([, ctx]) => (ctx as Record<string, unknown>)?.actionId)
      .filter((id): id is string => typeof id === "string");
    expect(ids).toContain("launcher-relaunch");
    expect(ids).not.toContain("launcher-relaunch-here");
  });
});
