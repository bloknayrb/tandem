// @vitest-environment happy-dom

/**
 * SettingsModal Escape ownership.
 *
 * Escape closes Settings wherever focus is — the old rule acted only when the
 * event target was inside the dialog, so every path that stranded focus on
 * `<body>` (working-directory Save disabling itself mid-POST is the one that
 * was reported) left Escape doing nothing. The exceptions are pinned here too:
 * a layer above Settings (any other `aria-modal="true"` dialog) keeps the key
 * and the event, and an IME composition is not a dismissal. The narrow-drawer
 * exception needs a real 860px media query and is pinned in
 * `tests/e2e/settings-modal.spec.ts` with the rest of the browser paths.
 */

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModal from "../../src/client/components/SettingsModal.svelte";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

function renderModal() {
  const onClose = vi.fn();
  const view = render(SettingsModal, {
    props: {
      open: true,
      onClose,
      settings: loadSettings(),
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
    },
  });
  return { ...view, onClose };
}

/** Dispatch Escape at `target` and report whether it reached `window`. */
function pressEscape(target: EventTarget, init: KeyboardEventInit = {}): boolean {
  let reachedWindow = false;
  const spy = () => {
    reachedWindow = true;
  };
  window.addEventListener("keydown", spy);
  try {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }));
  } finally {
    window.removeEventListener("keydown", spy);
  }
  return reachedWindow;
}

// The modal fetches app info on open; a never-resolving stub keeps that off
// the network (same approach as settings-modal-focus.test.ts).
beforeEach(() => {
  installLocalStorageStub();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const el of document.querySelectorAll("[data-test-layer]")) el.remove();
});

describe("SettingsModal Escape", () => {
  it("closes when focus is inside the dialog, and keeps the key from window handlers", () => {
    const { container, onClose } = renderModal();
    const navBtn = container.querySelector<HTMLElement>(
      "[data-testid='settings-modal-tab-editor']",
    );
    expect(navBtn).toBeTruthy();
    navBtn?.focus();

    expect(pressEscape(navBtn as HTMLElement)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when focus has been stranded on <body>", () => {
    const { onClose } = renderModal();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    expect(pressEscape(document.body)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stands down, without stopping the event, while another modal dialog is layered over it", () => {
    const { onClose } = renderModal();
    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("data-test-layer", "");
    const inner = document.createElement("button");
    layer.append(inner);
    document.body.append(layer);

    // From inside the layer, and from <body> while the layer is up: in both
    // the layer owns Escape (its own handler may be at `window`, so the event
    // must still get there).
    expect(pressEscape(inner)).toBe(true);
    expect(pressEscape(document.body)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores an aria-modal=false surface", () => {
    const { onClose } = renderModal();
    const bar = document.createElement("div");
    bar.setAttribute("aria-modal", "false");
    bar.setAttribute("data-test-layer", "");
    document.body.append(bar);

    pressEscape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close while an IME composition is in progress", () => {
    const { onClose } = renderModal();
    expect(pressEscape(document.body, { isComposing: true })).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
