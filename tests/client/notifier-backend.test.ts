// @vitest-environment happy-dom

/**
 * Backend selection (#2168). `tauri-plugin-notification` injects its own
 * `window.Notification` into the WebView, so selection MUST check for Tauri
 * first: a feature-detect on `Notification` would send desktop notifications
 * into a plugin command the app has no grant for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeSpy } = vi.hoisted(() => ({
  invokeSpy: vi.fn((_cmd: string, _args?: unknown) => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy }));

import {
  createNotifierBackend,
  sendTestNotification,
} from "../../src/client/notifications/backend";

const constructed: { title: string; options: NotificationOptions }[] = [];

class FakeNotification {
  static permission: NotificationPermission = "granted";
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(title: string, options: NotificationOptions) {
    constructed.push({ title, options });
  }
}

function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

beforeEach(() => {
  constructed.length = 0;
  invokeSpy.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  setTauri(false);
  vi.unstubAllGlobals();
});

describe("inside Tauri, with window.Notification also defined", () => {
  beforeEach(() => setTauri(true));

  it("notify reaches notify_chat_reply and never the Notification constructor", async () => {
    createNotifierBackend().notify({ title: "Claude replied", body: "hi" }, () => {});
    await vi.waitFor(() =>
      expect(invokeSpy).toHaveBeenCalledWith("notify_chat_reply", {
        title: "Claude replied",
        body: "hi",
      }),
    );
    expect(constructed).toHaveLength(0);
  });

  it("clearAttention reaches clear_attention", async () => {
    createNotifierBackend().clearAttention();
    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalledWith("clear_attention"));
  });

  it("sendTestNotification reaches notify_test and never the Notification constructor", async () => {
    sendTestNotification();
    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalledWith("notify_test"));
    expect(constructed).toHaveLength(0);
  });
});

describe("outside Tauri", () => {
  it("notify uses the Notification constructor and never invokes", async () => {
    createNotifierBackend().notify({ title: "Claude replied", body: "hi" }, () => {});
    expect(constructed).toHaveLength(1);
    expect(constructed[0].options.tag).toBe("tandem-chat");
    await Promise.resolve();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("sendTestNotification posts under its own tag", () => {
    sendTestNotification();
    expect(constructed).toHaveLength(1);
    expect(constructed[0].title).toBe("Claude replied");
    expect(constructed[0].options.tag).toBe("tandem-chat-test");
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
