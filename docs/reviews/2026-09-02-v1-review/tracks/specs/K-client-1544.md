# K-client — #1544 Tab unsaved indicator's only content is `aria-hidden`

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1544. Probe: mount a
dirty tab and assert the tab's own accessible name changes to reflect it — not the indicator's
DOM text.

## Problem

`src/client/tabs/TabItem.svelte:264` gives the tab row `aria-label={tab.fileName}` with no dirty
state. The indicator span (`:271-281`) toggles its wrapper's `aria-hidden` to `false` when dirty,
but its only children are themselves `aria-hidden="true"` — unhiding a wrapper with no
accessible content announces nothing.

An explicit `aria-label` on `role="tab"` overrides all descendant content per the accname
computation, so a visually-hidden sibling span *inside* the tab row would never reach the
accessible-name computation either — the tab's own `aria-label` is the only channel that
actually reaches assistive tech here.

Existing references to `unsaved-indicator` (`tests/client/TabItem.svelte.test.ts:68`,
`tests/e2e/open-does-not-dirty.spec.ts:85,113`, `tests/e2e/tab-dirty-preattach.spec.ts:67`) all
select the `.dot` child, which this fix does not remove or rename.

## Fix

`src/client/tabs/TabItem.svelte`:
- `:264` — `aria-label={dirty ? \`${tab.fileName}, unsaved changes\` : tab.fileName}`.
- Simplify the indicator wrapper: `aria-hidden="true"` unconditionally — the dot/check glyphs
  become purely decorative now that the tab's own `aria-label` carries the state.
- Leave `{:else if justSaved}` (the `✓` flash) untouched — a transient reassurance, not a state,
  and its right treatment is a separate decision (#798). `justSaved` does not feed the new
  `aria-label`.

## Tests

Extend `tests/client/TabItem.svelte.test.ts` (its existing `mount()` harness):
- Add `tabAriaLabel: () => tabPill()?.getAttribute("aria-label") ?? null` (querying
  `[data-testid="tab-{id}"]`, the tab row — not the indicator span).
- Dirty (`syncContent` + `setMirror(ydoc, true)` + `afterArm()`) → `tabAriaLabel()` matches
  `/unsaved changes/i`.
- Saved (`setMirror(ydoc, false)`) → `tabAriaLabel()` equals the plain `tab.fileName`.
- `indicator()?.getAttribute("aria-hidden") === "true"` unconditionally (both states) — pins
  that the indicator itself is decorative-only, not the thing doing the announcing.

## Done when

The three new cases pass alongside C1–C8; no `data-testid` change (no snapshot regeneration
needed); `npm run typecheck` + `npm test` green.

## Not in scope

The `✓` save-confirmation flash (#798).

## Review corrections (scope cut)

No blocking findings remain against this spec — the fix already carries the dirty state in the
tab's own `aria-label` (not a sibling sr-only span, which would be inert on an element with an
explicit `aria-label`), and the tests already assert on that `aria-label` rather than the
indicator's `textContent` (a `textContent` equality check would always fail: the dot glyph shares
the wrapper and the ternary predates this cut). Condensed the prior round's "here's why Option 2
was wrong" narration into the Problem section as a stated fact rather than a correction history.
No mechanism removed.
