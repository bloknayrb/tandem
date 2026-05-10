/**
 * Svelte action: calls handler when a click (mousedown) occurs outside the node.
 */
export function clickOutside(node: HTMLElement, handler: () => void) {
  function handleClick(event: MouseEvent) {
    if (!node.contains(event.target as Node)) {
      handler();
    }
  }
  document.addEventListener("mousedown", handleClick);
  return {
    destroy() {
      document.removeEventListener("mousedown", handleClick);
    },
  };
}
