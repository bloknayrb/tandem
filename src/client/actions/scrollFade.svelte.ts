/**
 * Svelte action: hide native scrollbar and toggle data-overflow-* attrs
 * so the CSS in `styles/scroll.css` can render mask-image fade gradients
 * on whichever edges currently have hidden content.
 *
 * Usage:
 *   <div class="tandem-scroll-fade-y" use:scrollFade={{ axis: "y" }}>
 *     ...scrollable content...
 *   </div>
 *
 * The class controls scrollbar hiding + mask edge thickness (set via
 * `--tandem-fade-edge`, default 24px). The action sets one of:
 *   - data-overflow-top="true" / data-overflow-bottom="true" (axis: "y")
 *   - data-overflow-left="true" / data-overflow-right="true" (axis: "x")
 *
 * Mirrors the proven DocumentTabs pattern (scroll listener +
 * ResizeObserver) — same accuracy, single owner.
 */

export interface ScrollFadeOptions {
  /** Which axis to track. Default `"y"`. */
  axis?: "x" | "y" | "both";
}

export function scrollFade(node: HTMLElement, options: ScrollFadeOptions = {}) {
  const axis = options.axis ?? "y";

  function update(): void {
    if (axis === "y" || axis === "both") {
      const top = node.scrollTop > 0;
      const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      toggle("data-overflow-top", top);
      toggle("data-overflow-bottom", bottom);
    }
    if (axis === "x" || axis === "both") {
      const left = node.scrollLeft > 0;
      const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
      toggle("data-overflow-left", left);
      toggle("data-overflow-right", right);
    }
  }

  function toggle(attr: string, on: boolean): void {
    if (on) node.setAttribute(attr, "true");
    else node.removeAttribute(attr);
  }

  update();
  node.addEventListener("scroll", update, { passive: true });
  const observer = new ResizeObserver(update);
  observer.observe(node);
  // Also observe content size — a child whose height changes while the
  // container size stays fixed still flips overflow state.
  const mutationObserver = new MutationObserver(update);
  mutationObserver.observe(node, { childList: true, subtree: true, characterData: true });

  return {
    destroy(): void {
      node.removeEventListener("scroll", update);
      observer.disconnect();
      mutationObserver.disconnect();
    },
  };
}
