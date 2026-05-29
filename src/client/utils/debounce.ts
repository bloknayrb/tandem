/**
 * Minimal debounce helper. No debounce util existed in the repo before #864
 * (scratchpad persistence needs to throttle localStorage writes on every
 * keystroke). Kept dependency-free and generic so other client surfaces can
 * reuse it.
 *
 * The returned function delays invoking `fn` until `waitMs` have elapsed since
 * the last call. `.cancel()` clears any pending invocation (call it from effect
 * cleanup so a trailing write can't fire after teardown). `.flush()` invokes a
 * pending call immediately (used to persist final content on close/unload).
 */
export interface Debounced<Args extends unknown[]> {
  (...args: Args): void;
  cancel: () => void;
  flush: () => void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;

  const debounced = (...args: Args) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args = lastArgs;
      lastArgs = null;
      if (args) fn(...args);
    }, waitMs);
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  return debounced as Debounced<Args>;
}
