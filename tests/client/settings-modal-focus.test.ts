// @vitest-environment happy-dom

/**
 * SettingsModal focus ownership (#1258).
 *
 * The dialog recovers focus that one of its own restyles dropped on `<body>`
 * (inert drawer, `display:none` hamburger, a button that disables itself, a
 * row that removes itself). The recovery is a focus *side-effect* with no
 * visible DOM output, so the only way it stays honest is to pin both halves:
 * it must fire when focus is genuinely stranded, and it must stay completely
 * out of the way otherwise. The second half is the one that regressed —
 * the first cut treated the `tabindex="-1"` dialog container as stranded
 * (it can never appear in a `querySelectorAll` of its own descendants) and so
 * yanked focus off the `aria-modal` element one frame after every open,
 * before a screen reader had announced the dialog.
 */

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModal from "../../src/client/components/SettingsModal.svelte";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

// One rAF plus a macrotask: the recovery is scheduled on an animation frame,
// so "no drift" has to be measured after that frame has actually run.
function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function renderModal() {
  return render(SettingsModal, {
    props: {
      open: true,
      onClose: vi.fn(),
      settings: loadSettings(),
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
    },
  });
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

// The modal fetches app info on open; a never-resolving stub keeps that off
// the network without any per-test wiring (same approach as
// settings-readonly-ui.test.ts).
beforeEach(() => {
  installLocalStorageStub();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsModal focus recovery", () => {
  it("leaves focus on the dialog container when it opens, and does not drift a frame later", async () => {
    const { container } = renderModal();
    const modal = byTestId(container, "settings-modal");
    expect(modal).toBeTruthy();

    // Documented open behaviour: the `aria-modal` container takes focus so the
    // dialog title is announced before any control is.
    expect(document.activeElement).toBe(modal);

    await afterNextFrame();
    expect(document.activeElement).toBe(modal);
  });

  it("re-homes focus into the dialog when the focused control becomes unfocusable", async () => {
    const { container } = renderModal();
    const modal = byTestId(container, "settings-modal");
    const navBtn = byTestId(container, "settings-modal-tab-editor") as HTMLButtonElement;
    navBtn.focus();
    expect(document.activeElement).toBe(navBtn);

    // What a disabled-flip (View Changelog / Replay tutorial) does: the control
    // stops being focusable and the UA blurs it to nowhere.
    navBtn.disabled = true;
    navBtn.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));

    await afterNextFrame();
    expect(document.activeElement).not.toBe(document.body);
    expect(modal?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(navBtn);
  });

  it("re-homes focus when the focused control was removed from the DOM", async () => {
    const { container } = renderModal();
    const modal = byTestId(container, "settings-modal");
    const navBtn = byTestId(container, "settings-modal-tab-editor") as HTMLButtonElement;
    navBtn.focus();

    // What a delete-confirm removing its own row (or `{#key activeTab.id}`
    // destroying the tab body) does. Chromium still dispatches the focusout —
    // at the now-detached node, and it does reach `document` — but happy-dom
    // does not model that, so the event is raised at the document directly.
    // The recovery reads `lastFocusedInside`, not `event.target`, so this
    // exercises the same branch: a detached former child is still ours.
    navBtn.remove();
    document.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));

    await afterNextFrame();
    expect(document.activeElement).not.toBe(document.body);
    expect(modal?.contains(document.activeElement)).toBe(true);
  });

  it("does not pull focus back when the focused control is still focusable", async () => {
    const { container } = renderModal();
    const navBtn = byTestId(container, "settings-modal-tab-editor") as HTMLButtonElement;
    navBtn.focus();

    // A focusout with no relatedTarget also happens when the user clicks dead
    // space on the page. Nothing became unfocusable, so nothing is stranded.
    navBtn.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));

    await afterNextFrame();
    expect(document.activeElement).toBe(navBtn);
  });
});
