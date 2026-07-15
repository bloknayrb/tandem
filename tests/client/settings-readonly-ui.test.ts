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
import { afterEach, describe, expect, it, vi } from "vitest";
import AccessibilitySettings from "../../src/client/components/AccessibilitySettings.svelte";
import AppearanceSettings from "../../src/client/components/AppearanceSettings.svelte";
import EditorSettings from "../../src/client/components/EditorSettings.svelte";
import SettingsModal from "../../src/client/components/SettingsModal.svelte";
import ShortcutEditorList from "../../src/client/components/ShortcutEditorList.svelte";
import SettingsCollaborationTab from "../../src/client/components/settings-tabs/SettingsCollaborationTab.svelte";
import { loadSettings, type TandemSettings } from "../../src/client/hooks/useTandemSettings";

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

afterEach(() => cleanup());

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
