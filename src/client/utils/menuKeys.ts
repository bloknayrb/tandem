/**
 * Arrow-key navigation for `role="menu"` containers.
 *
 * A menu is a *composite* widget in the WAI-ARIA Authoring Practices: it takes
 * a single tab stop, and arrow keys move between its items. Tandem's menus
 * declared the role and wired `Escape`, but nothing else — so a keyboard user
 * who opened one landed in a widget that announced itself as a menu and then
 * did not respond to the keys a menu is operated with.
 *
 * That gap survived an axe audit for a structural reason worth recording: axe
 * checks the markup, and the markup was correct. It cannot see that a `keydown`
 * handler has no `ArrowDown` branch. A Tab-only traversal misses it too,
 * because the items are `<button>`s and therefore tabbable — the menu is
 * *reachable*, just not *operable as a menu*. It took a test that presses the
 * key and asks where focus went.
 *
 * Deliberately not a full APG menu implementation: no typeahead, no submenu
 * traversal, and Tab is left alone rather than being trapped. These menus are
 * short flat lists, and leaving Tab working means the pre-existing escape route
 * out of a menu keeps working exactly as it did. The APG's "focus the checked
 * radio on open" rule IS implemented — see `focusMenuEntryPoint`.
 */

/**
 * Move focus onto a menu's entry point: the checked `menuitemradio` if there is
 * one, else the first item.
 *
 * Required, not a nicety. Opening a menu leaves focus on the *trigger*, and in
 * all three of Tandem's menus the trigger is a SIBLING of the `role="menu"`
 * element — so a keydown from the trigger never reaches the menu's handler and
 * the very first arrow press does nothing. Arrow keys would appear to work only
 * once the user had Tabbed into the menu, which is the traversal that already
 * worked and not the one that was broken.
 *
 * The checked-radio preference is the APG rule for a menu containing a group of
 * radio items, and both of Tandem's radio menus already expose the state in the
 * DOM (TitleBar's theme swatches, FormattingToolbar's heading levels), so this
 * only reads what is already there.
 *
 * Restricted to `menuitemradio` ON PURPOSE. `menuitemcheckbox` items are
 * independent toggles with no "currently selected" one — DecorationsMenu's four
 * rows are all checkboxes and all checked by default, so honouring `aria-checked`
 * there would make the menu's entry point depend on the user's decoration
 * settings (turn off "authorship" and it would open on row 2).
 *
 * Called from an effect that runs after the menu renders.
 */
export function focusMenuEntryPoint(menu: HTMLElement | null | undefined): void {
  if (!menu) return;
  const list = items(menu);
  const checkedRadio = list.find(
    (el) =>
      el.getAttribute("role") === "menuitemradio" && el.getAttribute("aria-checked") === "true",
  );
  (checkedRadio ?? list[0])?.focus();
}

/**
 * Items in DOM order: `menuitem`, `menuitemcheckbox`, `menuitemradio`.
 *
 * `aria-disabled` is filtered as well as `disabled`, because the native
 * attribute only exists on form controls — an APG menu item need not be a
 * `<button>`, and `aria-disabled` is the only way such an item can say
 * "unavailable". A disabled item that still takes focus is worse than one that
 * is skipped.
 */
function items(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-disabled") !== "true" &&
      el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Handle a keydown against the menu containing the event target.
 *
 * Returns `true` if the key was consumed, so callers can skip their own
 * handling. Safe to call unconditionally: unrelated keys return `false`
 * untouched.
 */
export function handleMenuArrowKeys(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;

  const target = e.target as HTMLElement | null;
  const menu = target?.closest<HTMLElement>('[role="menu"]');
  if (!menu) return false;

  const list = items(menu);
  if (list.length === 0) return false;

  // -1 when focus is on the menu container rather than an item — reachable by
  // clicking a menu's padding, or if a caller focuses the container itself.
  // Treating it as "before the first item" makes ArrowDown enter the menu.
  const focused = target?.closest<HTMLElement>('[role^="menuitem"]') ?? null;
  const current = focused ? list.indexOf(focused) : -1;

  let next: number;
  switch (e.key) {
    case "ArrowDown":
      next = current < 0 ? 0 : (current + 1) % list.length;
      break;
    case "ArrowUp":
      next = current < 0 ? list.length - 1 : (current - 1 + list.length) % list.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = list.length - 1;
      break;
    default:
      return false;
  }

  e.preventDefault();
  // `stopPropagation` as well: these menus are nested inside surfaces (the
  // titlebar, the formatting bar) whose own handlers would otherwise also see
  // an arrow press the menu has already acted on.
  e.stopPropagation();
  list[next].focus();
  return true;
}
