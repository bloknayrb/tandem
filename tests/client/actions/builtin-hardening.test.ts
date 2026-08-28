// @vitest-environment happy-dom

/**
 * Coverage for the failure paths round-2 review found still silent, wrong, or
 * dangerous (Unit 9, PR #1658).
 *
 * Each spec here pins one thing a user would actually experience, because in
 * every case the code "worked" and the harm was in what it said — a data-loss
 * on-ramp reporting a parse failure as "no backups exist", a successful relaunch
 * reported as a failed request, a confirm dialog that could be accepted twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScratchpad,
  relaunchClaudeHere,
  startFreshClaudeCode,
  triggerSave,
} from "../../../src/client/actions/builtin.svelte.js";
import {
  type ActionDeps,
  type ActionExecutor,
  mountActionExecutor,
} from "../../../src/client/actions/executor.js";
import { getActionsMap } from "../../../src/client/actions/registry.svelte.js";
import {
  API_BACKUPS,
  API_BACKUPS_RESTORE,
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_STATUS,
  API_SAVE,
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

/** A `Response` with a JSON body. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A 200 whose body is not JSON at all — a proxy error page, a partial write. */
function truncated(): Response {
  return new Response("<html>502 Bad Gateway", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

/** Route by URL so each spec states only the responses it cares about. */
function routes(table: Array<[string, () => Response]>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      for (const [fragment, make] of table) {
        if (url.includes(fragment)) return Promise.resolve(make());
      }
      return Promise.resolve(json({}, 500));
    }),
  );
}

/** Drive the palette's "Restore a backup…" the way the palette does. */
function runRestore(): void {
  const action = getActionsMap().get("restore-backup");
  expect(action, "the restore-backup builtin must be registered").toBeDefined();
  action?.run();
}

beforeEach(() => {
  reportErrorSpy.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  executor?.dispose();
  executor = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Restore a backup — the data-recovery on-ramp
// ---------------------------------------------------------------------------

describe("restore backup", () => {
  it("does NOT report a malformed backup list as 'no backups exist'", async () => {
    // The worst failure in the file. Someone arrives here because a save told
    // them "some content may not have been preserved — your original is backed
    // up". Collapsing a parse failure into the reassuring branch tells them the
    // backup does not exist. They stop looking; it is on disk the whole time.
    const notify = vi.fn();
    mount({ notify });
    routes([[API_BACKUPS, truncated]]);

    runRestore();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    const [severity, message] = notify.mock.calls[0];
    expect(severity).toBe("error");
    expect(String(message)).not.toContain("No backups exist");
    expect(String(message)).toContain("Couldn't read");
  });

  it("still reports a genuinely empty list as empty", async () => {
    // The other half of the split: narrowing the reassuring branch must not
    // delete it, or the honest case starts reading like a failure.
    const notify = vi.fn();
    mount({ notify });
    routes([[API_BACKUPS, () => json({ data: { backups: [] } })]]);

    runRestore();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(notify.mock.calls[0][0]).toBe("info");
    expect(String(notify.mock.calls[0][1])).toContain("No backups exist");
  });

  it("does not say the restore FAILED when the toast is what threw", async () => {
    // The file on disk has already been replaced by this point. Saying "Restore
    // request failed" makes the user restore again, or give up believing their
    // document was never recovered.
    let calls = 0;
    const notify = vi.fn((_severity: string, _message: string) => {
      calls += 1;
      // Only the success toast throws, so any "failed" message is a real one.
      if (calls === 1) throw new Error("each_key_duplicate");
    });
    mount({ notify: notify as unknown as ActionDeps["notify"] });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    routes([
      [API_BACKUPS_RESTORE, () => json({ data: {} })],
      [API_BACKUPS, () => json({ data: { backups: [{ name: "b1", timestamp: "2026-01-01" }] } })],
    ]);

    runRestore();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    const said = notify.mock.calls.map((c) => String(c[1])).join(" | ");
    expect(said).not.toContain("Restore request failed");
  });
});

// ---------------------------------------------------------------------------
// Launcher — a mutation that already happened must not be reported as failed
// ---------------------------------------------------------------------------

describe("launcher mutations", () => {
  const okStatus = () => json({ available: true });
  const okNonce = () => json({ nonce: "n1" });

  it("does not say the relaunch FAILED when the success toast is what threw", async () => {
    // Claude has already been SIGTERMed and respawned. "Relaunch request failed"
    // makes the user click again: a second SIGTERM, their task killed twice.
    let calls = 0;
    const notify = vi.fn((_severity: string, _message: string) => {
      calls += 1;
      if (calls === 1) throw new Error("each_key_duplicate");
    });
    mount({ notify: notify as unknown as ActionDeps["notify"] });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    routes([
      [API_LAUNCHER_STATUS, okStatus],
      [API_LAUNCHER_NONCE, okNonce],
      [API_LAUNCHER_RELAUNCH, () => json({ cwd: "/home/user" })],
    ]);

    relaunchClaudeHere();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    const said = notify.mock.calls.map((c) => String(c[1])).join(" | ");
    expect(said).not.toContain("Relaunch request failed");
  });

  it("claims the launcher ahead of every await, so a double-click relaunches once", async () => {
    // The defect this pins is specifically read-before-await / set-after-await:
    // the check used to sit inside `checkLauncherAvailable` ahead of the status
    // fetch while the flag was set only after it, so a second press arriving
    // during that fetch saw `false` and both went on to relaunch. Verified by
    // reconstructing exactly that shape, which turns this spec red; simply
    // moving the claim a little later does NOT, because by then the first call
    // has already set it.
    const notify = vi.fn();
    mount({ notify });
    let confirms = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => {
        confirms += 1;
        return true;
      }),
    );
    const relaunches = vi.fn();
    routes([
      [API_LAUNCHER_STATUS, okStatus],
      [API_LAUNCHER_NONCE, okNonce],
      [
        API_LAUNCHER_RELAUNCH,
        () => {
          relaunches();
          return json({ cwd: "/home/user" });
        },
      ],
    ]);

    relaunchClaudeHere();
    relaunchClaudeHere();
    await vi.waitFor(() => expect(relaunches).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));

    expect(relaunches).toHaveBeenCalledTimes(1);
    expect(confirms).toBe(1);
    // And the second press is told why, rather than reading as a dead button.
    expect(notify.mock.calls.some(([, m]) => String(m).includes("Already restarting"))).toBe(true);
  });

  it("does not re-probe the launcher when the confirm was CANCELLED", async () => {
    // The latch now precedes the modal, so reaching the `finally` no longer
    // implies a request was ever sent.
    const afterLauncherAction = vi.fn();
    mount({ afterLauncherAction });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    routes([
      [API_LAUNCHER_STATUS, okStatus],
      [API_LAUNCHER_NONCE, okNonce],
    ]);

    startFreshClaudeCode();
    await new Promise((r) => setTimeout(r, 30));

    expect(afterLauncherAction).not.toHaveBeenCalled();
  });

  it("records a malformed status body instead of only toasting about it", async () => {
    // Moving this parse inside the FetchResult contract also removed the
    // unhandled rejection that used to carry it to crash reporting. A toast in
    // place of a stack would be a net telemetry loss.
    const notify = vi.fn();
    mount({ notify });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    routes([[API_LAUNCHER_STATUS, truncated]]);

    startFreshClaudeCode();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(warn.mock.calls.flat().join(" ")).toContain("malformed-status-response");
    expect(String(notify.mock.calls[0][1])).toContain("Launcher status check failed");
  });
});

// ---------------------------------------------------------------------------
// In-flight guards — a button that does nothing must say so
// ---------------------------------------------------------------------------

describe("in-flight announcements", () => {
  /** Hold a request open so a second call lands while the first is in flight. */
  function pending(fragment: string): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(fragment)) await gate;
        return json({ data: { status: "saved" } });
      }),
    );
    return { release };
  }

  it("tells the tray Retry that a save is already running", async () => {
    // `triggerSave`'s in-flight guard backs a BUTTON in the activity tray. A
    // click that does nothing and says nothing is what a broken retry looks like.
    const notify = vi.fn();
    mount({ notify });
    const { release } = pending(API_SAVE);

    const first = triggerSave("doc-1");
    await triggerSave("doc-1", { announceBusy: true });

    expect(notify).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("already in progress"),
      expect.objectContaining({ dedupKey: "save-inflight" }),
    );
    release();
    await first;
  });

  it("stays silent for a programmatic re-entrant save", async () => {
    const notify = vi.fn();
    mount({ notify });
    const { release } = pending(API_SAVE);

    const first = triggerSave("doc-1");
    await triggerSave("doc-1");

    expect(notify).not.toHaveBeenCalled();
    release();
    await first;
  });

  it("keeps the scratchpad opt-in default silent", async () => {
    // Guards the pairing itself: the auto-open effect has no gesture behind it.
    const notify = vi.fn();
    mount({ notify });
    const { release } = pending("scratchpad");

    const first = createScratchpad();
    await createScratchpad();

    expect(notify).not.toHaveBeenCalled();
    release();
    await first;
  });
});
