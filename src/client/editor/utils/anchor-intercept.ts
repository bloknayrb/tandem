// The editor's anchor gesture intercept, shared by the `click` and `auxclick`
// handlers on the editor root (`Editor.svelte`).
//
// It lives here rather than inline in the component for two reasons. The first
// is that there are now TWO events reaching the same trust gate, and a second
// inline copy is exactly the drift `openHref`'s "single trust gate" comment
// warns about. The second is testability: the button/modifier matrix below is a
// security invariant (#1420) and a component-mount test cannot cover it.
//
// #1420: `Editor.svelte` registered `onclick` and nothing else. A middle click
// fires `auxclick`, not `click`, so the gesture never reached the intercept,
// never hit `preventDefault()`, and never routed through `openHref`.

/**
 * `MouseEvent.button` values: 0 primary, 1 middle, 2 secondary, 3 back,
 * 4 forward. Only the middle button opens an anchor; 2 belongs to the context
 * menu and 3/4 are cancelable history navigations, so intercepting those would
 * turn a back-button click landing over a link into a link open.
 */
export const MOUSE_BUTTON_MIDDLE = 1;

/**
 * Take ownership of an anchor gesture in the editor.
 *
 * Returns `true` when the gesture landed on an anchor and this function has
 * handled it — the caller must NOT run its own click handling (annotation
 * selection). Returns `false` when the gesture is not ours and the caller
 * should continue.
 *
 * **Modifiers are deliberately not filtered.** Ctrl/Cmd/Shift/Alt + click all
 * still fire `click` with button 0, and the same combinations with the middle
 * button all fire `auxclick` with button 1. `preventDefault()` cancels the
 * new-tab open for every one of them, and routing them through `openHref`
 * preserves the gesture's meaning: an external href reaches the system browser,
 * a relative href opens as a new *Tandem* tab — which is what "a new tab" means
 * in this app, and what a plain left click already does.
 *
 * **What `preventDefault()` is and is not worth.** The `auxclick` EVENT fires in
 * every engine that implements it, but the DEFAULT ACTION it cancels is
 * engine- and context-dependent: Chromium already suppresses middle-click
 * navigation inside a `contenteditable`, and raises it in a read-only editor.
 * So this handler is the control that matters on the read-only surface (View
 * Changelog, upgrade-opens-CHANGELOG, `upload://`, `readOnly: true` opens) —
 * which is also the surface carrying externally-authored content. Engines that
 * fire no `auxclick` at all, or fire it uncancelable, are covered by the
 * render-time veto instead (`isRenderableLinkHref` in `./url-safety.ts`), not
 * by this function.
 */
export function interceptAnchorGesture(e: MouseEvent, openHref: (href: string) => void): boolean {
  // Only the middle button opens an anchor. `click` is primary-button-only by
  // definition, so this narrows `auxclick` alone.
  if (e.type === "auxclick" && e.button !== MOUSE_BUTTON_MIDDLE) return false;

  const target = e.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest("a[href]");
  if (!anchor) return false;

  const href = anchor.getAttribute("href") ?? "";

  // Empty href (a mark whose href the render-time veto blanked) or a pure
  // fragment. The two events want DIFFERENT treatment here, which is why this
  // branch is not simply "let the browser handle it":
  //
  //  - `click`: the default action is an in-page scroll — same-origin, no trust
  //    decision, and the pre-#1420 behaviour. Leave it alone.
  //  - `auxclick`: the default action is a NEW TAB, and `href=""` resolves to
  //    the current document URL while `#frag` resolves to current-URL-plus-
  //    fragment. So the middle click would open a duplicate window of the app
  //    itself — no cross-host reach, but a second editor session against the
  //    same documents, which is not what the gesture means. It is reachable on
  //    exactly the surface #1420 targets: the veto blanks a Word link to
  //    `\\fileserver\docs\spec.docx` to `href=""`, and the read-only changelog
  //    is where Chromium raises the middle-click default action.
  //
  // Either way we return `true`, which stops the caller's annotation handling —
  // the pre-#1420 behaviour of the click path.
  if (!href || href.startsWith("#")) {
    if (e.type === "auxclick") e.preventDefault();
    return true;
  }

  // Take ownership even if no branch of `openHref` handles this href — we do
  // not want the browser navigating to it. This must run BEFORE any await, so
  // `openHref` is fired and not awaited (the context menu at `Editor.svelte`
  // uses the same spelling); nothing awaits a DOM handler anyway.
  e.preventDefault();
  openHref(href);
  return true;
}
