// @vitest-environment happy-dom

/**
 * #1431 — FindReplaceBar's partial-replace warning.
 *
 * Split from `live-regions.test.ts` only because this component needs the
 * find/replace ProseMirror plugin module stubbed; the property under test and
 * the reason it is written this way are documented there.
 *
 * The warning is the one message in the bar a user can actually be surprised
 * by — "Replaced 40 of 120" after a Replace All they thought had finished — and
 * it arrived on a node created by its own `{#if}`, so it announced to nobody.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stubbed so the bar can reach `handleReplaceAll` without a real editor: the
// match count comes from plugin state, and `replaceAll` is what reports the
// partial outcome that produces the warning.
vi.mock("../../src/client/editor/extensions/find-replace.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFindState: () => ({
    matches: [
      { from: 1, to: 2 },
      { from: 5, to: 6 },
    ],
    activeIndex: 0,
  }),
  replaceActive: vi.fn(),
  replaceAll: vi.fn(async () => ({ replaced: 1, partial: true })),
}));

import FindReplaceBar from "../../src/client/editor/find-replace/FindReplaceBar.svelte";

afterEach(cleanup);

function q(root: ParentNode, testid: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid='${testid}']`);
}

/** Minimal editor surface the bar touches: plugin state in, commands out. */
function editorStub() {
  return {
    state: {},
    view: {},
    isDestroyed: false,
    on: vi.fn(),
    off: vi.fn(),
    commands: {
      find: vi.fn(),
      findClose: vi.fn(),
      findNext: vi.fn(),
      findPrev: vi.fn(),
    },
  } as unknown as import("@tiptap/core").Editor;
}

describe("FindReplaceBar live region", () => {
  it("mounts the region before the partial-replace warning, then fills that same node", async () => {
    const { container } = render(FindReplaceBar, {
      props: { editor: editorStub(), open: true, onClose: vi.fn() },
    });

    // Half 1 — the region exists, is a status region, and has nothing to say.
    // On master this node does not exist at all until the warning does.
    const before = q(container, "find-replace-live");
    expect(before).toBeTruthy();
    expect(before?.getAttribute("role")).toBe("status");
    expect(before?.getAttribute("aria-live")).toBe("polite");
    expect(before?.textContent?.trim()).toBe("");

    await fireEvent.input(q(container, "find-input") as HTMLInputElement, {
      target: { value: "needle" },
    });
    (q(container, "replace-all-btn") as HTMLButtonElement).click();

    // Half 2 — the text lands INSIDE the node that was already there.
    await waitFor(() => {
      expect(q(container, "find-replace-live")?.textContent).toContain("Replaced 1 of 2");
    });
    expect(q(container, "find-replace-live")).toBe(before);

    // Half 3 — the strip itself no longer owns live semantics.
    const strip = container.querySelector<HTMLElement>(".fr-msg.warning");
    expect(strip).toBeTruthy();
    expect(strip?.getAttribute("role")).toBeNull();
    expect(strip?.getAttribute("aria-live")).toBeNull();
  });
});
