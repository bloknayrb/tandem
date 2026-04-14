import type React from "react";

/**
 * Roving tabindex + arrow-key navigation for a `role="radiogroup"` per
 * WAI-ARIA Authoring Practices. Only the checked radio is in the tab order;
 * Left/Up/Right/Down/Home/End cycle through values and move focus.
 *
 * `isDisabled` lets the hook skip values that are conditionally unavailable
 * (e.g., three-panel below the viewport threshold) — without this, arrow
 * keys would bypass the onClick guard and write a disabled value into state.
 *
 * Focus is moved by indexing the matched children, so radio buttons don't
 * need any extra data attributes — just `role="radio"` on each child.
 */
export function useRadioGroup<T extends string>(
  value: T,
  values: readonly T[],
  setValue: (next: T) => void,
  isDisabled?: (v: T) => boolean,
): {
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  tabIndexFor: (v: T) => 0 | -1;
} {
  const enabled = isDisabled ? values.filter((v) => !isDisabled(v)) : values;

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
    if (enabled.length === 0) return;
    e.preventDefault();

    const idx = enabled.indexOf(value);
    const last = enabled.length - 1;
    let next: number;
    if (key === "Home") next = 0;
    else if (key === "End") next = last;
    else if (key === "ArrowLeft" || key === "ArrowUp") next = idx <= 0 ? last : idx - 1;
    else next = idx >= last ? 0 : idx + 1;

    const nextValue = enabled[next];
    setValue(nextValue);

    // Index-based focus — no data attributes needed, no selector injection.
    const radios = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const domIdx = values.indexOf(nextValue);
    radios[domIdx]?.focus();
  };

  // If the current value happens to be disabled (e.g., user saved
  // "three-panel" then narrowed the viewport), fall back to the first enabled
  // value so Tab can still reach the group.
  const tabStop = isDisabled?.(value) ? enabled[0] : value;
  const tabIndexFor = (v: T): 0 | -1 => {
    if (isDisabled?.(v)) return -1;
    return v === tabStop ? 0 : -1;
  };

  return { handleKeyDown, tabIndexFor };
}
