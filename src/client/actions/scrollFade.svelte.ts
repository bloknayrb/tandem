/**
 * Hide native scrollbar and toggle `data-overflow-*` attrs so the CSS in
 * `scroll-fade.css` can render mask-image fade gradients on whichever edges
 * have hidden content.
 *
 * Usage: `<div class="tandem-scroll-fade-y" use:scrollFade={"y"}>`
 *
 * Catches the cases that matter via scroll events (cursor moves through
 * scroll positions) and ResizeObserver (container resize OR child resize
 * that changes scrollHeight). MutationObserver was tried and removed —
 * `characterData: true` on a `subtree` fires per keystroke in the chat
 * composer, paying a forced-layout cost for a state that doesn't change.
 */

export type ScrollFadeAxis = "x" | "y" | "both";

export function scrollFade(node: HTMLElement, axis: ScrollFadeAxis = "y") {
  function update(): void {
    // ResizeObserver can fire one callback after disconnect; guard against
    // detached-node reads which return 0 dimensions and produce false
    // "no overflow" state that the caller can't recover from.
    if (!node.isConnected) return;
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

  // Guard observer construction — legacy browsers / test stubs that lack
  // ResizeObserver would otherwise throw after the scroll listener is
  // already registered, leaking the listener.
  let observer: ResizeObserver | null = null;
  try {
    observer = new ResizeObserver(update);
    observer.observe(node);
  } catch (err) {
    console.warn("[tandem:scrollFade] ResizeObserver init failed", err);
  }

  return {
    destroy(): void {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    },
  };
}
