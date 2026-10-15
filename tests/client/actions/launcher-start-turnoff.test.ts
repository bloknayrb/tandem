// @vitest-environment happy-dom

/**
 * The Start and Turn off actions for Tandem's Claude (#2195), registered as
 * `launcher-start` / `launcher-turn-off` and exported as `startTandemClaude` /
 * `turnOffTandemClaude` for the pill, empty state and chat panel.
 *
 * What they must send is the contract: Start posts `userInitiated: true` to
 * `/api/launcher/start` (without it the server answers the Rust shell's
 * idempotent no-op), and Turn off posts a PARTIAL patch — `startMode` alone —
 * so it can never put back a lifetime another window just changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFF_NOT_SAVED_MESSAGE,
  startTandemClaude,
  turnOffTandemClaude,
} from "../../../src/client/actions/builtin.svelte.js";
import { type ActionExecutor, mountActionExecutor } from "../../../src/client/actions/executor.js";
import { getActionsMap } from "../../../src/client/actions/registry.svelte.js";
import { API_BASE } from "../../../src/client/utils/fileUpload.js";
import {
  API_LAUNCHER_NONCE,
  API_LAUNCHER_SETTINGS,
  API_LAUNCHER_START,
  API_LAUNCHER_STATUS,
} from "../../../src/shared/api-paths.js";
import { LAUNCHER_ERROR_OFF_NOT_SAVED } from "../../../src/shared/launcher/contract.js";
import { makeActionDeps } from "./deps-bag.js";

const STATUS_URL = `${API_BASE}${API_LAUNCHER_STATUS}`;
const NONCE_URL = `${API_BASE}${API_LAUNCHER_NONCE}`;
const START_URL = `${API_BASE}${API_LAUNCHER_START}`;
const SETTINGS_URL = `${API_BASE}${API_LAUNCHER_SETTINGS}`;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

let status: Record<string, unknown>;
let fetchSpy: ReturnType<typeof vi.fn>;
let notify: ReturnType<
  typeof vi.fn<(severity: "info" | "warning" | "error", message: string) => void>
>;
let afterLauncherAction: ReturnType<typeof vi.fn<() => void>>;
let executor: ActionExecutor | null = null;

beforeEach(() => {
  status = { available: true, running: false, standby: "off" };
  fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u === STATUS_URL) return jsonResponse(200, status);
    if (u === NONCE_URL) return jsonResponse(200, { nonce: "n-1" });
    if (u === START_URL) return jsonResponse(200, { ok: true, started: true });
    if (u === SETTINGS_URL) {
      return jsonResponse(200, {
        ok: true,
        settings: { startMode: "off", lifetime: "always", idleMinutes: 30 },
      });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  notify = vi.fn<(severity: "info" | "warning" | "error", message: string) => void>();
  afterLauncherAction = vi.fn<() => void>();
  executor = mountActionExecutor(makeActionDeps({ notify, afterLauncherAction }));
});

afterEach(() => {
  executor?.dispose();
  executor = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function postTo(url: string): Record<string, unknown> | undefined {
  const call = fetchSpy.mock.calls.find(
    ([u, init]) => String(u) === url && init?.method === "POST",
  );
  return call ? (JSON.parse(call[1].body as string) as Record<string, unknown>) : undefined;
}

async function until(probe: () => unknown): Promise<void> {
  await vi.waitFor(() => expect(probe()).toBeTruthy());
}

describe("launcher-start / startTandemClaude", () => {
  it("registers under the claude group", () => {
    expect(getActionsMap().get("launcher-start")?.group).toBe("claude");
    expect(getActionsMap().get("launcher-turn-off")?.group).toBe("claude");
  });

  it("POSTs /api/launcher/start with userInitiated and a fresh nonce, then re-probes", async () => {
    startTandemClaude();
    await until(() => postTo(START_URL));
    expect(postTo(START_URL)).toEqual({ userInitiated: true, nonce: "n-1" });
    await until(() => afterLauncherAction.mock.calls.length > 0);
  });

  it("the palette entry runs the same action", async () => {
    getActionsMap().get("launcher-start")?.run();
    await until(() => postTo(START_URL));
    expect(postTo(START_URL)).toMatchObject({ userInitiated: true });
  });

  it("is refused while the licence refuses the AI (#1521) — no POST, and the notice says 'started'", async () => {
    executor?.dispose();
    executor = mountActionExecutor(
      makeActionDeps({ notify, afterLauncherAction, aiNotice: () => "unlicensed" }),
    );
    startTandemClaude();
    await until(() => notify.mock.calls.length > 0);
    expect(notify.mock.calls[0][1]).toContain("can't be started");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not POST when the launcher is not set up", async () => {
    status = { available: false, reason: "not-configured" };
    startTandemClaude();
    await until(() => notify.mock.calls.length > 0);
    expect(postTo(START_URL)).toBeUndefined();
    expect(afterLauncherAction).not.toHaveBeenCalled();
  });
});

describe("launcher-turn-off / turnOffTandemClaude", () => {
  it("POSTs a partial patch — startMode alone — so it cannot revert another field", async () => {
    status = { available: true, running: true, busy: false };
    turnOffTandemClaude();
    await until(() => postTo(SETTINGS_URL));
    expect(postTo(SETTINGS_URL)).toEqual({ patch: { startMode: "off" }, nonce: "n-1" });
    expect(confirm).not.toHaveBeenCalled();
    await until(() => afterLauncherAction.mock.calls.length > 0);
  });

  it("an Off the server stopped but could not save warns 'off now, not saved' — never 'couldn't turn off'", async () => {
    status = { available: true, running: true, busy: false };
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === STATUS_URL) return jsonResponse(200, status);
      if (u === NONCE_URL) return jsonResponse(200, { nonce: "n-1" });
      if (u === SETTINGS_URL) {
        return jsonResponse(409, { code: LAUNCHER_ERROR_OFF_NOT_SAVED, message: "server copy" });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    turnOffTandemClaude();
    await until(() => notify.mock.calls.length > 0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("warning", OFF_NOT_SAVED_MESSAGE);
    // It did stop, so the status surfaces re-read.
    await until(() => afterLauncherAction.mock.calls.length > 0);
  });

  it("asks first when a turn is in flight, and a 'no' sends nothing", async () => {
    status = { available: true, running: true, busy: true };
    vi.mocked(confirm).mockReturnValue(false);
    turnOffTandemClaude();
    await until(() => vi.mocked(confirm).mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(postTo(SETTINGS_URL)).toBeUndefined();
    expect(afterLauncherAction).not.toHaveBeenCalled();
  });
});
