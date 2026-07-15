// @vitest-environment happy-dom

/**
 * Forward-compat read-only settings UI (settings._readOnly, schemaVersion
 * newer than this build). The hook's silent no-op in `updateSettings` is the
 * load-bearing guard; these tests pin the AFFORDANCE layer added on top:
 * one-way-bound controls must be `disabled` (so a checkbox can't flip
 * visually and go stale against a value that never persisted) and the
 * surface-wide `settings-readonly-banner` must appear.
 *
 * Per component: representative write controls disabled + onUpdate never
 * called on click when readOnly, enabled when not. Follows
 * SettingsClaudeCodeTab.test.ts's partial-TandemSettings props pattern.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccessibilitySettings from "../../src/client/components/AccessibilitySettings.svelte";
import AppearanceSettings from "../../src/client/components/AppearanceSettings.svelte";
import EditorSettings from "../../src/client/components/EditorSettings.svelte";
import NetworkSettings from "../../src/client/components/NetworkSettings.svelte";
import SettingsModal from "../../src/client/components/SettingsModal.svelte";
import SettingsPopover from "../../src/client/components/SettingsPopover.svelte";
import ShortcutEditorList from "../../src/client/components/ShortcutEditorList.svelte";
import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";
import SettingsCollaborationTab from "../../src/client/components/settings-tabs/SettingsCollaborationTab.svelte";
import SettingsModelsTab from "../../src/client/components/settings-tabs/SettingsModelsTab.svelte";
import { loadSettings, type TandemSettings } from "../../src/client/hooks/useTandemSettings";
import { _resetTandemSettingsSingletonForTests } from "../../src/client/hooks/useTandemSettings.svelte.js";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

// loadSettings() against empty localStorage yields a complete, valid
// TandemSettings (same approach as useTandemSettings.test.ts) — no
// hand-maintained field list to go stale as the schema grows.
function makeSettings(readOnlyStore: boolean): TandemSettings {
  return { ...loadSettings(), ...(readOnlyStore ? { _readOnly: true as const } : {}) };
}

function makeCtx(readOnly: boolean) {
  return {
    open: true,
    settings: makeSettings(readOnly),
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    readOnly,
    notify: vi.fn(),
  };
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

// NetworkSettings, SettingsClaudeCodeTab, and SettingsPopover each fetch
// app-info / integration state on mount (`open: true`). A never-resolving
// stub keeps every case in this file from making a real network call
// without needing per-suite fetch wiring — none of these tests assert on
// that fetched data, only on the readOnly-gated controls.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type ControlCase = {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: component constructors differ
  component: any;
  testid: string;
  /** True when the testid marks a label wrapper — descend to its `<input>`. */
  innerInput?: boolean;
};

const CASES: ControlCase[] = [
  {
    name: "AppearanceSettings theme radio",
    component: AppearanceSettings,
    testid: "theme-dark-btn",
  },
  {
    name: "AppearanceSettings density radio",
    component: AppearanceSettings,
    testid: "density-compact-btn",
  },
  {
    name: "AppearanceSettings decoration checkbox",
    component: AppearanceSettings,
    testid: "appearance-show-comments",
    innerInput: true,
  },
  {
    name: "AppearanceSettings formatting-bar checkbox",
    component: AppearanceSettings,
    testid: "appearance-formatting-bar",
    innerInput: true,
  },
  {
    name: "AppearanceSettings hue slider",
    component: AppearanceSettings,
    testid: "accent-hue-slider",
  },
  {
    name: "EditorSettings measure radio",
    component: EditorSettings,
    testid: "editor-measure-wide",
  },
  {
    name: "EditorSettings smart-typography checkbox",
    component: EditorSettings,
    testid: "editor-smart-typography",
    innerInput: true,
  },
  {
    name: "EditorSettings spellcheck checkbox",
    component: EditorSettings,
    testid: "editor-spellcheck-toggle",
    innerInput: true,
  },
  {
    name: "AccessibilitySettings high-contrast checkbox",
    component: AccessibilitySettings,
    testid: "high-contrast-toggle",
    innerInput: true,
  },
  {
    name: "SettingsCollaborationTab default-mode radio",
    component: SettingsCollaborationTab,
    testid: "settings-modal-default-mode-solo-btn",
  },
  {
    name: "SettingsCollaborationTab solo-rail checkbox",
    component: SettingsCollaborationTab,
    testid: "settings-modal-solo-rail-hidden-toggle",
    innerInput: true,
  },
  {
    name: "NetworkSettings degraded-delay slider",
    component: NetworkSettings,
    testid: "network-degraded-delay-slider",
  },
  {
    name: "NetworkSettings retry-strategy select",
    component: NetworkSettings,
    testid: "network-retry-strategy",
  },
  {
    name: "SettingsClaudeCodeTab dwell-time slider",
    component: SettingsClaudeCodeTab,
    testid: "settings-modal-dwell-time-slider",
  },
  {
    name: "SettingsClaudeCodeTab selection-toolbar checkbox",
    component: SettingsClaudeCodeTab,
    testid: "settings-modal-selection-toolbar-toggle",
    innerInput: true,
  },
];

function resolveControl(container: HTMLElement, c: ControlCase): HTMLElement {
  const el = byTestId(container, c.testid);
  expect(el, `${c.testid} not found`).toBeTruthy();
  if (c.innerInput) {
    const input = (el as HTMLElement).querySelector<HTMLInputElement>("input");
    expect(input, `${c.testid} inner input not found`).toBeTruthy();
    return input as HTMLElement;
  }
  return el as HTMLElement;
}

describe("settings read-only UI — controls disabled and writes blocked", () => {
  for (const c of CASES) {
    it(`${c.name}: disabled + no onUpdate when readOnly`, () => {
      const ctx = makeCtx(true);
      const { container } = render(c.component, { props: ctx });
      const control = resolveControl(container, c) as HTMLInputElement | HTMLButtonElement;
      expect(control.disabled).toBe(true);
      control.click();
      expect(ctx.onUpdate).not.toHaveBeenCalled();
    });

    it(`${c.name}: enabled when not readOnly`, () => {
      const ctx = makeCtx(false);
      const { container } = render(c.component, { props: ctx });
      const control = resolveControl(container, c) as HTMLInputElement | HTMLButtonElement;
      expect(control.disabled).toBe(false);
    });
  }
});

describe("settings-readonly-banner (modal-level)", () => {
  function renderModal(readOnlyStore: boolean) {
    return render(SettingsModal, {
      props: {
        open: true,
        onClose: vi.fn(),
        settings: makeSettings(readOnlyStore),
        onUpdate: vi.fn(),
        connected: true,
        reconnectAttempts: 0,
      },
    });
  }

  it("present iff settings._readOnly === true", () => {
    const { container } = renderModal(true);
    expect(byTestId(container, "settings-readonly-banner")).toBeTruthy();
    cleanup();
    const { container: rw } = renderModal(false);
    expect(byTestId(rw, "settings-readonly-banner")).toBeNull();
  });

  it("shortcuts tab shows only the surface-wide banner (ShortcutEditorList's old inline notice is gone)", async () => {
    const { container } = renderModal(true);
    // Navigate to the shortcuts tab.
    const tabBtn = byTestId(container, "settings-modal-tab-shortcuts");
    expect(tabBtn).toBeTruthy();
    tabBtn?.click();
    await Promise.resolve();
    expect(byTestId(container, "settings-modal-shortcuts-list")).toBeTruthy();
    // ShortcutEditorList no longer owns a banner — both settings surfaces
    // render the surface-wide one, so no double-banner anywhere.
    expect(byTestId(container, "store-readonly-banner")).toBeNull();
    expect(byTestId(container, "settings-readonly-banner")).toBeTruthy();
  });
});

describe("ShortcutEditorList under read-only", () => {
  it("disables its controls without rendering its own banner (hosts own the banner)", () => {
    const { container } = render(ShortcutEditorList, {
      props: {
        settings: makeSettings(true),
        onUpdate: vi.fn(),
      },
    });
    expect(byTestId(container, "store-readonly-banner")).toBeNull();
    expect((byTestId(container, "shortcuts-reset-all") as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
  });
});

// SettingsPopover derives `readOnly` itself (not threaded via
// SettingsTabContext — the popover predates the tabbed modal), so it needs
// its own settings._readOnly-driven coverage rather than a makeCtx() case.
describe("SettingsPopover — readOnly gating", () => {
  function renderPopover(readOnlyStore: boolean) {
    return render(SettingsPopover, {
      props: {
        open: true,
        onClose: vi.fn(),
        settings: makeSettings(readOnlyStore),
        onUpdate: vi.fn(),
      },
    });
  }

  function goToCollaboration(container: HTMLElement) {
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".settings-nav-btn")).find(
      (b) => b.textContent?.includes("Collaboration"),
    );
    expect(btn, "Collaboration nav button not found").toBeTruthy();
    btn?.click();
  }

  it("banner present iff settings._readOnly === true", () => {
    const { container } = renderPopover(true);
    expect(byTestId(container, "settings-readonly-banner")).toBeTruthy();
    cleanup();
    const { container: rw } = renderPopover(false);
    expect(byTestId(rw, "settings-readonly-banner")).toBeNull();
  });

  it("Collaboration section's default-mode button and solo-rail checkbox disabled when readOnly", async () => {
    const { container } = renderPopover(true);
    goToCollaboration(container);
    await tick();
    expect(
      (byTestId(container, "default-mode-tandem-btn") as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    const soloRail = byTestId(container, "solo-rail-hidden-toggle");
    expect(soloRail?.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
  });

  it("Collaboration section's controls enabled when not readOnly", async () => {
    const { container } = renderPopover(false);
    goToCollaboration(container);
    await tick();
    expect(
      (byTestId(container, "default-mode-tandem-btn") as HTMLButtonElement | null)?.disabled,
    ).toBe(false);
    const soloRail = byTestId(container, "solo-rail-hidden-toggle");
    expect(soloRail?.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
  });
});

// SettingsModelsTab hangs its Models registry off the module-level
// `createTandemSettings()` singleton rather than the SettingsTabContext
// `settings`/`onUpdate` props (see the component's own doc comment), so it
// needs the singleton reset + a real localStorage backing rather than
// makeSettings()/makeCtx() — those build a standalone TandemSettings object
// the singleton never sees.
describe("SettingsModelsTab — readOnly gating", () => {
  beforeEach(() => {
    installLocalStorageStub();
    _resetTandemSettingsSingletonForTests();
  });

  afterEach(() => {
    _resetTandemSettingsSingletonForTests();
  });

  it("empty-state add-model button disabled when readOnly", () => {
    const { container } = render(SettingsModelsTab, { props: makeCtx(true) });
    expect(byTestId(container, "models-empty-state")).toBeTruthy();
    expect((byTestId(container, "model-add-btn") as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it("empty-state add-model button enabled when not readOnly", () => {
    const { container } = render(SettingsModelsTab, { props: makeCtx(false) });
    expect((byTestId(container, "model-add-btn") as HTMLButtonElement | null)?.disabled).toBe(
      false,
    );
  });
});
