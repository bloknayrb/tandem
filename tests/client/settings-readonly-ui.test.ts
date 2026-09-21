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

// NetworkSettings, SettingsClaudeCodeTab, and SettingsModal each fetch
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
  /**
   * #1964: `role="radio"` controls only. The native-`disabled` contract every
   * other control in this file asserts is deliberately RELAXED for them —
   * native `disabled` drops focus to the nearest focusable ancestor, which
   * blurs the roving-tabindex radio the user is standing on, so the radios
   * carry `aria-disabled` plus a guarded `onclick` instead (precedent:
   * `FileOpenDialog.svelte:55-62`). The read-only arm therefore asserts
   * `aria-disabled="true"` AND the absence of the native attribute — without
   * the second half an implementation that adds `aria-disabled` while keeping
   * `disabled={readOnly}` passes and leaves the focus half unfixed.
   */
  ariaDisabled?: true;
};

const CASES: ControlCase[] = [
  {
    name: "AppearanceSettings theme radio",
    component: AppearanceSettings,
    testid: "theme-dark-btn",
    ariaDisabled: true,
  },
  {
    name: "AppearanceSettings density radio",
    component: AppearanceSettings,
    testid: "density-compact-btn",
    ariaDisabled: true,
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
    name: "AppearanceSettings uniform-tab-width checkbox",
    component: AppearanceSettings,
    testid: "appearance-uniform-tab-width",
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
    ariaDisabled: true,
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
    name: "EditorSettings source-view line-wrap checkbox",
    component: EditorSettings,
    testid: "editor-source-line-wrap",
    innerInput: true,
  },
  {
    name: "AccessibilitySettings high-contrast checkbox",
    component: AccessibilitySettings,
    testid: "high-contrast-toggle",
    innerInput: true,
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
      if (c.ariaDisabled) {
        expect(control.getAttribute("aria-disabled")).toBe("true");
        expect(control.hasAttribute("disabled")).toBe(false);
      } else {
        expect(control.disabled).toBe(true);
      }
      control.click();
      expect(ctx.onUpdate).not.toHaveBeenCalled();
    });

    it(`${c.name}: enabled when not readOnly`, () => {
      const ctx = makeCtx(false);
      const { container } = render(c.component, { props: ctx });
      const control = resolveControl(container, c) as HTMLInputElement | HTMLButtonElement;
      if (c.ariaDisabled) {
        // Phrased negatively so it does not depend on Svelte stringifying
        // `false` into the attribute at all.
        expect(control.getAttribute("aria-disabled")).not.toBe("true");
      } else {
        expect(control.disabled).toBe(false);
      }
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

/**
 * #1722 / #1792 item 1 — the OTHER half. The banner above covers only the
 * Settings modal; every settings-backed control outside it (theme picker, rail
 * toggles, formatting-bar hide, decoration toggles) goes through
 * `updateSettings` and had no surface at all.
 *
 * A SOURCE-CONTRACT assertion rather than an App.svelte mount test:
 * `settings-write-refused.test.ts` registers its own handler, so without this
 * a fix that exports the setter and never wires it passes everything while the
 * user still gets the silent no-op both issues describe.
 */
describe("App.svelte — settings write-refused wiring (#1722/#1792)", () => {
  it("registers a settings-write-refused handler", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, "../../src/client/App.svelte"), "utf-8");

    expect(source).toContain("setSettingsWriteRefusedHandler");
    // …and it must actually CALL it, not merely import the symbol.
    expect(source).toMatch(/setSettingsWriteRefusedHandler\s*\(/);
    // The refusal reaches the user once per condition, not once per click.
    expect(source).toContain('dedupKey: "settings-readonly"');
    // The id must come from the project helper: `crypto.randomUUID` is
    // secure-context-only, so over plain http to a LAN IP the handler would
    // throw before the toast — the silent no-op again, on the Cowork surface.
    const start = source.indexOf("setSettingsWriteRefusedHandler(");
    const block = source.slice(start, source.indexOf("});", start));
    expect(block).toMatch(/\bid:\s*generateNotificationId\(\)/);
  });
});

/**
 * #1964 — the hook half. Every `createRadioGroup` call site must pass
 * `() => readOnly` as its 4th argument, so the roving-tabindex/arrow-key path
 * the hook owns cannot reach the refused `updateSettings` write once the
 * radios are focusable again (they are: `aria-disabled` replaced native
 * `disabled`).
 *
 * MECHANISM PIN, not a user scenario. `settings._readOnly` cannot actually
 * flip mid-session — `createTandemSettings` is a singleton and `_readOnly` is
 * fixed at construction — but only a live flip discriminates a getter
 * (`() => readOnly`) from an init-time ternary (`readOnly ? () => true :
 * undefined`), which is the specific wrong implementation.
 *
 * The assertions iterate `[role="radiogroup"]` rather than naming groups: a
 * named spec would leave `primaryTabRg`, `textSizeRg`, `editorFontRg` and the
 * `fontByExtensionRgs` factory shippable with the defect and every test green,
 * and iteration fails closed when a group is added.
 */
describe("settings radiogroups — keyboard path honours readOnly (#1964)", () => {
  const RADIO_GROUP_HOSTS = [
    { name: "AppearanceSettings", component: AppearanceSettings },
    { name: "EditorSettings", component: EditorSettings },
  ] as const;

  function groupsOf(container: HTMLElement): HTMLElement[] {
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[role="radiogroup"]'));
    expect(groups.length, "no radiogroups rendered").toBeGreaterThan(0);
    return groups;
  }

  const arrowRight = () =>
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });

  for (const host of RADIO_GROUP_HOSTS) {
    it(`${host.name}: after a flip to readOnly, every group is inert to ArrowRight`, async () => {
      const ctx = makeCtx(false);
      const { container, rerender } = render(host.component, { props: ctx });
      await rerender({ ...ctx, readOnly: true });
      await tick();

      for (const group of groupsOf(container)) {
        const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
        expect(radios.length, "radiogroup with no radios").toBeGreaterThan(0);
        for (const radio of radios) {
          expect(radio.getAttribute("tabindex")).toBe("-1");
          expect(radio.getAttribute("aria-disabled")).toBe("true");
        }
        group.dispatchEvent(arrowRight());
      }
      expect(ctx.onUpdate).not.toHaveBeenCalled();
    });

    it(`${host.name}: the same ArrowRight DOES write when not readOnly`, async () => {
      const ctx = makeCtx(false);
      const { container } = render(host.component, { props: ctx });
      await tick();

      for (const group of groupsOf(container)) {
        group.dispatchEvent(arrowRight());
      }
      expect(ctx.onUpdate).toHaveBeenCalled();
    });
  }
});
