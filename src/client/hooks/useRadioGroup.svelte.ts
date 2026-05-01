export interface RadioGroupHandlers<T extends string> {
  handleKeyDown: (e: KeyboardEvent) => void;
  tabIndexFor: (v: T) => 0 | -1;
}

/**
 * Svelte 5 port of `useRadioGroup`.
 *
 * Roving tabindex + arrow-key navigation for a `role="radiogroup"` per
 * WAI-ARIA Authoring Practices. Accepts getter functions for reactive inputs.
 *
 * `currentTarget` must be the radiogroup container element, passed as `e.currentTarget`
 * from the Svelte `on:keydown` handler (or equivalent).
 */
export function createRadioGroup<T extends string>(
  getValue: () => T,
  values: readonly T[],
  setValue: (next: T) => void,
  isDisabled?: (v: T) => boolean,
): RadioGroupHandlers<T> {
  const handleKeyDown = (e: KeyboardEvent) => {
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
    const enabled = isDisabled ? values.filter((v) => !isDisabled(v)) : values;
    if (enabled.length === 0) return;
    e.preventDefault();

    const value = getValue();
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
    const container = (e as KeyboardEvent & { currentTarget: HTMLElement }).currentTarget;
    const radios = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const domIdx = values.indexOf(nextValue);
    radios?.[domIdx]?.focus();
  };

  const tabIndexFor = (v: T): 0 | -1 => {
    if (isDisabled?.(v)) return -1;
    const value = getValue();
    const enabled = isDisabled ? values.filter((x) => !isDisabled(x)) : values;
    // If the current value happens to be disabled, fall back to the first enabled value.
    const tabStop = isDisabled?.(value) ? enabled[0] : value;
    return v === tabStop ? 0 : -1;
  };

  return { handleKeyDown, tabIndexFor };
}
