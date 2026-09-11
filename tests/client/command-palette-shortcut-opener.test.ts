// @vitest-environment happy-dom

/**
 * #1824 item F — a "shortcut" result row is display-only (no kind-specific
 * branch in runResult), but `runResult` unconditionally cleared `opener`
 * before the kind-specific branches, so highlighting a shortcut row and
 * pressing Enter silently discarded the pre-open focus target. A subsequent
 * Escape then restored focus to nothing (opener already null) instead of the
 * real trigger.
 */

import { fireEvent } from "@testing-library/dom";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "../../src/client/components/CommandPalette.svelte";

describe("CommandPalette shortcut row preserves the opener (#1824 item F)", () => {
  let trigger: HTMLButtonElement;

  afterEach(() => {
    trigger?.remove();
  });

  it("Enter on a shortcut row, then Escape, restores focus to the opening trigger", async () => {
    trigger = document.createElement("button");
    trigger.textContent = "open palette";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { container, unmount } = render(CommandPalette, {
      props: { open: true, onClose: vi.fn(), editor: null, annotations: [] },
    });
    // The mount effect captures document.activeElement as `opener` and
    // schedules the input focus via a microtask.
    await tick();
    await Promise.resolve();

    const input = container.querySelector<HTMLInputElement>("[data-testid='palette-input']");
    expect(input).toBeTruthy();
    if (!input) throw new Error("palette input not found");

    // Route to the shortcuts list ("?" prefix) — STATIC_SHORTCUT_ROWS
    // populates it unfiltered with an empty query tail.
    await fireEvent.input(input, { target: { value: "?" } });
    await tick();

    const firstShortcutRow = container.querySelector<HTMLElement>(
      "[data-testid^='palette-item-shortcut-']",
    );
    expect(firstShortcutRow, "at least one static shortcut row must render").toBeTruthy();

    // Enter on the highlighted (index 0) row.
    await fireEvent.keyDown(container.querySelector("[data-testid='command-palette']")!, {
      key: "Enter",
    });
    await tick();

    // Escape restores focus to whatever `opener` still holds.
    await fireEvent.keyDown(window, { key: "Escape" });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement, "focus must return to the original trigger").toBe(trigger);
    unmount();
  });
});
