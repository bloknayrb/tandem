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
