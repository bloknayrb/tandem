// @vitest-environment happy-dom

/**
 * The Settings → AI Assistant tab actually reaching CoworkSettings (#1375).
 *
 * `tests/client/SettingsClaudeCodeTab.test.ts` mounts this parent already, but
 * under happy-dom `isTauriRuntime()` is false, so the lazy
 * `{#await import("../CoworkSettings.svelte")}` branch never ran and the whole
 * Cowork surface was one un-taken `{#if}` away from every test in the repo.
 * The sibling mount suites cover the child in isolation; this file covers the
 * seam — that the desktop build renders it here at all, and that the browser
 * build still does not.
 *
 * Separate from `SettingsClaudeCodeTab.test.ts` on purpose: `isTauriRuntime` is
 * mocked at module scope, which that file's #1022 assertions must not inherit.
 */

import { render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";

let tauri = true;

vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => tauri };
});

// CoworkSettings calls `createCoworkStatus(() => true)` at mount, which holds an
// `$effect` and a real invoke — unmocked, arriving here hits the network.
vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: {
      osSupported: true,
      coworkDetected: true,
      enabled: false,
      vethernetCidr: null,
      lanIpFallback: null,
      useLanIpOverride: false,
      workspaces: [],
      uacDeclined: false,
      uacDeclinedAt: null,
    },
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

vi.mock("../../src/client/cowork/cowork-invoke", () => ({
  TAURI_NOT_AVAILABLE: "Tauri runtime not available",
  loadInvoke: vi.fn(async () => vi.fn()),
  coworkToggleIntegration: vi.fn(async () => ({ ok: true })),
  coworkPreflightSubnet: vi.fn(async () => ({ status: "unknown" })),
  coworkRescan: vi.fn(async () => {}),
  coworkSetLanIpOverride: vi.fn(async () => {}),
}));

import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";

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

describe("SettingsClaudeCodeTab — Cowork section (#1375)", () => {
  afterEach(() => {
    tauri = true;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders CoworkSettings in the desktop app", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ integrations: [] }) }),
    );
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    // `waitFor`, not ticks: the branch is a dynamic `import()`, so the child
    // arrives a module-load later than any number of Svelte flushes.
    await waitFor(() => {
      expect(byTestId(container, "cowork-settings")).toBeTruthy();
    });
    expect(byTestId(container, "cowork-toggle-checkbox")).toBeTruthy();
  });

  it("renders nothing Cowork-shaped in the browser build", async () => {
    // The negative half matters as much: Cowork's enable path is Windows- and
    // Tauri-only, and `tests/e2e/integration-wizard.spec.ts` asserts count 0 in
    // a real browser. This pins the gate that makes that true.
    tauri = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ integrations: [] }) }),
    );
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-open-integration-wizard")).toBeTruthy();
    });
    expect(byTestId(container, "cowork-settings")).toBeNull();
    expect(byTestId(container, "settings-modal-cowork-suspense-fallback")).toBeNull();
  });
});
