// @vitest-environment happy-dom

/**
 * #1824 item C — the tutorial's shortcut copy named Ctrl+N
 * unconditionally, but Ctrl+N belongs to the browser in a browser tab (it
 * opens a new window before Tandem ever sees the key). Only the desktop app
 * owns its own window, so the shortcut only works there — matches
 * user-guide.md's existing caveat for the same three browser-reserved
 * shortcuts.
 */

import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));

vi.mock(import("../../src/client/cowork/cowork-helpers"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: isTauriRuntimeMock };
});

import OnboardingTutorial from "../../src/client/components/OnboardingTutorial.svelte";

function mount(
  ticks: { reviewed?: boolean; asked?: boolean; edited?: boolean; allDone?: boolean } = {},
  onDismiss = vi.fn(),
) {
  return render(OnboardingTutorial, {
    props: {
      reviewed: false,
      asked: false,
      edited: false,
      allDone: false,
      showCowork: false,
      coworkStatus: null,
      onDismiss,
      onCoworkAdvance: vi.fn(),
      ...ticks,
    },
  });
}

const byTestId = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

afterEach(() => {
  isTauriRuntimeMock.mockReset();
  isTauriRuntimeMock.mockReturnValue(false);
});

describe("OnboardingTutorial ready copy (#1824 item C)", () => {
  it("names the + button in the tab bar, not Ctrl+N, in the browser build", () => {
    isTauriRuntimeMock.mockReturnValue(false);
    const { container } = mount({ reviewed: true, asked: true, edited: true, allDone: true });
    expect(container.textContent).toContain("the + button in the tab bar");
    expect(container.textContent).not.toContain("Ctrl+N");
  });

  it("keeps Ctrl+N in the desktop (Tauri) build", () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const { container } = mount({ reviewed: true, asked: true, edited: true, allDone: true });
    expect(container.textContent).toContain("Ctrl+N");
    expect(container.textContent).not.toContain("the + button in the tab bar");
  });
});

describe("OnboardingTutorial checklist strip (#1711)", () => {
  it("renders the three items with their done state and no way forward but doing them", () => {
    const { container } = mount({ asked: true });
    expect(byTestId(container, "tutorial-item-review")?.getAttribute("data-done")).toBe("false");
    expect(byTestId(container, "tutorial-item-ask")?.getAttribute("data-done")).toBe("true");
    expect(byTestId(container, "tutorial-item-edit")?.getAttribute("data-done")).toBe("false");
    // No Next: the only forward control is Done, and it exists only once all
    // three items are ticked.
    expect(byTestId(container, "tutorial-next-btn")).toBeNull();
    const buttons = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(buttons).not.toContain("Next");
  });

  it("shows Done with the ready copy once every item is ticked", () => {
    const { container } = mount({ reviewed: true, asked: true, edited: true, allDone: true });
    expect(byTestId(container, "tutorial-next-btn")?.textContent?.trim()).toBe("Done");
    expect(container.textContent).toContain("You're ready!");
  });

  it("the X dismisses", () => {
    const onDismiss = vi.fn();
    const { container } = mount({}, onDismiss);
    (byTestId(container, "tutorial-dismiss-btn") as HTMLButtonElement).click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("an item already done at mount does not pop; one that ticks while mounted does", async () => {
    const { container, rerender } = mount({ reviewed: true });
    const dot = (id: string) =>
      byTestId(container, `tutorial-item-${id}`)?.querySelector(".tut-dot");
    expect(dot("review")?.classList.contains("is-popped")).toBe(false);
    await rerender({ reviewed: true, asked: true });
    expect(dot("ask")?.classList.contains("is-popped")).toBe(true);
    expect(dot("review")?.classList.contains("is-popped")).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Ask Claude something",
    );
  });

  it("announces readiness when allDone turns true without an item ticking (Cowork last)", async () => {
    const ticked = { reviewed: true, asked: true, edited: true };
    const { container, rerender } = mount({ ...ticked, allDone: false });
    await rerender({ ...ticked, allDone: true });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("You're ready.");
  });
});
