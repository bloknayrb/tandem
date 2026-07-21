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
import { wireActionDeps } from "../../../src/client/actions/builtin.svelte.js";
import { type Action, getActionsMap } from "../../../src/client/actions/registry.svelte.js";
import { API_BASE } from "../../../src/client/utils/fileUpload.js";
import {
  API_LAUNCHER_NONCE,
  API_LAUNCHER_RELAUNCH,
  API_LAUNCHER_START_FRESH,
  API_LAUNCHER_STATUS,
} from "../../../src/shared/api-paths.js";

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
function installFetchStub(opts: { available?: boolean } = {}): ReturnType<typeof vi.fn> {
  const available = opts.available ?? true;
  const fetchSpy = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
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
        : jsonResponse(200, { available: false, reason: "stdio-mode" });
    }
    if (u === NONCE_URL) {
      return jsonResponse(200, { nonce: TEST_NONCE });
    }
    if (u === RELAUNCH_URL || u === START_FRESH_URL) {
      return jsonResponse(200, { ok: true });
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

let notify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  notify = vi.fn();
  // confirm() gates both mutations behind a user prompt — default to "yes".
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  // Active document lives in a real folder so relaunch can derive a cwd.
  wireActionDeps({
    getActiveTabId: () => "doc-1",
    getActiveDocumentPath: () => "/home/user/project/notes.md",
    notify,
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
  });
});

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
  it("POSTs the relaunch endpoint with { cwd, nonce }", async () => {
    const fetchSpy = installFetchStub();
    await runAction("launcher-relaunch-here");

    const post = fetchSpy.mock.calls.find(([url]) => String(url) === RELAUNCH_URL);
    expect(post, "relaunch POST should have fired").toBeDefined();

    const [url, init] = post!;
    expect(String(url)).toBe(RELAUNCH_URL);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    // cwd is path.dirname of the active document path.
    expect(body).toEqual({ cwd: "/home/user/project", nonce: TEST_NONCE });
  });

  it("does not POST when the launcher is unavailable", async () => {
    const fetchSpy = installFetchStub({ available: false });
    getAction("launcher-relaunch-here").run();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(STATUS_URL));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === RELAUNCH_URL)).toBe(false);
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
