// @vitest-environment happy-dom

/**
 * Settings → AI Assistant → "Tandem's Claude" (#2195).
 *
 * The rules under test are the ones the component header names: partial saves,
 * controls disabled until a VALID read, serialized saves, and fixed error
 * strings. Each is a way a stale or failed view could otherwise write `auto`
 * over a saved `off`.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsTandemClaudeSection from "../../src/client/components/settings-tabs/SettingsTandemClaudeSection.svelte";
import { API_BASE } from "../../src/client/utils/fileUpload";
import {
  API_LAUNCHER_NONCE,
  API_LAUNCHER_SETTINGS,
  API_LAUNCHER_STATUS,
} from "../../src/shared/api-paths";

const SETTINGS_URL = `${API_BASE}${API_LAUNCHER_SETTINGS}`;

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let stored: { startMode: string; lifetime: string; idleMinutes: number };
let getBody: () => unknown;
let postResponder: (patch: Record<string, unknown>) => Response | Promise<Response>;
let posts: Array<Record<string, unknown>>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stored = { startMode: "off", lifetime: "always", idleMinutes: 30 };
  getBody = () => ({ settings: { ...stored } });
  posts = [];
  postResponder = (patch) => {
    stored = { ...stored, ...(patch as typeof stored) };
    return json(200, { ok: true, settings: { ...stored } });
  };
  fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === `${API_BASE}${API_LAUNCHER_STATUS}`) {
      return json(200, { available: true, running: false, standby: "off" });
    }
    if (u === `${API_BASE}${API_LAUNCHER_NONCE}`) return json(200, { nonce: "n" });
    if (u === SETTINGS_URL && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { patch: Record<string, unknown> };
      posts.push(body.patch);
      return postResponder(body.patch);
    }
    if (u === SETTINGS_URL) return json(200, getBody());
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
}

function q<T extends HTMLElement>(container: HTMLElement, id: string): T {
  const el = container.querySelector<T>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

describe("SettingsTandemClaudeSection", () => {
  it("shows the saved choice and says plainly that it runs in the background", async () => {
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    expect(q<HTMLInputElement>(container, "settings-modal-tandem-claude-start-off").checked).toBe(
      true,
    );
    expect(
      q<HTMLInputElement>(container, "settings-modal-tandem-claude-lifetime-always").checked,
    ).toBe(true);
    expect(q(container, "settings-modal-tandem-claude-disclosure").textContent).toContain(
      "keeps running in the background",
    );
  });

  it("a start-mode click saves that field ALONE", async () => {
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    await fireEvent.click(q(container, "settings-modal-tandem-claude-start-auto"));
    await flush();
    expect(posts).toEqual([{ startMode: "auto" }]);
  });

  it("a lifetime click saves that field alone — it never carries a stale start mode", async () => {
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    // Another window turned Claude back on meanwhile; this view still shows off.
    stored = { ...stored, startMode: "auto" };
    await fireEvent.click(q(container, "settings-modal-tandem-claude-lifetime-idle"));
    await flush();
    expect(posts).toEqual([{ lifetime: "idle" }]);
    expect(stored.startMode).toBe("auto");
  });

  it("keeps every control disabled when the read does not validate", async () => {
    getBody = () => ({ integrations: [] });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const auto = q<HTMLInputElement>(container, "settings-modal-tandem-claude-start-auto");
    expect(auto.closest("fieldset")?.disabled).toBe(true);
    expect(auto.checked).toBe(false);
    expect(q(container, "settings-modal-tandem-claude-load-error")).toBeTruthy();
  });

  it("idle minutes commits on change, only valid values, and only while idle is chosen", async () => {
    stored = { ...stored, lifetime: "idle" };
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const input = q<HTMLInputElement>(container, "settings-modal-tandem-claude-idle-minutes");
    expect(input.disabled).toBe(false);
    await fireEvent.input(input, { target: { value: "0" } });
    await fireEvent.change(input);
    await flush();
    expect(posts).toEqual([]);
    expect(q(container, "settings-modal-tandem-claude-idle-error").textContent).toContain(
      "1 to 1440",
    );
    await fireEvent.input(input, { target: { value: "45" } });
    await fireEvent.change(input);
    await flush();
    expect(posts).toEqual([{ idleMinutes: 45 }]);
  });

  it("disables idle minutes while 'always' is chosen", async () => {
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    expect(
      q<HTMLInputElement>(container, "settings-modal-tandem-claude-idle-minutes").disabled,
    ).toBe(true);
  });

  it("serializes saves: a click during a save waits, and nothing is lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    postResponder = async (patch) => {
      if (first) {
        first = false;
        await gate;
      }
      stored = { ...stored, ...(patch as typeof stored) };
      return json(200, { ok: true, settings: { ...stored } });
    };
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    await fireEvent.click(q(container, "settings-modal-tandem-claude-start-auto"));
    await flush();
    await fireEvent.click(q(container, "settings-modal-tandem-claude-lifetime-idle"));
    await flush();
    expect(posts).toEqual([{ startMode: "auto" }]);
    release();
    await flush();
    expect(posts).toEqual([{ startMode: "auto" }, { lifetime: "idle" }]);
    expect(stored).toMatchObject({ startMode: "auto", lifetime: "idle" });
  });

  it("a failed save shows a fixed string and rolls the controls back to what is stored", async () => {
    postResponder = () =>
      json(409, { code: "LAUNCHER_SETTINGS_NEWER", message: "<script>server text</script>" });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    await fireEvent.click(q(container, "settings-modal-tandem-claude-start-auto"));
    await flush();
    const err = q(container, "settings-modal-tandem-claude-save-error").textContent ?? "";
    expect(err).toContain("newer version of Tandem");
    expect(err).not.toContain("server text");
    expect(q<HTMLInputElement>(container, "settings-modal-tandem-claude-start-off").checked).toBe(
      true,
    );
  });

  it("tells the status bar to re-probe after a save, so Off shows at once", async () => {
    const seen = vi.fn();
    window.addEventListener("tandem:launcher-changed", seen);
    try {
      const { container } = render(SettingsTandemClaudeSection);
      await flush();
      await fireEvent.click(q(container, "settings-modal-tandem-claude-start-auto"));
      await flush();
      expect(seen).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("tandem:launcher-changed", seen);
    }
  });

  it("an unreadable file says so, and the controls stay usable so a save can repair it", async () => {
    getBody = () => ({ settings: { ...stored, startMode: "on-click" }, unreadable: true });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    expect(q(container, "settings-modal-tandem-claude-unreadable").textContent).toContain(
      "couldn't read its saved settings",
    );
    const auto = q<HTMLInputElement>(container, "settings-modal-tandem-claude-start-auto");
    expect(auto.closest("fieldset")?.disabled).toBe(false);
  });

  it("an unreadable file the supervisor kept going on says it is keeping them, not 'waiting for Start'", async () => {
    getBody = () => ({
      settings: { ...stored, startMode: "auto" },
      unreadable: true,
      keptLastGood: true,
    });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const hint = (
      q(container, "settings-modal-tandem-claude-unreadable").textContent ?? ""
    ).replace(/\s+/g, " ");
    expect(hint).toContain("keeping the ones it last read");
    expect(hint).not.toContain("click Start");
    expect(q<HTMLInputElement>(container, "settings-modal-tandem-claude-start-auto").checked).toBe(
      true,
    );
  });

  it("an Off that stopped Claude but was not saved says so, and still tells the status bar", async () => {
    stored = { ...stored, startMode: "auto" };
    postResponder = () => json(409, { code: "LAUNCHER_OFF_NOT_SAVED", message: "server text" });
    const seen = vi.fn();
    window.addEventListener("tandem:launcher-changed", seen);
    try {
      const { container } = render(SettingsTandemClaudeSection);
      await flush();
      await fireEvent.click(q(container, "settings-modal-tandem-claude-start-off"));
      await flush();
      expect(q(container, "settings-modal-tandem-claude-save-error").textContent).toContain(
        "off now",
      );
      expect(seen).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("tandem:launcher-changed", seen);
    }
  });

  it("a queued change is not snapped back when the save ahead of it lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    postResponder = async (patch) => {
      if (first) {
        first = false;
        await gate;
      }
      stored = { ...stored, ...(patch as typeof stored) };
      return json(200, { ok: true, settings: { ...stored } });
    };
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const firstResponder = postResponder;
    let calls = 0;
    postResponder = async (patch) => {
      calls += 1;
      if (calls === 2) await secondGate;
      return firstResponder(patch);
    };
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    await fireEvent.click(q(container, "settings-modal-tandem-claude-start-auto"));
    await flush();
    await fireEvent.click(q(container, "settings-modal-tandem-claude-lifetime-idle"));
    await flush();
    release();
    await flush();
    // The first save has landed; the second is still in flight. The lifetime
    // the user chose must still be shown.
    expect(
      q<HTMLInputElement>(container, "settings-modal-tandem-claude-lifetime-idle").checked,
    ).toBe(true);
    releaseSecond();
    await flush();
    expect(stored).toMatchObject({ startMode: "auto", lifetime: "idle" });
  });
});

describe("SettingsTandemClaudeSection — the launcher-absent hint (#1823)", () => {
  function statusIs(body: unknown): void {
    const inner = fetchSpy.getMockImplementation() as
      | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined;
    fetchSpy.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url) === `${API_BASE}${API_LAUNCHER_STATUS}` ? json(200, body) : inner?.(url, init),
    );
  }

  it.each([
    ["stdio-mode", true],
    ["disabled-by-env", true],
    // The HTTP boot window: Settings used to call the launcher absent on an
    // ordinary boot, because this window read `stdio-mode`.
    ["server-starting", false],
    ["deferred-autostart", false],
  ] as const)("reason %s → absent hint shown: %s", async (reason, shown) => {
    statusIs({ available: false, reason });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    expect(
      container.querySelector("[data-testid='settings-modal-tandem-claude-absent']") !== null,
    ).toBe(shown);
  });
});

describe("SettingsTandemClaudeSection — the failed bind and the bound transports (#2358 PR 3b-2e1)", () => {
  function statusIs(body: unknown): void {
    const inner = fetchSpy.getMockImplementation() as
      | ((url: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined;
    fetchSpy.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url) === `${API_BASE}${API_LAUNCHER_STATUS}` ? json(200, body) : inner?.(url, init),
    );
  }
  const RUNNING = {
    available: true,
    running: true,
    reaperPid: 1,
    cwd: "/home/test",
    sessionId: "<set>",
    resuming: false,
  };
  const has = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid='${id}']`) !== null;

  it("says Tandem's Claude couldn't connect its Tandem tools, and offers no Start, on a stopped status", async () => {
    statusIs({ available: true, running: false, standby: "awaiting-start", bindFailed: true });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const note = q(container, "settings-modal-tandem-claude-bind-failed");
    expect(note.textContent).toContain("couldn't connect its Tandem tools");
    expect(note.textContent).toContain("Starting it again won't fix this");
    expect(note.querySelector("button")).toBeNull();
  });

  it("says it on a running status too", async () => {
    statusIs({ ...RUNNING, bindFailed: true });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    expect(has(container, "settings-modal-tandem-claude-bind-failed")).toBe(true);
  });

  it("lists the bound transports by kind, one fixed label per row", async () => {
    statusIs({ ...RUNNING, boundTransports: [{ kind: "bridge" }, { kind: "direct-http" }] });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const list = q(container, "settings-modal-tandem-claude-bound-transports");
    expect(list.textContent).toContain("by 2 connections");
    const rows = [
      ...container.querySelectorAll<HTMLElement>(
        "[data-testid='settings-modal-tandem-claude-bound-transport']",
      ),
    ];
    expect(rows.map((r) => r.dataset.kind)).toEqual(["bridge", "direct-http"]);
    expect(rows.map((r) => r.textContent?.trim())).toEqual([
      "Through Tandem's bridge",
      "Directly over HTTP",
    ]);
  });

  it("drops a kind it does not know, and renders nothing a row carries beside its kind", async () => {
    statusIs({
      ...RUNNING,
      boundTransports: [{ kind: "mystery" }, { kind: "bridge", ownerId: "claude:abc" }],
    });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const list = q(container, "settings-modal-tandem-claude-bound-transports");
    expect(list.textContent).toContain("by one connection");
    expect(list.textContent).not.toMatch(/mystery|claude:/);
  });

  it("a dark server's status (neither field) renders neither, as before", async () => {
    statusIs({ ...RUNNING, attached: true });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    expect(has(container, "settings-modal-tandem-claude-bind-failed")).toBe(false);
    expect(has(container, "settings-modal-tandem-claude-bound-transports")).toBe(false);
  });

  it("names `tandem doctor` in a browser, and only the wizard on the desktop app, which ships no `tandem` command", async () => {
    statusIs({ ...RUNNING, bindFailed: true });
    const browser = render(SettingsTandemClaudeSection);
    await flush();
    expect(q(browser.container, "settings-modal-tandem-claude-bind-failed").textContent).toContain(
      "tandem doctor",
    );
    cleanup();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const desktop = render(SettingsTandemClaudeSection);
    await flush();
    const note = q(desktop.container, "settings-modal-tandem-claude-bind-failed");
    expect(note.textContent).toContain("integration wizard");
    expect(note.textContent).not.toContain("tandem doctor");
  });

  it("re-reads while a diagnosis is shown, so a bind that lands clears the warning without a remount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      statusIs({ ...RUNNING, bindFailed: true });
      const { container } = render(SettingsTandemClaudeSection);
      await vi.advanceTimersByTimeAsync(0);
      await tick();
      expect(has(container, "settings-modal-tandem-claude-bind-failed")).toBe(true);
      statusIs({ ...RUNNING, boundTransports: [{ kind: "bridge" }] });
      await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(has(container, "settings-modal-tandem-claude-bind-failed")).toBe(false);
      expect(has(container, "settings-modal-tandem-claude-bound-transports")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a dark server's status is read once: no diagnosis, no re-read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      statusIs({ ...RUNNING });
      render(SettingsTandemClaudeSection);
      await vi.advanceTimersByTimeAsync(0);
      const statusReads = () =>
        fetchSpy.mock.calls.filter(([u]) => String(u) === `${API_BASE}${API_LAUNCHER_STATUS}`)
          .length;
      const first = statusReads();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusReads()).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the wizard's start-mode-only view renders neither", async () => {
    statusIs({ ...RUNNING, bindFailed: true, boundTransports: [{ kind: "bridge" }] });
    const { container } = render(SettingsTandemClaudeSection, { props: { startModeOnly: true } });
    await flush();
    expect(has(container, "settings-modal-tandem-claude-bind-failed")).toBe(false);
    expect(has(container, "settings-modal-tandem-claude-bound-transports")).toBe(false);
  });

  // Bryan, 2026-11-27, "401 only signs out (Recommended)": a 403 is an access
  // error on a running Claude, never the sign-in remedy.
  it("a running status with accessDenied shows an access error, never sign-in, with no button", async () => {
    statusIs({ ...RUNNING, accessDenied: true });
    const { container } = render(SettingsTandemClaudeSection);
    await flush();
    const note = q(container, "settings-modal-tandem-claude-access-denied");
    const text = (note.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("refused it access");
    expect(text).toContain("not a sign-in problem");
    expect(text).not.toMatch(/\bsign in\b|run claude/i);
    expect(note.querySelector("button")).toBeNull();
  });

  it("no accessDenied, or a stopped status carrying one, renders no access error", async () => {
    statusIs({ ...RUNNING });
    const plain = render(SettingsTandemClaudeSection);
    await flush();
    expect(has(plain.container, "settings-modal-tandem-claude-access-denied")).toBe(false);
    cleanup();
    statusIs({ available: true, running: false, lastError: "needs-login", accessDenied: true });
    const stopped = render(SettingsTandemClaudeSection);
    await flush();
    expect(has(stopped.container, "settings-modal-tandem-claude-access-denied")).toBe(false);
  });

  it("re-reads while the access error is shown, so a turn that succeeds clears it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      statusIs({ ...RUNNING, accessDenied: true });
      const { container } = render(SettingsTandemClaudeSection);
      await vi.advanceTimersByTimeAsync(0);
      await tick();
      expect(has(container, "settings-modal-tandem-claude-access-denied")).toBe(true);
      statusIs({ ...RUNNING });
      await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(has(container, "settings-modal-tandem-claude-access-denied")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
