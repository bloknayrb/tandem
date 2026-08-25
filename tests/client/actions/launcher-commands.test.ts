// @vitest-environment happy-dom

/**
 * Unit coverage for the two Claude-launcher palette commands
 * (`launcher-relaunch-here`, `launcher-start-fresh`) registered by
 * `src/client/actions/builtin.svelte.ts` (#803 T8).
 *
 * Neither `relaunchHere` nor `startFreshConversation` is exported — they're
 * module-private and reachable only via the registered palette actions. We
 * import the module (registration is a top-level side effect), wire a mock
 * dependency bag, pull the action out of the registry, and drive its `run()`.
 *
 * Both commands share a fetch sequence:
 *   1. GET  /api/launcher/status   (availability probe)
 *   2. GET  /api/launcher/nonce    (single-use mutation nonce)
 *   3. POST /api/launcher/{relaunch|start-fresh}  (the mutation under test)
 *
 * The assertions focus on (a) the POST hits the right URL — cross-referenced
 * against `src/shared/api-paths.ts` — and (b) the body shape (cwd + nonce for
 * relaunch; nonce-only for start-fresh).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Importing the module registers the actions as a top-level side effect.
// `wireActionDeps` is the documented seam for injecting the dependency bag.
import { relaunchClaudeCode, wireActionDeps } from "../../../src/client/actions/builtin.svelte.js";
import { type Action, getActionsMap } from "../../../src/client/actions/registry.svelte.js";
import { API_BASE } from "../../../src/client/utils/fileUpload.js";
import {
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
} from "../../../src/shared/api-paths.js";

const afterLauncherAction = vi.fn();

const STATUS_URL = `${API_BASE}${API_LAUNCHER_STATUS}`;
const NONCE_URL = `${API_BASE}${API_LAUNCHER_NONCE}`;
const RELAUNCH_URL = `${API_BASE}${API_LAUNCHER_RELAUNCH}`;
const START_FRESH_URL = `${API_BASE}${API_LAUNCHER_START_FRESH}`;

const TEST_NONCE = "nonce-abc-123";

/** Minimal Response stub — only the surfaces `builtin.svelte.ts` touches. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

/**
 * Builds a fetch stub that answers the status/nonce GETs and records the
 * mutation POST. Returns the spy so callers can assert call args.
 *
 * `available` toggles whether the launcher reports as usable; defaults to a
 * running, available launcher so the happy path proceeds to the POST.
 */
function installFetchStub(
  opts: {
    available?: boolean;
    rejectCwd?: boolean;
    skillRefresh?: { code: "read-failed" | "write-failed"; message: string };
  } = {},
): ReturnType<typeof vi.fn> {
  const available = opts.available ?? true;
  const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === STATUS_URL) {
      return available
        ? jsonResponse(200, {
            available: true,
            running: true,
            reaperPid: 42,
            sessionId: "<set>",
            resuming: false,
          })
        : jsonResponse(200, {
            available: false,
            reason: "stdio-mode",
            ...(opts.skillRefresh ? { skillRefresh: opts.skillRefresh } : {}),
          });
    }
    if (u === NONCE_URL) {
      return jsonResponse(200, { nonce: TEST_NONCE });
    }
    if (u === RELAUNCH_URL || u === START_FRESH_URL) {
      // Mirrors the server: `resolveRouteCwd` home-confines, so ANY cwd this
      // stub is handed is rejected, while an omitted one is accepted. That is
      // the real shape of the bug — the rejection is a property of the path,
      // not of the request being malformed.
      if (opts.rejectCwd && u === RELAUNCH_URL) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { cwd?: unknown };
        if (body.cwd !== undefined) {
          return jsonResponse(400, {
            error: "BAD_REQUEST",
            code: "PATH_REJECTED",
            message: "cwd must be an absolute path inside the user's home directory",
          });
        }
      }
      return jsonResponse(200, { ok: true, cwd: "/home/user/configured" });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function getAction(id: string): Action {
  const action = getActionsMap().get(id);
  if (!action) throw new Error(`action "${id}" not registered`);
  return action;
}

/** Drive an action and wait a microtask flush so the async `run()` settles. */
async function runAction(id: string): Promise<void> {
  getAction(id).run();
  // `run()` kicks off an async chain it doesn't await; flush the queue.
  await vi.waitFor(() => {
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
  // Allow the post-status/nonce POST to resolve too.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

let notify: ReturnType<
  typeof vi.fn<(severity: "info" | "warning" | "error", message: string) => void>
>;

beforeEach(() => {
  notify = vi.fn();
  // confirm() gates both mutations behind a user prompt — default to "yes".
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  // Active document lives in a real folder so relaunch can derive a cwd.
  wireDeps("/home/user/project/notes.md");
});

/** Rewire the dependency bag with a different active-document path. Only that
 * path varies across these tests, and it is what `deriveCwdFromDocPath` reads
 * to build the cwd — so it is the one knob worth parameterizing. `null` models
 * the empty state: no tab, hence no derivable cwd. */
function wireDeps(activeDocumentPath: string | null): void {
  wireActionDeps({
    getActiveTabId: () => (activeDocumentPath ? "doc-1" : null),
    getActiveDocumentPath: () => activeDocumentPath,
    notify,
    // #1282: both relaunch entry points must re-probe launcher-derived state.
    // Captured so `relaunchClaudeHere`'s call can be asserted.
    afterLauncherAction,
    openSettings: vi.fn(),
    toggleSoloMode: vi.fn(),
    openFindBar: vi.fn(),
    openFindBarTabs: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
    closeActiveTab: vi.fn(),
    openFileDialog: vi.fn(),
    toggleLeftPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    reopenClosedTab: vi.fn(),
    annotationNext: vi.fn(),
    annotationPrev: vi.fn(),
    annotationAccept: vi.fn(),
    annotationDismiss: vi.fn(),
    selectBlock: vi.fn(),
    toggleAuthorship: vi.fn(),
    toggleFormattingBar: vi.fn(),
    toggleSourceView: vi.fn(),
    focusChat: vi.fn(),
    save: vi.fn(async () => {}),
    saveAs: vi.fn(async () => {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("launcher palette commands — registration", () => {
  it("registers both launcher actions under the claude group", () => {
    const relaunch = getAction("launcher-relaunch-here");
    const startFresh = getAction("launcher-start-fresh");
    expect(relaunch.group).toBe("claude");
    expect(startFresh.group).toBe("claude");
  });
});

describe("launcher-relaunch-here", () => {
  it("POSTs the relaunch endpoint with { cwd, nonce, persistCwd }", async () => {
    const fetchSpy = installFetchStub();
    await runAction("launcher-relaunch-here");

    const post = fetchSpy.mock.calls.find(([url]) => String(url) === RELAUNCH_URL);
    expect(post, "relaunch POST should have fired").toBeDefined();

    const [url, init] = post!;
    expect(String(url)).toBe(RELAUNCH_URL);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    // cwd is path.dirname of the active document path. `persistCwd` rides along
    // because THIS action is the explicit one: the user picked "relaunch here",
    // so the folder is a choice and may be made to stick. The recovery chip
    // sends the same kind of derived cwd and must NOT set it — see below.
    expect(body).toEqual({ cwd: "/home/user/project", nonce: TEST_NONCE, persistCwd: true });
  });

  it("the recovery chip sends the derived cwd WITHOUT persistCwd", async () => {
    // `relaunchClaudeCode()` backs the status-pill / empty-state / AI-toast
    // "Restart Claude Code" CTA. It is a recovery action, and its cwd is
    // whatever tab happens to be open — a guess, not a choice. Sending
    // persistCwd here would mean clicking Restart with a stray note open
    // repoints Claude at that note's folder for every future launch.
    const fetchSpy = installFetchStub();
    relaunchClaudeCode();
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => String(url) === RELAUNCH_URL)).toBe(true),
    );

    const post = fetchSpy.mock.calls.find(([url]) => String(url) === RELAUNCH_URL);
    const body = JSON.parse(post![1]?.body as string);
    expect(body.cwd).toBe("/home/user/project");
    expect(body.persistCwd).toBeUndefined();
  });

  it("discloses the durable half in the confirm — and only where it applies", async () => {
    // The palette action is the only caller that sets persistCwd, so its click
    // rewrites the integration's workingDirectory for every future launch,
    // with no undo and no backup of the previous value. The confirm is the one
    // place that can make that non-silent. The recovery chip must NOT make the
    // same claim — it sends the same kind of derived cwd and persists nothing.
    installFetchStub();
    const confirmMock = globalThis.confirm as unknown as ReturnType<typeof vi.fn>;
    await runAction("launcher-relaunch-here");
    const palettePrompt = String(confirmMock.mock.calls[0]?.[0]);
    expect(palettePrompt).toContain("future restarts");
    expect(palettePrompt).toContain("interrupted");

    confirmMock.mockClear();
    // Drive the chip with the SAME derivable cwd, so the two prompts differ by
    // the branch under test rather than by collapsing to the shared no-cwd
    // string (which would make the negative assertion vacuous).
    relaunchClaudeCode();
    await vi.waitFor(() => expect(confirmMock.mock.calls.length).toBeGreaterThan(0));
    const chipPrompt = String(confirmMock.mock.calls[0]?.[0]);
    expect(chipPrompt).toContain("/home/user/project");
    expect(chipPrompt).not.toContain("future restarts");
  });

  it("does not POST when the launcher is unavailable", async () => {
    const fetchSpy = installFetchStub({ available: false });
    getAction("launcher-relaunch-here").run();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(STATUS_URL));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === RELAUNCH_URL)).toBe(false);
  });

  it("warns about a failed skill refresh even when the launcher is unavailable", async () => {
    const fetchSpy = installFetchStub({
      available: false,
      skillRefresh: { code: "write-failed", message: "simulated disk failure" },
    });

    getAction("launcher-relaunch-here").run();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(STATUS_URL));
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "warning",
        expect.stringContaining("Bundled skill refresh failed: simulated disk failure"),
      ),
    );
  });
});

describe("launcher-start-fresh", () => {
  it("POSTs the start-fresh endpoint with { nonce } only", async () => {
    const fetchSpy = installFetchStub();
    await runAction("launcher-start-fresh");

    const post = fetchSpy.mock.calls.find(([url]) => String(url) === START_FRESH_URL);
    expect(post, "start-fresh POST should have fired").toBeDefined();

    const [url, init] = post!;
    expect(String(url)).toBe(START_FRESH_URL);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ nonce: TEST_NONCE });
  });

  it("does not POST when the user cancels the confirm prompt", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const fetchSpy = installFetchStub();
    getAction("launcher-start-fresh").run();
    // Status probe still runs; the confirm gate aborts before nonce/POST.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(STATUS_URL));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === START_FRESH_URL)).toBe(false);
  });
});

/**
 * The AI-chip restart path (`relaunchClaudeCode`) versus the palette command.
 *
 * They share `relaunchHere`, but differ in one respect that #1268 got wrong:
 * the chip FALLS BACK to the server's configured working directory when no
 * document is open, while the palette command — "Relaunch Claude in this
 * folder" — still refuses. The empty state, the chip's most important surface,
 * renders exactly when no tab is active, so requiring a cwd there made its only
 * safe recovery unreachable while the session-destroying secondary kept working.
 */
describe("AI-chip relaunch vs. palette relaunch", () => {
  async function drive(fn: () => void, fetchSpy: ReturnType<typeof vi.fn>): Promise<void> {
    fn();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(STATUS_URL));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it("POSTs with no cwd when no document is open (the empty-state case)", async () => {
    // Against the pre-change code this test fails at the POST assertion: the
    // `if (!cwd)` guard fired and the request was never made at all.
    wireDeps(null);
    const fetchSpy = installFetchStub();
    await drive(relaunchClaudeCode, fetchSpy);

    const post = fetchSpy.mock.calls.find(([url]) => String(url) === RELAUNCH_URL);
    expect(post).toBeDefined();
    const body = JSON.parse(post![1]?.body as string);
    expect(body).toEqual({ nonce: TEST_NONCE });
    expect(body.cwd).toBeUndefined();
  });

  it("still sends the document's folder when one IS open (fall back, don't switch)", async () => {
    // The regression guard for the fix itself. StatusBar's pill and the
    // addressed-AI toast share this entry point and are NOT gated on having a
    // tab — switching them all to the no-cwd form would silently move Claude's
    // project root for every user it already worked for.
    wireDeps("/home/user/project/notes.md");
    const fetchSpy = installFetchStub();
    await drive(relaunchClaudeCode, fetchSpy);

    const post = fetchSpy.mock.calls.find(([url]) => String(url) === RELAUNCH_URL);
    expect(post).toBeDefined();
    const body = JSON.parse(post![1]?.body as string);
    expect(body.cwd).toBe("/home/user/project");
  });

  it("EVERY launcher action re-probes launcher state", async () => {
    // This used to be the callers' job and they did not all do it: App wrapped
    // the status-pill and empty-state paths, while the palette invoked the same
    // relaunch directly and never re-probed. The #1282 drift probe re-arms on the
    // document path and an explicit refresh, neither of which a relaunch changes
    // — so after a palette relaunch the amber pill went on naming the folder
    // Claude had just left, indefinitely.
    wireDeps("/home/user/project/notes.md");
    for (const [label, run] of [
      ["palette relaunch-here", () => getActionsMap().get("launcher-relaunch-here")?.run()],
      ["palette start-fresh", () => getActionsMap().get("launcher-start-fresh")?.run()],
      ["recovery chip", relaunchClaudeCode],
    ] as const) {
      afterLauncherAction.mockClear();
      const fetchSpy = installFetchStub();
      await drive(run as () => void, fetchSpy);
      expect(afterLauncherAction, label).toHaveBeenCalled();
    }
  });

  it("the palette command still refuses with no document open", async () => {
    // "Relaunch Claude in this folder" has no folder to name here, so refusing
    // and saying why is right. This is what keeps the change from reading as
    // "the cwd requirement was dropped everywhere".
    wireDeps(null);
    const fetchSpy = installFetchStub();
    await drive(() => getAction("launcher-relaunch-here").run(), fetchSpy);

    expect(fetchSpy.mock.calls.some(([url]) => String(url) === RELAUNCH_URL)).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("isn't saved to a folder"),
    );
  });

  it("tells the user when a restart is already in flight instead of doing nothing", async () => {
    // `checkLauncherAvailable`'s in-flight guard was the one branch that bailed
    // without notifying. That was tolerable while these were palette-only
    // commands; the empty state now renders buttons for the same code path,
    // including a "Restart Claude anyway" shown to someone who has just been
    // told to install software they believe they already have. A second click
    // landing on complete silence reads as a broken button.
    wireDeps(null);
    let releaseRelaunch: (() => void) | undefined;
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === STATUS_URL) {
        return jsonResponse(200, {
          available: true,
          running: true,
          reaperPid: 42,
          sessionId: "<set>",
          resuming: false,
        });
      }
      if (u === NONCE_URL) return jsonResponse(200, { nonce: TEST_NONCE });
      if (u === RELAUNCH_URL) {
        // Hold the mutation open so the second click lands mid-flight.
        await new Promise<void>((r) => {
          releaseRelaunch = r;
        });
        return jsonResponse(200, { ok: true, cwd: "/home/user/configured" });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    relaunchClaudeCode();
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.some(([u]) => String(u) === RELAUNCH_URL)).toBe(true),
    );

    // Second click while the first is still open.
    notify.mockClear();
    relaunchClaudeCode();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith("info", expect.stringContaining("Already restarting"));

    // Positive control: exactly one relaunch was actually issued, so the notify
    // above is the guard reporting itself — not a second request going through.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u) === RELAUNCH_URL).length).toBe(1);

    releaseRelaunch?.();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("names the folder the server reports when it sent none", async () => {
    // The success toast is the only place a user learns where Claude landed
    // after a no-cwd restart; the server echoes it back from live state.
    wireDeps(null);
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === STATUS_URL) {
        return jsonResponse(200, {
          available: true,
          running: true,
          reaperPid: 42,
          sessionId: "<set>",
          resuming: false,
        });
      }
      if (u === NONCE_URL) return jsonResponse(200, { nonce: TEST_NONCE });
      if (u === RELAUNCH_URL) return jsonResponse(200, { ok: true, cwd: "/home/user/configured" });
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    await drive(relaunchClaudeCode, fetchSpy);

    expect(notify).toHaveBeenCalledWith("info", "Claude restarting in /home/user/configured.");
  });
});

/**
 * A derived cwd the server refuses.
 *
 * `deriveCwdFromDocPath` is `dirname` of whatever tab is active — a guess, and
 * the server home-confines it via `resolveRouteCwd`. Tandem itself auto-opens
 * CHANGELOG.md after an upgrade and sample/welcome.md on first run, both from
 * inside the app bundle, so on the two states EVERY desktop user passes through
 * the guess is guaranteed to be rejected. A real macOS tester hit exactly this
 * on v0.20.0 with CHANGELOG.md open: the 400 landed before any relaunch, so the
 * recovery button reported failure and did nothing.
 *
 * The bug predates v0.20.0 — `cwdRequired: false` only ever forgave a *null*
 * cwd, never a present-but-rejected one. External drives, network shares and
 * since-deleted folders reject identically, so this covers a class rather than
 * the two bundled documents.
 */
describe("relaunch with a server-rejected cwd", () => {
  const BUNDLE_DOC = "/Applications/Tandem.app/Contents/Resources/CHANGELOG.md";
  const BUNDLE_DIR = "/Applications/Tandem.app/Contents/Resources";

  async function drive(fn: () => void, fetchSpy: ReturnType<typeof vi.fn>): Promise<void> {
    fn();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(STATUS_URL));
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  }

  function relaunchPosts(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
    return fetchSpy.mock.calls
      .filter(([url]) => String(url) === RELAUNCH_URL)
      .map(([, init]) => JSON.parse((init as RequestInit)?.body as string));
  }

  it("chip path retries without the cwd and succeeds", async () => {
    wireDeps(BUNDLE_DOC);
    const fetchSpy = installFetchStub({ rejectCwd: true });
    await drive(relaunchClaudeCode, fetchSpy);

    const posts = relaunchPosts(fetchSpy);
    expect(posts, "should have attempted, been rejected, then retried").toHaveLength(2);
    // First attempt carries the bundle folder — we still PREFER the document's
    // directory; the retry is a fallback, not a replacement.
    expect(posts[0]).toEqual({ cwd: BUNDLE_DIR, nonce: TEST_NONCE });
    // Retry drops cwd entirely rather than substituting a guess of its own.
    expect(posts[1]).toEqual({ nonce: TEST_NONCE });
    expect(posts[1].cwd).toBeUndefined();
  });

  it("chip path reports success, not the rejection, to the user", async () => {
    // The rejection is an implementation detail of a recovery that worked.
    // Surfacing it too would be the bug's symptom with extra steps.
    wireDeps(BUNDLE_DOC);
    const fetchSpy = installFetchStub({ rejectCwd: true });
    await drive(relaunchClaudeCode, fetchSpy);

    expect(notify).toHaveBeenCalledWith("info", "Claude restarting in /home/user/configured.");
    expect(notify).not.toHaveBeenCalledWith("error", expect.stringContaining("Relaunch failed"));
  });

  it("palette command surfaces the rejection and does NOT retry", async () => {
    // "Relaunch Claude in this folder" named a folder in its confirm prompt.
    // Silently restarting somewhere else would make that prompt a lie, and it
    // is also the security-review ask: the strict path must not inherit the
    // fallback, or a genuine client bug fails open instead of loud.
    wireDeps(BUNDLE_DOC);
    const fetchSpy = installFetchStub({ rejectCwd: true });
    await drive(() => getAction("launcher-relaunch-here").run(), fetchSpy);

    expect(relaunchPosts(fetchSpy)).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("must be an absolute path inside"),
    );
  });

  it("a cwd the server accepts is never retried", async () => {
    // Negative control. Without this, the two tests above would still pass if
    // the retry fired unconditionally on every relaunch.
    wireDeps("/home/user/project/notes.md");
    const fetchSpy = installFetchStub();
    await drive(relaunchClaudeCode, fetchSpy);

    const posts = relaunchPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ cwd: "/home/user/project", nonce: TEST_NONCE });
  });
});
