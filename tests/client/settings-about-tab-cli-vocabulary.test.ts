// @vitest-environment happy-dom

/**
 * #1824 item N — three About-tab toasts unconditionally said 'try `tandem
 * doctor` in a terminal', but the desktop app has no `tandem` command
 * (#1817's own precedent). Desktop must point at the in-tab "Open Log
 * Folder" button instead; the non-Tauri (npm-global / browser) build keeps
 * the CLI wording, since the `tandem` command genuinely exists there.
 *
 * `isTauriRuntime` is mocked at module scope (same idiom as
 * `settings-claude-code-tab-cowork.test.ts`), and every other collaborator
 * (`createAppInfo`, `fetchDiagnostics`, `formatDiagnostics`/`summarizeUserAgent`,
 * `readClientLog`) is mocked to isolate the three toast paths from network
 * and cache state.
 */

import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

let tauri = true;

vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => tauri };
});

vi.mock("../../src/client/hooks/useAppInfo.svelte", () => ({
  createAppInfo: () => ({ info: null, loading: false }),
}));

vi.mock("../../src/client/utils/diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/utils/diagnostics")>()),
  formatDiagnostics: () => "fake diagnostics text",
  summarizeUserAgent: () => "Test Browser",
}));

vi.mock("../../src/client/utils/client-log", () => ({
  readClientLog: () => [],
}));

const fetchDiagnosticsMock =
  vi.fn<() => Promise<{ ok: true; payload: unknown } | { ok: false; reason: "server" }>>();
vi.mock("../../src/client/utils/diagnostics-fetch", () => ({
  fetchDiagnostics: () => fetchDiagnosticsMock(),
}));

import type { SettingsTabContext } from "../../src/client/components/SettingsModal.svelte";
import SettingsAboutTab from "../../src/client/components/settings-tabs/SettingsAboutTab.svelte";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";

function makeProps(notify: (severity: string, message: string) => void) {
  return {
    open: true,
    settings: {} as TandemSettings,
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    readOnly: false,
    notify: notify as unknown as SettingsTabContext["notify"],
  } as unknown as SettingsTabContext;
}

afterEach(() => {
  tauri = true;
  vi.clearAllMocks();
});

describe("SettingsAboutTab — internal CLI vocabulary gated on isTauriRuntime (#1824 item N)", () => {
  it("server-failure toast: desktop says Open Log Folder, browser says tandem doctor", async () => {
    fetchDiagnosticsMock.mockResolvedValue({ ok: false, reason: "server" });

    for (const isDesktop of [true, false]) {
      tauri = isDesktop;
      const notify = vi.fn();
      const { getByTestId, unmount } = render(SettingsAboutTab, {
        props: makeProps(notify),
      });
      await fireEvent.click(getByTestId("settings-modal-copy-diagnostics-btn"));
      await waitFor(() => expect(notify).toHaveBeenCalled());

      const [, message] = notify.mock.calls[0] as [string, string];
      if (isDesktop) {
        expect(message).toContain("Open Log Folder");
        expect(message).not.toContain("tandem doctor");
      } else {
        expect(message).toContain("tandem doctor");
        expect(message).not.toContain("Open Log Folder");
      }
      unmount();
    }
  });

  it("thrown-fetch toast: desktop says Open Log Folder, browser says tandem doctor", async () => {
    fetchDiagnosticsMock.mockRejectedValue(new Error("network exploded"));

    for (const isDesktop of [true, false]) {
      tauri = isDesktop;
      const notify = vi.fn();
      const { getByTestId, unmount } = render(SettingsAboutTab, {
        props: makeProps(notify),
      });
      await fireEvent.click(getByTestId("settings-modal-copy-diagnostics-btn"));
      await waitFor(() => expect(notify).toHaveBeenCalled());

      const [, message] = notify.mock.calls[0] as [string, string];
      if (isDesktop) {
        expect(message).toContain("Open Log Folder");
        expect(message).not.toContain("tandem doctor");
      } else {
        expect(message).toContain("tandem doctor");
        expect(message).not.toContain("Open Log Folder");
      }
      unmount();
    }
  });

  it("clipboard-denied toast: desktop says Open Log Folder, browser says tandem doctor", async () => {
    fetchDiagnosticsMock.mockResolvedValue({ ok: true, payload: {} });
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    for (const isDesktop of [true, false]) {
      tauri = isDesktop;
      const notify = vi.fn();
      const { getByTestId, unmount } = render(SettingsAboutTab, {
        props: makeProps(notify),
      });
      await fireEvent.click(getByTestId("settings-modal-copy-diagnostics-btn"));
      await waitFor(() => expect(notify).toHaveBeenCalled());

      const [, message] = notify.mock.calls[0] as [string, string];
      if (isDesktop) {
        expect(message).toContain("Open Log Folder");
        expect(message).not.toContain("tandem doctor");
      } else {
        expect(message).toContain("tandem doctor");
        expect(message).not.toContain("Open Log Folder");
      }
      unmount();
    }
  });
});
