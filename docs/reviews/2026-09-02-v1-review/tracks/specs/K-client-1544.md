# K-client — #1544 Tab unsaved indicator's only content is `aria-hidden`

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1544. No area-ledger row
(filed standalone). Probe: mount a dirty tab and assert the tab's own accessible name changes to
reflect it — not the indicator's DOM text.

## Problem

`src/client/tabs/TabItem.svelte:264` gives the tab row `aria-label={tab.fileName}` — no dirty
state. The unsaved indicator itself (`:271-281`):

```svelte
<span data-testid={`unsaved-indicator-${tab.id}`} class="save-indicator" aria-hidden={!dirty}>
  {#if dirty}
    <span class="dot" aria-hidden="true">●</span>
  {:else if justSaved}
    <span class="saved-check" aria-hidden="true">✓</span>
  {/if}
</span>
```

toggles the wrapper's `aria-hidden` to `false` when dirty, but its only child is itself
`aria-hidden="true"` — unhiding an element with no accessible content announces nothing. Verified
unchanged on current master. Existing references to `unsaved-indicator` are
`tests/client/TabItem.svelte.test.ts:68`, `tests/e2e/open-does-not-dirty.spec.ts:85,113`, and
`tests/e2e/tab-dirty-preattach.spec.ts:67` — all three select the `.dot` child, which this fix
does not remove or rename, so none of them regress.

**Round-1 review correction:** the fix below no longer routes the announcement through a
visually-hidden span inside the indicator. `role="tab"` gives the whole tab row an explicit
`aria-label`, and per the accname computation an explicit `aria-label` **overrides all descendant
content** — a sibling sr-only span inside that same element would never reach the accessible-name
computation at all, so it would land, pass a same-shaped test, and leave the reported defect
exactly as it is. The tab's own `aria-label` is the only channel that actually reaches assistive
tech here, so the state has to be carried there.

## Fix

Carry the dirty state in the tab's own accessible name, the issue's Option 1, reversing this
spec's original preference for Option 2 (see "Review corrections" below for why Option 2 doesn't
work on this element):

`src/client/tabs/TabItem.svelte`:
- `:264` — change `aria-label={tab.fileName}` to
  `aria-label={dirty ? \`${tab.fileName}, unsaved changes\` : tab.fileName}`.
- Simplify the indicator wrapper now that it carries no accessibility burden of its own: change
  `aria-hidden={!dirty}` to a constant `aria-hidden="true"` — the dot/check glyphs become purely
  decorative (the real announcement is the tab's `aria-label`), which is also a smaller diff than
  adding a new sibling span and a `SR_ONLY_STYLE` import.
- Leave the `{:else if justSaved}` branch (the `✓` flash) untouched — the issue explicitly notes
  it is "arguably the case where announcing IS unwanted" (a transient reassurance, not a state)
  and should be decided together with #798 rather than folded into this fix. `justSaved` does not
  feed the new `aria-label` expression.

## Tests

Extend the existing `tests/client/TabItem.svelte.test.ts` (already built for #1447's dot, with a
`mount()` harness exposing `hasDot()`/`hasCheck()` off a `[data-testid="unsaved-indicator-{id}"]`
query, plus a way to reach the tab row itself for its `aria-label`; `syncContent()` + `setMirror()`
drive the dirty state, `afterArm()` waits past the arm window) rather than inventing a new render
pattern:

- Add `tabAriaLabel: () => tabPill()?.getAttribute("aria-label") ?? null` to the `mount()` return
  (querying `[data-testid="tab-{id}"]`, the tab row itself — not the indicator span).
- New `describe("TabItem unsaved dot — a11y announcement (#1544)")`:
  1. Drive the tab dirty (`syncContent` + `setMirror(ydoc, true)` + `afterArm()`, mirroring C1) and
     assert `tabAriaLabel()` matches `/unsaved changes/i` — kills a fix that puts the state
     anywhere but the tab's own accessible name.
  2. Same setup then `setMirror(ydoc, false)` (a save, mirroring C6) and assert `tabAriaLabel()`
     equals the plain `tab.fileName` again — kills a fix that always announces the state
     regardless of dirty state.
  3. Assert `indicator()?.getAttribute("aria-hidden") === "true"` unconditionally (both dirty and
     clean) — pins that the indicator span stays decorative-only and isn't the thing doing the
     announcing.

## Done when

The three new cases pass alongside the existing C1–C8 suite; `data-testid` `unsaved-indicator-{*}`
is unchanged (Critical Rule 7 — no snapshot regeneration needed, since no selector is added,
renamed or removed); `npm run typecheck` and `npm test` green.

## Not in scope

The `✓` save-confirmation flash (#798) — left as-is per the issue's own note that its right
treatment is a separate design decision.

## Review corrections (round 1)

**Adopted:**
- Rewrote the Fix from Option 2 (visually-hidden sibling span) to Option 1 (the tab's own
  `aria-label` carries dirty state) — an explicit `aria-label` on `role="tab"` overrides all
  descendant content per the accname computation, so the sibling-span approach was inert by
  construction. This also drops the `SR_ONLY_STYLE` import and simplifies the wrapper to a
  constant `aria-hidden="true"`, a smaller diff than originally proposed.
- Rewrote the Tests section to assert on the tab's `aria-label` rather than the indicator's
  `textContent`. The original `hasSrText` assertion (`textContent === "Unsaved changes"`) could
  never pass even with a correct implementation of the old approach, because the dot glyph
  (`<span class="dot" aria-hidden="true">●</span>`) shares the same wrapper and contributes to
  `textContent` — the equality would read `"●Unsaved changes"` and always fail.
- Corrected the false claim that no test references `unsaved-indicator` today — three test files
  do, all via the `.dot` child selector, which this fix's revised approach leaves untouched.

**Not adopted:** none — every finding against this spec pointed at the same underlying defect
(Option 2 doesn't reach the accessible-name computation) and is resolved by switching to Option 1.
