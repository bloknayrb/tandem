// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";

// resizeComposer() (ChatPanel.svelte) derives its cap from getComputedStyle().
// happy-dom doesn't resolve the real `var(--tandem-ui-leading)` design token
// (no stylesheet cascade for CSS custom properties), so these tests pin
// synthetic-but-representative values for the handful of properties the
// function actually reads, then drive `scrollHeight` — which happy-dom always
// reports as 0 — through a per-test controllable getter, matching the
// established pattern in `scroll-fade.test.ts` for testing layout-dependent
// code under a DOM without real layout.
const LINE_HEIGHT = 20;
const PADDING = 16; // paddingTop + paddingBottom
const BORDER = 2; // borderTopWidth + borderBottomWidth
const COMPOSER_MAX_LINES = 8; // must track the const in ChatPanel.svelte

function seedDoc(): Y.Doc {
  return new Y.Doc();
}

function renderChat(ctrlYdoc: Y.Doc) {
  return render(ChatPanel, {
    props: {
      ctrlYdoc,
      editor: null,
      activeDocId: null,
      openDocs: [],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
    },
  });
}

/** scrollHeight for a textarea holding `lines` wrapped lines of text. */
function scrollHeightForLines(lines: number): number {
  return lines * LINE_HEIGHT + PADDING;
}

describe("ChatPanel composer auto-grow (#1247)", () => {
  let originalGetComputedStyle: typeof window.getComputedStyle;
  let simulatedLines = 1;

  beforeEach(() => {
    simulatedLines = 1;
    originalGetComputedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, ...rest) => {
      const target = el as HTMLElement;
      if (target.dataset?.testid !== "chat-composer-input") {
        return originalGetComputedStyle.call(window, target, ...rest);
      }
      return {
        lineHeight: `${LINE_HEIGHT}px`,
        fontSize: "13px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
        paddingTop: "8px",
        paddingBottom: "8px",
      } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getComposer(container: HTMLElement): HTMLTextAreaElement {
    const el = container.querySelector<HTMLTextAreaElement>("[data-testid='chat-composer-input']");
    if (!el) throw new Error("composer textarea not found");
    // resizeComposer() early-returns when clientWidth is 0 (its guard for a
    // display:none PanelSlot); happy-dom reports 0 for everything, so pin a
    // nonzero value like a visible panel would report.
    Object.defineProperty(el, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(el, "scrollHeight", {
      get: () => scrollHeightForLines(simulatedLines),
      configurable: true,
    });
    return el;
  }

  it("stays at the one-line height and hidden overflow for a single-line draft", async () => {
    const { container } = renderChat(seedDoc());
    const el = getComposer(container);
    simulatedLines = 1;
    await fireEvent.input(el, { target: { value: "hello" } });

    const needed = scrollHeightForLines(1) + BORDER;
    expect(el.style.height).toBe(`${needed}px`);
    expect(el.style.overflowY).toBe("hidden");
    expect(el.dataset.multiline).toBe("false");
  });

  it("grows and marks multiline for a draft past one line, below the cap", async () => {
    const { container } = renderChat(seedDoc());
    const el = getComposer(container);
    simulatedLines = 4;
    await fireEvent.input(el, { target: { value: "line1\nline2\nline3\nline4" } });

    const needed = scrollHeightForLines(4) + BORDER;
    const maxHeight = Math.ceil(LINE_HEIGHT * COMPOSER_MAX_LINES) + PADDING + BORDER;
    expect(needed).toBeLessThan(maxHeight);
    expect(el.style.height).toBe(`${needed}px`);
    expect(el.style.overflowY).toBe("hidden");
    expect(el.dataset.multiline).toBe("true");
  });

  it("caps at COMPOSER_MAX_LINES exactly, still no scrollbar", async () => {
    const { container } = renderChat(seedDoc());
    const el = getComposer(container);
    simulatedLines = COMPOSER_MAX_LINES;
    await fireEvent.input(el, { target: { value: "x".repeat(8 * 40) } });

    const maxHeight = Math.ceil(LINE_HEIGHT * COMPOSER_MAX_LINES) + PADDING + BORDER;
    expect(el.style.height).toBe(`${maxHeight}px`);
    expect(el.style.overflowY).toBe("hidden");
  });

  it("caps the height and switches to a scrollbar past COMPOSER_MAX_LINES", async () => {
    const { container } = renderChat(seedDoc());
    const el = getComposer(container);
    simulatedLines = COMPOSER_MAX_LINES + 3;
    await fireEvent.input(el, { target: { value: "x".repeat(11 * 40) } });

    const maxHeight = Math.ceil(LINE_HEIGHT * COMPOSER_MAX_LINES) + PADDING + BORDER;
    expect(el.style.height).toBe(`${maxHeight}px`);
    expect(el.style.overflowY).toBe("auto");
    expect(el.dataset.multiline).toBe("true");
  });

  it("shrinks back to the one-line height after the draft is cleared (e.g. on send)", async () => {
    const { container } = renderChat(seedDoc());
    const el = getComposer(container);
    simulatedLines = 5;
    await fireEvent.input(el, { target: { value: "a\nb\nc\nd\ne" } });
    expect(el.dataset.multiline).toBe("true");

    simulatedLines = 1;
    await fireEvent.input(el, { target: { value: "" } });

    const needed = scrollHeightForLines(1) + BORDER;
    expect(el.style.height).toBe(`${needed}px`);
    expect(el.style.overflowY).toBe("hidden");
    expect(el.dataset.multiline).toBe("false");
  });

  it("the width-gated ResizeObserver ignores its own first delivery when nothing actually resized", async () => {
    // Regression test for the box-model mismatch: the observer used to seed
    // `lastWidth` from `clientWidth` (padding-box) and compare against
    // `contentRect.width` (content-box), so the very first delivery always
    // looked like a resize even with an unchanged width. Assert the composer's
    // height is untouched by a same-width delivery once it has already been
    // sized for the current content.
    let roCallback: ResizeObserverCallback | undefined;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    const originalRO = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = renderChat(seedDoc());
    const el = getComposer(container);
    simulatedLines = 3;
    await fireEvent.input(el, { target: { value: "a\nb\nc" } });
    const heightAfterInput = el.style.height;

    // Content-box width, matching what a real ResizeObserver would deliver.
    const contentBoxWidth = el.clientWidth - BORDER - PADDING;
    roCallback?.(
      [{ contentRect: { width: contentBoxWidth } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );

    expect(el.style.height).toBe(heightAfterInput);
    vi.stubGlobal("ResizeObserver", originalRO);
  });
});
