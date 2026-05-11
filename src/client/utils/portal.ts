import type { ActionReturn } from "svelte/action";

export function portal(node: HTMLElement): ActionReturn {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
