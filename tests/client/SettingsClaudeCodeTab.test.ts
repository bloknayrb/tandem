// @vitest-environment happy-dom

import { render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";
import { licenseStore } from "../../src/client/hooks/useLicense.svelte";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { aiOffCopy } from "../../src/client/utils/license-ui";

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
    readOnly: false,
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

/**
 * #1521: while the licence refuses the AI, the tab stays reachable and says
 * why in one line, with the kind's own copy; absent when the AI is not refused.
 */
describe("SettingsClaudeCodeTab — AI-off hint (#1521)", () => {
  afterEach(() => {
    licenseStore.set({ gateActive: false, status: "licensed", updateWindowCurrent: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["unlicensed", {}],
    ["unverifiable", { licenseUnverifiable: "BAD_SIGNATURE" as const }],
  ] as const)("renders the %s copy", (kind, extra) => {
    mockIntegrations([{ kind: "claude-code" }]);
    licenseStore.set({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
      ...extra,
    });
    const { container, unmount } = render(SettingsClaudeCodeTab, { props: makeProps() });
    const hint = byTestId(container, "claude-code-ai-off-hint");
    expect(hint).toBeTruthy();
    expect(hint?.textContent?.trim()).toBe(aiOffCopy(kind).sentence);
    unmount();
  });

  it("is absent when the AI is not refused", () => {
    mockIntegrations([{ kind: "claude-code" }]);
    licenseStore.set({ gateActive: true, status: "trial", updateWindowCurrent: false });
    const { container, unmount } = render(SettingsClaudeCodeTab, { props: makeProps() });
    expect(byTestId(container, "claude-code-ai-off-hint")).toBeNull();
    unmount();
  });
});

/**
 * #1822 item 4a: the launcher home-confines the saved workingDirectory and
 * falls back to home when it cannot use it. The tab used to keep showing the
 * saved folder as the working directory with no hint.
 *
 * The warning is keyed on the saved value, not on a bare flag: the held
 * version read "the last spawn ignored it" and brought the warning back on a
 * remount after a valid folder had been saved.
 */
describe("SettingsClaudeCodeTab — saved working directory not honoured (#1822)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const OUTSIDE = "D:\\code";

  function routeFetch(opts: { saved: string | null; status: Record<string, unknown> }) {
    let saved = opts.saved;
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/api/launcher/status")) {
        return { ok: true, json: async () => opts.status };
      }
      if (url.includes("/api/launcher/working-directory") && init?.method === "POST") {
        const requested = (JSON.parse(init.body ?? "{}") as { workingDirectory?: string | null })
          .workingDirectory;
        saved = requested ?? null;
        return { ok: true, json: async () => ({ ok: true, workingDirectory: saved }) };
      }
      return {
        ok: true,
        json: async () => ({
          integrations: [
            { kind: "claude-code", ...(saved !== null ? { workingDirectory: saved } : {}) },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const statusCalled = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.some(([u]) => String(u).includes("/api/launcher/status"));

  /** An absence is only evidence once the status body has been read AND
   * applied: the call being made is not enough (one `tick()` after it left the
   * stale-verdict case green with the comparison deleted). Drain the
   * fetch → json → state chain with macrotask turns, then let Svelte flush. */
  async function settle(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    await waitFor(() => expect(statusCalled(fetchMock)).toBe(true));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  it.each([
    ["outside-home", "is not inside your home directory"],
    ["unresolvable", "may have been moved or deleted"],
  ] as const)(
    "warns with the %s copy when the last launch refused the saved folder",
    async (reason, phrase) => {
      routeFetch({
        saved: OUTSIDE,
        status: {
          available: true,
          running: true,
          workingDirectoryIgnored: { reason, workingDirectory: OUTSIDE },
        },
      });
      const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
      await waitFor(() => {
        expect(byTestId(container, "settings-modal-working-directory-ignored")).toBeTruthy();
      });
      const text =
        byTestId(container, "settings-modal-working-directory-ignored")?.textContent ?? "";
      expect(text).toContain(phrase);
      // Fixed string: the path never reaches the banner.
      expect(text).not.toContain(OUTSIDE);
    },
  );

  it("stays silent when the saved folder was honoured", async () => {
    const fetchMock = routeFetch({
      saved: "/home/me/project",
      status: { available: true, running: true },
    });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
    await settle(fetchMock);
    expect(byTestId(container, "settings-modal-working-directory-ignored")).toBeNull();
  });

  it("stays silent on a remount after a valid folder was saved (the stale verdict)", async () => {
    // The last spawn refused OUTSIDE; the user has since saved a valid folder,
    // and no spawn has run since, so the status still carries the old verdict.
    const fetchMock = routeFetch({
      saved: "/home/me/project",
      status: {
        available: true,
        running: true,
        workingDirectoryIgnored: { reason: "outside-home", workingDirectory: OUTSIDE },
      },
    });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
    await settle(fetchMock);
    expect(byTestId(container, "settings-modal-working-directory-ignored")).toBeNull();
  });

  it("ignores a malformed field (an older or foreign server)", async () => {
    const fetchMock = routeFetch({
      saved: OUTSIDE,
      status: { available: true, running: true, workingDirectoryIgnored: true },
    });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });
    await settle(fetchMock);
    expect(byTestId(container, "settings-modal-working-directory-ignored")).toBeNull();
  });

  it.each([
    ["saving a folder the route accepted", "save"],
    ["resetting to default", "reset"],
  ] as const)("clears the warning after %s", async (_label, action) => {
    routeFetch({
      saved: OUTSIDE,
      status: {
        available: true,
        running: true,
        workingDirectoryIgnored: { reason: "outside-home", workingDirectory: OUTSIDE },
      },
    });
    const props = makeProps();
    const { container } = render(SettingsClaudeCodeTab, { props });
    await waitFor(() => {
      expect(byTestId(container, "settings-modal-working-directory-ignored")).toBeTruthy();
    });
    if (action === "save") {
      const input = byTestId(
        container,
        "settings-modal-working-directory-input",
      ) as HTMLInputElement;
      input.value = "/home/me/project";
      input.closest("form")?.requestSubmit();
    } else {
      byTestId(container, "settings-modal-working-directory-reset")?.click();
    }
    await waitFor(() => {
      expect(props.notify).toHaveBeenCalledWith("info", "Working directory saved.");
    });
    await tick();
    expect(byTestId(container, "settings-modal-working-directory-ignored")).toBeNull();
  });
});
