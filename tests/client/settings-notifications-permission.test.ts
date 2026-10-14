// @vitest-environment happy-dom

/**
 * Settings → Notifications follows the browser's site permission live (#2168,
 * B4): a permission changed in the browser's site settings, or answered in
 * another tab, updates the status line without reopening Settings. The desktop
 * build never queries `navigator.permissions` — its permission lives in the OS.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";

// Set BEFORE mount — the tab reads the runtime once at init.
let tauri = false;
vi.mock(import("../../src/client/cowork/cowork-helpers"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => tauri };
});

const SettingsNotificationsTab = (
  await import("../../src/client/components/settings-tabs/SettingsNotificationsTab.svelte")
).default;

class FakeStatus extends EventTarget {
  state: PermissionState = "prompt";
}

let notificationPermission: NotificationPermission;

function makeCtx() {
  return {
    open: true,
    settings: loadSettings(),
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    readOnly: false,
    notify: vi.fn(),
  };
}

function stubPermissions(query: unknown): void {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query },
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const statusText = (container: HTMLElement) =>
  container.querySelector("[data-testid='notifications-permission-status']")?.textContent ?? "";

beforeEach(() => {
  tauri = false;
  notificationPermission = "default";
  vi.stubGlobal(
    "Notification",
    class {
      static get permission() {
        return notificationPermission;
      }
      static requestPermission = vi.fn(async () => notificationPermission);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as unknown as { permissions?: unknown }).permissions;
});

describe("SettingsNotificationsTab — live browser permission", () => {
  it("a permission granted in the browser updates the status line and enables the test button", async () => {
    const status = new FakeStatus();
    const query = vi.fn(async () => status);
    stubPermissions(query);

    const { container } = render(SettingsNotificationsTab, { props: makeCtx() });
    await flush();
    expect(query).toHaveBeenCalledWith({ name: "notifications" });
    expect(statusText(container)).toContain("needs your permission");
    const testButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='notifications-test-button']",
    );
    expect(testButton?.disabled).toBe(true);

    notificationPermission = "granted";
    status.dispatchEvent(new Event("change"));
    await tick();
    expect(statusText(container)).toContain("This browser allows Tandem's notifications.");
    expect(testButton?.disabled).toBe(false);

    notificationPermission = "denied";
    status.dispatchEvent(new Event("change"));
    await tick();
    expect(statusText(container)).toContain("Notifications are blocked for this site.");
  });

  it("unmounting removes the change listener", async () => {
    const status = new FakeStatus();
    const remove = vi.spyOn(status, "removeEventListener");
    stubPermissions(vi.fn(async () => status));

    const { unmount } = render(SettingsNotificationsTab, { props: makeCtx() });
    await flush();
    unmount();
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("desktop never queries navigator.permissions", async () => {
    tauri = true;
    const query = vi.fn(async () => new FakeStatus());
    stubPermissions(query);

    const { container } = render(SettingsNotificationsTab, { props: makeCtx() });
    await flush();
    expect(query).not.toHaveBeenCalled();
    expect(statusText(container)).toContain("operating system's notification settings");
  });
});
