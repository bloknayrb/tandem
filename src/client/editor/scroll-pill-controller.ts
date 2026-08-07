/**
 * DOM controller for the editor scroll pill.
 *
 * Split out of `ScrollPill.svelte` so the whole lifecycle — attach, measure,
 * drag, teardown — is one plain function over non-null elements rather than a
 * closure over possibly-null `bind:this` refs. The component keeps only the
 * markup, the styles, and a three-line `$effect` that calls this.
 *
 * The arithmetic lives in `scroll-pill.ts`; this module owns every DOM read and
 * write and holds no framework state.
 *
 * Read/write discipline, which is the thing to preserve here: layout reads
 * happen in exactly one place (`measureStatic`), driven only by resize and
 * child mutation. The scroll handler and the global pointer handler read
 * nothing from the DOM, and the frame reads only `scrollTop`. This app has
 * other rAF writers (margin positioning, tab-drag transforms, scroll restore)
 * that can dirty layout ahead of us, so a stray `getBoundingClientRect` in one
 * of those paths is a forced synchronous layout at pointer frequency.
 */

import { motionOff } from "../panels/cardMotion.js";
import {
  clampThumbTop,
  composeOpacity,
  FLASH_HOLD_MS,
  flashOpacity,
  HIT_TEST_MIN_OPACITY,
  proximityOpacity,
  type Rect,
  rectDistance,
  scrollTopForThumbTop,
  type ThumbMetrics,
  thumbMetrics,
} from "./scroll-pill.js";

/** Applied to `<body>` for a drag's duration; styled in `ScrollPill.svelte`. */
const DRAGGING_CLASS = "tandem-scroll-pill-dragging";

/** Marks the trailing-whitespace block so the pill can discount it. */
const SPACER_SELECTOR = "[data-scroll-spacer]";

export interface ScrollPillOptions {
  /**
   * The in-app reduce-motion setting. OR-ed with the OS preference via
   * `motionOff`, since a JS-driven pulse escapes the CSS media query.
   *
   * Changes the scroll flash from an eased decay to a hold-then-cut step. It
   * does NOT remove the flash: with the native bar hidden, the flash is the
   * only scroll feedback a user gets when the cursor is away from the gutter,
   * so suppressing it would leave this cohort with nothing.
   */
  reduceMotion: boolean;
}

type ListenerSpec = [EventTarget, string, EventListener, AddEventListenerOptions?];

/**
 * Wire the pill up. Returns a teardown that must be called: it cancels the
 * pending frame, ends any drag, and hides the thumb (the component stays
 * mounted when the setting flips off, so an un-hidden thumb would freeze on
 * screen at its last opacity).
 */
export function attachScrollPill(
  scroller: HTMLElement,
  track: HTMLElement,
  thumb: HTMLElement,
  options: ScrollPillOptions,
): () => void {
  // Read once at attach, matching every other `motionOff` consumer: an OS-level
  // change mid-session is not picked up until the effect re-runs.
  const reduceMotion = motionOff(options.reduceMotion);

  // Guards every async continuation. `cancelAnimationFrame` cannot stop a frame
  // that is already executing, and a post-teardown frame would read geometry
  // off a detached node — returning 0 and latching a false "no overflow", the
  // unrecoverable state `scrollFade` guards with its own `isConnected` check.
  let disposed = false;
  let rafId = 0;

  /**
   * The expensive reads: a rect and an `offsetHeight`. Invalidated by resize
   * and child mutation only.
   *
   * `scrollHeight`/`clientHeight` are deliberately NOT cached here. They are
   * single property reads — `scrollFade` already takes them per scroll event on
   * this very element, so caching them saves nothing measurable — and caching
   * them created a real hole: a `.docx` stage is `display: contents` when
   * margins are off, so it generates no box, the ResizeObserver never fires for
   * it, and its content growth is invisible. The cached extent stayed at the
   * cold-open value, `thumbMetrics` kept returning null, and a long document
   * got no thumb at all while the native bar was already hidden. Reading the
   * live extent each frame makes the pill correct for any container shape
   * rather than for the shapes we remembered to observe.
   */
  let statics: {
    trackRect: DOMRect;
    spacer: number;
  } | null = null;
  let metrics: ThumbMetrics | null = null;
  /** Re-resolved by `measureStatic`, so the per-frame path never queries. */
  let spacerEl: HTMLElement | null = null;

  /**
   * Null when the cursor is outside the editor column. The right rail sits
   * immediately outboard and is usually narrower than the fade radius, so a
   * distance-only rule would light the pill whenever the user was merely
   * reading their annotations. One `contains()` also subsumes every modal,
   * menu, popover and slash menu (all rendered at app root or on `body`), and
   * pointer capture during a panel resize or tab drag retargets the event
   * outside the wrap, so those suppress for free.
   */
  let pointer: { x: number; y: number } | null = null;

  let flashStart = Number.NEGATIVE_INFINITY;

  /** Last values written, so a frame that would change nothing writes nothing. */
  let painted: { opacity: number; height: number; top: number } | null = null;

  /**
   * Frozen at pointerdown. Live metrics would resize the thumb out from under
   * the pointer's grab offset if the document grew mid-drag (image decode,
   * annotations mounting).
   */
  let drag: {
    pointerId: number;
    grabDy: number;
    trackTop: number;
    startScrollTop: number;
    trackHeight: number;
    thumbHeight: number;
    scrollHeight: number;
    clientHeight: number;
    trailingSpacerPx: number;
  } | null = null;

  const wrap = scroller.parentElement;

  /** The only layout-reading function. */
  function measureStatic(): void {
    if (!scroller.isConnected) return;
    // Resolved here rather than only in `retarget()`: if the observers fail to
    // construct, `retarget()` never runs, and a permanently-null spacer would
    // silently reinstate the "70vh of blank space counts as document length"
    // bug this whole correction exists to prevent.
    spacerEl = scroller.querySelector<HTMLElement>(SPACER_SELECTOR);
    statics = {
      trackRect: track.getBoundingClientRect(),
      spacer: spacerEl?.offsetHeight ?? 0,
    };
  }

  /** Recompute the thumb from the cached statics plus the live scroll offset. */
  function refreshMetrics(): void {
    if (!statics) {
      metrics = null;
      return;
    }
    const wasPaintable = metrics !== null;
    metrics = thumbMetrics({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      trackHeight: statics.trackRect.height,
      trailingSpacerPx: statics.spacer,
    });
    // Re-arm the announce flash the first time there is actually a thumb to
    // show. Arming it only at attach loses the pulse entirely on any cold load
    // slower than the flash budget, because Tiptap has not rendered yet and
    // there is nothing to paint — and nothing would re-arm it afterwards.
    if (!wasPaintable && metrics && !drag) flashStart = performance.now();
  }

  function thumbRect(): Rect | null {
    if (!statics || !metrics) return null;
    const { trackRect } = statics;
    return {
      left: trackRect.left,
      right: trackRect.right,
      top: trackRect.top + metrics.top,
      bottom: trackRect.top + metrics.top + metrics.height,
    };
  }

  function paint(): number {
    if (!metrics) {
      if (painted) {
        thumb.style.display = "none";
        painted = null;
      }
      return 0;
    }

    const rect = thumbRect();
    const distance = pointer && rect ? rectDistance(pointer.x, pointer.y, rect) : Infinity;
    // Reduce-motion drops the easing, NOT the information: a step function
    // holds the pill at full strength for the same window and then cuts.
    // Suppressing the flash entirely would leave a reduce-motion user with no
    // scroll feedback at all — the native bar is hidden whenever the pill is on
    // — which is the very complaint the pill answers, reintroduced for the one
    // cohort least able to work around it.
    const elapsed = performance.now() - flashStart;
    const flash = reduceMotion ? (elapsed <= FLASH_HOLD_MS ? 1 : 0) : flashOpacity(elapsed);
    const opacity = composeOpacity({
      proximity: proximityOpacity(distance),
      flash,
      dragging: drag !== null,
    });

    if (
      painted &&
      painted.opacity === opacity &&
      painted.height === metrics.height &&
      painted.top === metrics.top
    ) {
      return flash;
    }

    thumb.style.display = "block";
    thumb.style.height = `${metrics.height}px`;
    thumb.style.transform = `translateY(${metrics.top}px)`;
    // Written as a custom property, not `opacity` directly. An inline `opacity`
    // would outrank the forced-colors and high-contrast rules in the style
    // block, forcing an `!important` arms race; a custom property lets CSS
    // decide and keeps those escape hatches un-clobberable.
    thumb.style.setProperty("--pill-o", String(opacity));
    thumb.style.pointerEvents = opacity >= HIT_TEST_MIN_OPACITY ? "auto" : "none";
    painted = { opacity, height: metrics.height, top: metrics.top };
    return flash;
  }

  function frame(): void {
    // Cleared FIRST: a throw further down must not strand the flag and freeze
    // the pill for the rest of the session.
    rafId = 0;
    if (disposed) return;
    if (!drag) refreshMetrics();
    // Self-continue while the flash still has decay left. Re-arming only from
    // incoming events would leave a scroll-and-stop frozen at full strength
    // with no further event to fade it.
    if (paint() > 0) schedule();
  }

  function schedule(): void {
    if (disposed || rafId !== 0) return;
    rafId = requestAnimationFrame(frame);
  }

  function invalidate(): void {
    if (disposed) return;
    // A drag renders from frozen geometry, so re-measuring mid-grab would
    // resize the thumb under the cursor.
    if (!drag) measureStatic();
    schedule();
  }

  function onScroll(): void {
    if (!drag) flashStart = performance.now();
    schedule();
  }

  function markPointerAway(): void {
    pointer = null;
    schedule();
  }

  function onPointerMove(e: PointerEvent): void {
    if (drag && e.pointerId === drag.pointerId) {
      moveDrag(e);
      return;
    }
    // Touch never produces hover, and a finger lifted after a touch-scroll
    // sends no further moves and no `pointerout` — the pill would stay stuck at
    // whatever opacity that gesture left behind.
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    // Nothing is painted on a document that does not overflow, so skip both the
    // ancestor walk and the frame. This is the common case for short notes, and
    // without it every mouse move anywhere in the app schedules a no-op frame.
    // Clear rather than keep: a cached coordinate can only go stale while the
    // thumb is gone, and a stale near-thumb value would flash the pill fully
    // lit the moment the document grows back.
    if (!metrics) {
      pointer = null;
      return;
    }
    pointer =
      wrap && e.target instanceof Node && wrap.contains(e.target)
        ? { x: e.clientX, y: e.clientY }
        : null;
    schedule();
  }

  function onPointerOut(e: PointerEvent): void {
    // `pointerleave` does not bubble and never reaches `window`; a null
    // `relatedTarget` on the bubbling `pointerout` is the "left the viewport"
    // signal. Without this the pill stays lit indefinitely when the user moves
    // off the window without clicking away — `blur` alone needs focus loss.
    if (e.relatedTarget === null) markPointerAway();
  }

  function onPointerUpAnywhere(e: PointerEvent): void {
    // Only the pointer that started the scrub may end it. On a touch-capable
    // machine a stray finger's `pointerup` would otherwise drop a mouse drag
    // that is still held down.
    if (drag) {
      if (e.pointerId === drag.pointerId) endDrag();
      return;
    }
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") markPointerAway();
  }

  // ---- drag --------------------------------------------------------------

  function moveDrag(e: PointerEvent): void {
    // Same reasoning as `onPointerUpAnywhere`: a second pointer's coordinates
    // would jump `scrollTop` out from under the pointer actually scrubbing.
    if (!drag || e.pointerId !== drag.pointerId) return;
    // Keep the cache fresh even though `composeOpacity` pins to 1 while
    // dragging: on release the pin drops and the very next paint measures
    // distance from this coordinate. Left stale at the pointerdown position, a
    // long scrub ends with the pill vanishing under the user's own cursor.
    pointer = { x: e.clientX, y: e.clientY };
    const top = clampThumbTop(e.clientY - drag.grabDy - drag.trackTop, drag);
    // Render from the frozen geometry so the thumb stays glued to the cursor
    // even if the document's length changes underneath the drag.
    metrics = { height: drag.thumbHeight, top };
    scroller.scrollTop = scrollTopForThumbTop(top, drag);
    schedule();
  }

  /**
   * macOS inertial scrolling keeps firing while the pointer is down; the thumb
   * would follow the momentum and then snap back on the next 1px pointer move.
   * Non-passive so `preventDefault` actually applies.
   */
  function blockWheel(e: Event): void {
    e.preventDefault();
  }

  /**
   * Forward a wheel over the thumb to the document.
   *
   * The thumb is a SIBLING of the scroller, so its scroll-chain parent is
   * `.editor-column-wrap` and then `#root`, which `index.html` pins to
   * `overflow: hidden`. Without this the wheel goes nowhere: park the cursor in
   * the right-edge band and the first notch scrolls, which arms the flash,
   * which lights the thumb and gives it `pointer-events: auto` — and every
   * notch after that is dead until the flash decays. A real scrollbar scrolls
   * its container; this makes the pill behave the same.
   *
   * Skipped mid-drag: `blockWheel` owns the wheel then, deliberately.
   */
  function forwardWheel(e: WheelEvent): void {
    if (drag) return;
    e.preventDefault();
    // deltaMode is px (0), lines (1), or pages (2) — the latter two show up on
    // Firefox and some mice, and treating them as px would barely move.
    const lineHeight = 16;
    const scale = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? scroller.clientHeight : 1;
    scroller.scrollTop += e.deltaY * scale;
  }

  function endDrag(): void {
    if (!drag) return;
    const { pointerId } = drag;
    drag = null;
    try {
      if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId);
    } catch {
      // Capture can already be gone (pointer left, element detached).
    }
    document.body.classList.remove(DRAGGING_CLASS);
    window.removeEventListener("wheel", blockWheel);
    invalidate();
  }

  function onThumbPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || drag) return;
    if (!statics) measureStatic();
    if (!statics || !metrics) return;
    // Suppresses the compat mousedown, which would otherwise start a text
    // selection and blur the editor mid-scrub.
    //
    // Deliberately NOT `stopPropagation()`: the thumb is a sibling of the
    // scroller, not a descendant, so nothing on the way up to `document` wants
    // this event — and stopping it there only hid the pointerdown from
    // document-level dismissal handlers such as SettingsModal's.
    //
    // Known, accepted: `preventDefault` also suppresses the compat mousedown
    // that `clickOutside` listens for, so an open dropdown stays open while you
    // scrub. Preserving editor focus and the caret is worth more than closing a
    // menu that the next real click closes anyway.
    e.preventDefault();

    drag = {
      pointerId: e.pointerId,
      grabDy: e.clientY - (statics.trackRect.top + metrics.top),
      trackTop: statics.trackRect.top,
      startScrollTop: scroller.scrollTop,
      trackHeight: statics.trackRect.height,
      thumbHeight: metrics.height,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      trailingSpacerPx: statics.spacer,
    };

    try {
      thumb.setPointerCapture(e.pointerId);
    } catch {
      // Non-fatal: the window-level move/up listeners drive the drag anyway.
    }
    document.body.classList.add(DRAGGING_CLASS);
    // On `window`, not the scroller: during a drag the cursor sits over the
    // thumb, which is a SIBLING of the scroller, and `wheel` is not a pointer
    // event — so pointer capture does not retarget it and a scroller-scoped
    // listener would never fire.
    window.addEventListener("wheel", blockWheel, { passive: false });
    schedule();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    const restore = drag.startScrollTop;
    endDrag();
    scroller.scrollTop = restore;
  }

  // ---- wiring ------------------------------------------------------------

  // One table, added at the bottom and removed in the teardown, so the two
  // halves cannot drift apart. Drag move/up live on `window` rather than the
  // thumb so cleanup stays reliable if the thumb is hidden mid-gesture — the
  // same reasoning the tab drag records for its own listeners.
  const listeners: ListenerSpec[] = [
    [scroller, "scroll", onScroll as EventListener, { passive: true }],
    [window, "pointermove", onPointerMove as EventListener, { passive: true }],
    [window, "pointerup", onPointerUpAnywhere as EventListener, { passive: true }],
    [window, "pointercancel", onPointerUpAnywhere as EventListener, { passive: true }],
    [window, "pointerout", onPointerOut as EventListener, { passive: true }],
    [window, "blur", markPointerAway as EventListener],
    [window, "resize", invalidate as EventListener, { passive: true }],
    [window, "keydown", onKeyDown as EventListener],
    // `lostpointercapture` fires on implicit release too, including the thumb
    // being hidden mid-drag — without it `drag` would latch, pinning opacity at
    // 1 and spinning the rAF loop for the rest of the session.
    [thumb, "lostpointercapture", endDrag as EventListener],
    [thumb, "pointerdown", onThumbPointerDown as EventListener],
    // Non-passive: this one exists to `preventDefault` and re-dispatch.
    [thumb, "wheel", forwardWheel as EventListener, { passive: false }],
  ];
  for (const [target, type, handler, opts] of listeners) {
    target.addEventListener(type, handler, opts);
  }

  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;

  /**
   * Content height, not just container height, moves `scrollHeight` — and the
   * scroller's children are not stable: `{#if inSourceView}` swaps the stage
   * wholesale and three banners mount and unmount above it. Observing every
   * direct child rather than a hardcoded list covers the banners too and keeps
   * the pill from depending on any other component's selectors.
   *
   * A child with `display: contents` (the docx stage with margins off)
   * generates no box, so the observer never fires for it — which is exactly why
   * the scroll extent is read live per frame rather than cached here. This
   * observer only needs to catch changes to the TRACK rect and the spacer.
   */
  function retarget(): void {
    if (disposed || !ro) return;
    ro.disconnect();
    ro.observe(scroller);
    for (const child of scroller.children) ro.observe(child);
    invalidate();
  }

  // Announce the pill once on attach. Without this it stays invisible until the
  // user happens to scroll or bring the cursor near, which is a poor answer to
  // "I couldn't tell how long the document was" — the complaint it exists for.
  flashStart = performance.now();

  try {
    ro = new ResizeObserver(invalidate);
    // childList only — no `subtree`, no `characterData`. This is NOT the
    // observer `scrollFade` rejected: that one watched `characterData` on a
    // subtree and fired per keystroke in the chat composer. This fires when a
    // banner or the stage mounts, a handful of times per session.
    mo = new MutationObserver(retarget);
    mo.observe(scroller, { childList: true });
    retarget();
  } catch (err) {
    // Matches scrollFade: construction must not throw after listeners are
    // already registered, or they leak.
    console.warn("[tandem:ScrollPill] observer init failed", err);
    invalidate();
  }

  return () => {
    // Set first so `endDrag`'s trailing `invalidate()` is a no-op.
    disposed = true;
    if (rafId !== 0) cancelAnimationFrame(rafId);
    endDrag();
    for (const [target, type, handler] of listeners) {
      target.removeEventListener(type, handler);
    }
    ro?.disconnect();
    mo?.disconnect();
    thumb.style.display = "none";
    painted = null;
  };
}
