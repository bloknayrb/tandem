/**
 * Svelte action: calls handler when a click (mousedown) occurs outside the node.
 * The handler receives the originating MouseEvent so callers can perform
 * additional target checks (e.g. ignoring clicks on a toggle button).
 */
export function clickOutside(node: HTMLElement, handler: (event: MouseEvent) => void) {
  function handleClick(event: MouseEvent) {
    if (!node.contains(event.target as Node)) {
      handler(event);
    }
  }
  document.addEventListener("mousedown", handleClick);
  return {
    destroy() {
      document.removeEventListener("mousedown", handleClick);
    },
  };
}
