/**
 * Reactive window.innerWidth rune store, rAF-debounced.
 *
 * Pattern lifted from Toolbar.svelte's local viewport tracker so consumers
 * (margin-view, future responsive surfaces) share a single subscription
 * shape. Each call to `createViewportWidth()` mounts its own listener +
 * rAF; cheap relative to the resize event itself.
 *
 * Cleanup MUST call both `removeEventListener` AND `cancelAnimationFrame` —
 * a queued frame after listener removal leaks across HMR reloads and would
 * fire into a destroyed effect root.
 */
export function createViewportWidth(): { readonly width: number } {
  let width = $state(window.innerWidth);

  $effect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        width = window.innerWidth;
        frame = null;
      });
    };
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  });

  return {
    get width() {
      return width;
    },
  };
}
