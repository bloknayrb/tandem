export interface RadioGroupHandlers<T extends string> {
  handleKeyDown: (e: KeyboardEvent) => void;
  tabIndexFor: (v: T) => 0 | -1;
}

/**
 * Pure roving-tabindex + arrow-key navigation for a role="radiogroup".
 * No React dependency — retained for unit-test coverage.
 * The Svelte counterpart (createRadioGroup) wraps the same logic via getter API.
 */
export function useRadioGroup<T extends string>(
  value: T,
  values: readonly T[],
  setValue: (next: T) => void,
  isDisabled?: (v: T) => boolean,
): RadioGroupHandlers<T> {
  const enabled = isDisabled ? values.filter((v) => !isDisabled(v)) : values;

  const handleKeyDown = (e: KeyboardEvent) => {
    const { key } = e;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "ArrowUp" &&
      key !== "ArrowDown" &&
      key !== "Home" &&
      key !== "End"
    )
      return;
    if (enabled.length === 0) return;
    e.preventDefault();
    const idx = enabled.indexOf(value);
    const last = enabled.length - 1;
    let next: number;
    if (key === "Home") next = 0;
    else if (key === "End") next = last;
    else if (key === "ArrowLeft" || key === "ArrowUp") next = idx <= 0 ? last : idx - 1;
    else next = idx >= last ? 0 : idx + 1;
    setValue(enabled[next]);
  };

  const tabIndexFor = (v: T): 0 | -1 => {
    if (isDisabled?.(v)) return -1;
    const tabStop = isDisabled?.(value) ? enabled[0] : value;
    return v === tabStop ? 0 : -1;
  };

  return { handleKeyDown, tabIndexFor };
}
