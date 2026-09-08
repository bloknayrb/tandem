// @vitest-environment happy-dom

/**
 * #1778 item 1 — four `aria-modal="true"` dialogs had no Tab trap.
 *
 * `aria-modal="true"` tells assistive tech that everything outside is inert
 * while real focus walks the titlebar, the tabs and the annotation rail. This
 * suite pins the WRAP TARGET rather than mere containment: a bare
 * `if (e.key === "Tab") e.preventDefault()` that never moves focus satisfies
 * "defaultPrevented and still inside the container", which is why every case
 * asserts which element focus landed on.
 *
 * Every synthetic Tab carries `cancelable: true` — without it `preventDefault()`
 * is a no-op and every `defaultPrevented` assertion passes vacuously
 * (`tests/client/focus-trap.test.ts` is the in-repo precedent).
 */

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "../../src/client/components/CommandPalette.svelte";
import FileOpenDialog from "../../src/client/components/FileOpenDialog.svelte";
import FirstRunModelPickerModal from "../../src/client/components/FirstRunModelPickerModal.svelte";
import ModelEditModal from "../../src/client/components/ModelEditModal.svelte";
import SettingsModal from "../../src/client/components/SettingsModal.svelte";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import { focusablesWithin } from "../../src/client/utils/focus-trap";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

vi.mock("../../src/client/cowork/cowork-helpers.js", () => ({
  isTauriRuntime: vi.fn(() => false),
}));
vi.mock("../../src/client/utils/server-paths.js", () => ({ openServerPath: vi.fn() }));
vi.mock("../../src/client/utils/default-directory.js", () => ({
  resolveDefaultDirectory: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../src/client/utils/fileUpload.js", () => ({
  API_BASE: "",
  readFileForUpload: vi.fn(async () => "file-contents"),
}));

beforeEach(() => {
  installLocalStorageStub();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Dispatch a Tab on `window`, where every trap listens. */
function tab(shift = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

function byTestId(root: ParentNode, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no [data-testid='${id}'] rendered`);
  return el;
}

/**
 * The three assertions every trapped dialog owes: forward wrap, backward wrap,
 * and recovery from focus stranded on `<body>` (what a click on the dialog's
 * own padding leaves behind, and the reason the listener is window-level).
 */
function assertTrapped(container: HTMLElement) {
  const focusables = focusablesWithin(container);
  // One is legitimate: the palette is a combobox whose results are
  // `role="option"` list items, so its input is the only tab stop. The wrap
  // then targets that same element, and the recovery case below is what still
  // discriminates against a preventDefault-only stub (which would leave focus
  // on `<body>`). The other three dialogs carry several.
  expect(focusables.length).toBeGreaterThan(0);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  last.focus();
  const forward = tab();
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);

  first.focus();
  const backward = tab(true);
  expect(backward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(last);

  document.body.focus();
  const recover = tab();
  expect(recover.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);
}

describe("CommandPalette traps Tab (#1778)", () => {
  it("wraps forward, backward, and recovers stranded focus", () => {
    const { container } = render(CommandPalette, { props: { open: true, onClose: vi.fn() } });
    assertTrapped(byTestId(container, "command-palette"));
  });
});

describe("FileOpenDialog traps Tab (#1778)", () => {
  it("wraps forward, backward, and recovers stranded focus", () => {
    const { container } = render(FileOpenDialog, { props: { onClose: vi.fn() } });
    // The trap container is the outer `role="dialog"` scrim; every focusable
    // lives inside the inner `file-open-dialog` card.
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    assertTrapped(dialog as HTMLElement);
  });
});

// Both model modals ship dark (`BYO_MODELS_ENABLED` is a `const false`), so
// E2E structurally cannot reach them. Their trap is byte-identical in shape to
// the two reachable ones, and these unit cases are what cover it at flip time.
describe("ModelEditModal traps Tab (#1778, dark)", () => {
  it("wraps forward, backward, and recovers stranded focus", () => {
    const { container } = render(ModelEditModal, {
      props: { onCancel: vi.fn(), onSave: vi.fn() },
    });
    assertTrapped(byTestId(container, "model-edit-modal"));
  });
});

describe("FirstRunModelPickerModal traps Tab (#1778, dark)", () => {
  it("wraps forward, backward, and recovers stranded focus", () => {
    const { container } = render(FirstRunModelPickerModal, { props: { onComplete: vi.fn() } });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    assertTrapped(dialog as HTMLElement);
  });
});

/**
 * Two stacked traps, one case per owner bail.
 *
 * `trapTab`'s recover branch fires whenever focus is outside ITS container —
 * including inside another open dialog — with no `defaultPrevented` check, so
 * two live traps ping-pong within one keydown. Both components are real: a
 * synthetic `<div aria-modal="true">` would never exercise SettingsModal's own
 * listener, which is the half that was broken.
 */
describe("stacked dialogs — each owner bail (#1778)", () => {
  function renderStack() {
    const settings = render(SettingsModal, {
      props: {
        open: true,
        onClose: vi.fn(),
        settings: loadSettings(),
        onUpdate: vi.fn(),
        connected: true,
        reconnectAttempts: 0,
      },
    });
    const palette = render(CommandPalette, { props: { open: true, onClose: vi.fn() } });
    return {
      settingsEl: byTestId(settings.container, "settings-modal"),
      paletteEl: byTestId(palette.container, "command-palette"),
    };
  }

  it("(a) focus inside the palette stays there — pins SettingsModal's bail", () => {
    const { settingsEl, paletteEl } = renderStack();
    focusablesWithin(paletteEl)[0].focus();
    expect(paletteEl.contains(document.activeElement)).toBe(true);

    tab();

    // Revert SettingsModal's bail and its handler takes trapTab's recover
    // branch — focus is outside `modalEl` — and yanks focus into Settings.
    expect(paletteEl.contains(document.activeElement)).toBe(true);
    expect(settingsEl.contains(document.activeElement)).toBe(false);
  });

  it("(b) focus inside Settings stays there — pins CommandPalette's bail", () => {
    const { settingsEl, paletteEl } = renderStack();
    focusablesWithin(settingsEl)[0].focus();
    expect(settingsEl.contains(document.activeElement)).toBe(true);

    tab();

    // Revert the palette's bail and its handler takes the same recover branch,
    // pulling focus into the palette's first focusable.
    expect(settingsEl.contains(document.activeElement)).toBe(true);
    expect(paletteEl.contains(document.activeElement)).toBe(false);
  });
});
