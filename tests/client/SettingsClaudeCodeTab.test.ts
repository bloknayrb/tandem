// @vitest-environment happy-dom

import { render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";

/**
 * #1022 — AI-setup discoverability in Settings → AI Assistant.
 *
 * A user with Claude credentials but no configured integration used to land
 * on this tab and find nothing saying AI wasn't set up; the only entry point
 * was a bottom button labeled "Reopen integration wizard…". These tests pin
 * the unconfigured-state callout, its gating (never on load failure — the
 * error banner owns that state), and the adaptive wizard-button label.
 */

function makeProps() {
  return {
    open: true,
    settings: {
      selectionDwellMs: 1000,
      selectionToolbar: true,
      marginView: false,
    } as TandemSettings,
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    notify: vi.fn(),
  };
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

function mockIntegrations(integrations: Array<{ kind: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ integrations }),
    }),
  );
}

describe("SettingsClaudeCodeTab — Connect AI discoverability (#1022)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the Connect AI callout when no claude-code integration exists", async () => {
    mockIntegrations([]);
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-connect-ai-callout")).toBeTruthy();
    });
    // The callout must say no API key is needed — the #1022 user had Claude
    // credentials and assumed an API key was the missing piece.
    expect(container.textContent).toContain("no API key needed");
    expect(byTestId(container, "settings-modal-connect-ai-btn")).toBeTruthy();
    // Unconfigured: the wizard button is the setup entry point, not a re-entry.
    expect(byTestId(container, "settings-modal-open-integration-wizard")?.textContent).toContain(
      "Open integration wizard…",
    );
  });

  it("Connect AI button dispatches the wizard-open event", async () => {
    mockIntegrations([]);
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
    await waitFor(() => {
      expect(byTestId(container, "settings-modal-connect-ai-btn")).toBeTruthy();
    });

    const onOpen = vi.fn();
    window.addEventListener("tandem:open-integration-wizard", onOpen);
    try {
      byTestId(container, "settings-modal-connect-ai-btn")?.click();
      await tick();
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("tandem:open-integration-wizard", onOpen);
    }
  });

  it("hides the callout when a claude-code integration is configured", async () => {
    mockIntegrations([{ kind: "claude-code" }]);
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    // The configured-state working-directory section is the load-settled signal.
    await waitFor(() => {
      expect(byTestId(container, "settings-modal-working-directory")).toBeTruthy();
    });
    expect(byTestId(container, "settings-modal-connect-ai-callout")).toBeNull();
    expect(byTestId(container, "settings-modal-open-integration-wizard")?.textContent).toContain(
      "Reopen integration wizard…",
    );
  });

  it("suppresses the callout on load failure (error banner owns that state)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-working-directory-load-error")).toBeTruthy();
    });
    // Load failed → unknown whether an integration exists; claiming
    // "no AI connected" would be a guess.
    expect(byTestId(container, "settings-modal-connect-ai-callout")).toBeNull();
  });

  it("does not flash the callout before the integrations load settles", () => {
    // A fetch that never resolves keeps wdLoaded false.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    expect(byTestId(container, "settings-modal-connect-ai-callout")).toBeNull();
    // While load is pending the button keeps its historical label, so
    // configured users (the common case) never see it flicker to "Open…".
    expect(byTestId(container, "settings-modal-open-integration-wizard")?.textContent).toContain(
      "Reopen integration wizard…",
    );
  });
});
