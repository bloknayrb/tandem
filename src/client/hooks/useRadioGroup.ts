import type React from "react";

/**
 * Roving tabindex + arrow-key navigation for a `role="radiogroup"` per
 * WAI-ARIA Authoring Practices. Only the checked radio is in the tab order;
 * Left/Up/Right/Down/Home/End cycle through values and move focus.
 *
 * Each radio button must have `data-radio-value="<value>"` so the keyboard
 * handler can find the newly-selected DOM node to focus.
 */
export function useRadioGroup<T extends string>(
  value: T,
  values: readonly T[],
  setValue: (next: T) => void,
): {
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  tabIndexFor: (v: T) => 0 | -1;
} {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = e;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "ArrowUp" &&
      key !== "ArrowDown" &&
      key !== "Home" &&
      key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const idx = values.indexOf(value);
    const last = values.length - 1;
    let next: number;
    if (key === "Home") next = 0;
    else if (key === "End") next = last;
    else if (key === "ArrowLeft" || key === "ArrowUp") next = idx <= 0 ? last : idx - 1;
    else next = idx >= last ? 0 : idx + 1;

    const nextValue = values[next];
    setValue(nextValue);
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(
      `[data-radio-value="${nextValue}"]`,
    );
    btn?.focus();
  };

  const tabIndexFor = (v: T): 0 | -1 => (v === value ? 0 : -1);

  return { handleKeyDown, tabIndexFor };
}
