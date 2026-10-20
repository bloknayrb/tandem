/**
 * A reactive value for a stubbed hook's getter, when a test must change it
 * while the component is mounted — a plain object field is read once and never
 * again (see `wizard-step-cell.svelte.ts` for the mistake that teaches).
 */
export function reactiveCell<T>(initial: T): { value: T; reset(): void } {
  let current = $state(initial);
  return {
    get value(): T {
      return current;
    },
    set value(next: T) {
      current = next;
    },
    reset(): void {
      current = initial;
    },
  };
}
