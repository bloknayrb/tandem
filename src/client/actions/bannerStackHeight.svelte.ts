/**
 * Publishes the top-of-shell banner stack's bottom edge as
 * `--tandem-banner-stack-bottom` on <html>, so `--tandem-fmtbar-top`
 * (index.html) can push the fixed formatting-bar pill below whatever banners
 * are showing. 0px means "no banners", which the consumer maps to its resting
 * offset.
 *
 * Usage: `<div class="banner-stack" use:bannerStackHeight>…banners…</div>`
 *
 * Imperative rather than `$state`: nothing in Svelte reads this value, only CSS
 * does, so a reactive round-trip would buy nothing. That also moots the
 * reaction-safety question entirely. (The narrow claim is still worth stating:
 * ResizeObserver notifications are delivered from the rendering steps, never
 * nested inside a Svelte reaction, so `state_unsafe_mutation` does not apply —
 * cf. useMarginPositions/DocumentTabs, which do write $state from an RO. The
 * BROAD claim "an RO write is always safe" is false: editor-stage.svelte.ts
 * records RO chatter tripping `effect_update_depth_exceeded`, which is why the
 * last-value guard below is not optional.)
 */

const PROP = "--tandem-banner-stack-bottom";

export function bannerStackHeight(node: HTMLElement) {
  const root = document.documentElement;
  let last = -1;

  function publish(): void {
    // ResizeObserver can fire one callback after disconnect; a detached read
    // returns 0 and would park the pill at its resting offset.
    if (!node.isConnected) return;

    // Publish the stack's BOTTOM EDGE in viewport coordinates, not its height.
    //
    // Height was the obvious choice and it is subtly wrong: it forces the
    // consumer to know where the stack *starts*, i.e. to hardcode the TitleBar
    // height. The old geometry-contract comment in index.html put that at 44px;
    // the real rendered value is 56px, so a `calc(52px + height)` offset landed
    // 4px short and the pill still clipped the bottom of every banner. The
    // bottom edge encodes "where the stack ends" directly and stays correct if
    // the TitleBar is ever resized.
    //
    // `getBoundingClientRect()` is the border box (unlike RO's default
    // content-box `contentRect`, which would drop the 1px border-bottom each
    // banner carries). Rounded because a fractional devicePixelRatio (125%/150%
    // Windows scaling, browser zoom) otherwise redelivers sub-pixel noise
    // forever. Viewport-relative is safe here: the root column is `height:
    // 100vh` and the stack sits above the only scroll container, so it never
    // moves under scroll.
    const rect = node.getBoundingClientRect();
    // 0 is the "no banners showing" signal, which the consumer's `max()` maps
    // back to the resting 52px. Reporting the real bottom of an empty stack
    // would move the pill whenever the TitleBar height changed.
    const bottom = rect.height > 0 ? Math.round(rect.bottom) : 0;
    if (bottom === last) return;
    last = bottom;

    // MUST carry the unit. A custom property accepts any token stream, so a
    // bare `96` is stored happily and only fails one level down as
    // `max(52px, 96)` — invalid at computed-value time, which makes `top`
    // compute to `auto` and drops the fixed pill to its static position. The
    // `var(--tandem-fmtbar-top, 52px)` fallback at the consumer never fires,
    // because the token itself is well-formed.
    root.style.setProperty(PROP, `${bottom}px`);
  }

  // Eager first measurement, BEFORE the observer is constructed: RO's first
  // delivery is asynchronous (post-layout), so without this the first painted
  // frame uses H=0 and the pill lands on the banner for a frame. Visible on the
  // server-down path, where yjsSync sets ready=true and
  // connectionStatus="disconnected" in the same synchronous block.
  publish();

  // Guard construction the way scrollFade does — a missing ResizeObserver
  // degrades to the eager measurement above rather than throwing on mount.
  let observer: ResizeObserver | null = null;
  try {
    observer = new ResizeObserver(publish);
    observer.observe(node);
  } catch (err) {
    console.warn("[tandem:bannerStackHeight] ResizeObserver init failed", err);
  }

  return {
    destroy(): void {
      observer?.disconnect();
      // Falls back to the `:root` 0px declared in index.html, which the
      // consumer's max() reads as the resting 52px — which is why this is a
      // second variable rather than an overwrite of --tandem-fmtbar-top.
      root.style.removeProperty(PROP);
    },
  };
}
