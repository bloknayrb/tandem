# K-client — #1544 Tab unsaved indicator's only content is `aria-hidden`

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1544. No area-ledger row
(filed standalone). Probe: mount a dirty tab and assert the indicator carries a text node a
screen reader can reach.

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
unchanged on current master. No E2E or unit test references `unsaved-indicator` today
(`grep unsaved-indicator tests/` hits only the testid snapshot), so nothing regresses by fixing
this and nothing was pinning the broken state either.

## Fix

Reuse the codebase's existing visually-hidden recipe rather than inventing a new one —
`SR_ONLY_STYLE` in `src/client/components/live-region.ts` (an inline `style` string, deliberately
not a CSS class per its own docblock: it must never cross the lightningcss pipeline, matching this
group's "two CSS pipelines" gotcha). This is the issue's own Option 2 ("visually-hidden text, drop
the `aria-hidden` toggle on the wrapper") — picked over Option 1 (changing `tab.fileName`'s
`aria-label` to append "(unsaved)") because it is the smaller, more isolated diff: it touches only
the indicator span the bug lives in, not the tab row's own label (read by other consumers), and it
keeps the tab's accessible name stable rather than chatty on every dirty/clean flip, which the
issue itself flags as a downside of Option 1.

`src/client/tabs/TabItem.svelte`:
- Import `SR_ONLY_STYLE` from `../components/live-region`.
- Drop `aria-hidden={!dirty}` from the wrapper `<span>` entirely — with no toggle, the wrapper is
  simply present-but-empty when neither `dirty` nor `justSaved`, which is harmless (an empty span
  announces nothing regardless of `aria-hidden`).
- Inside the `{#if dirty}` branch, add a sibling `<span style={SR_ONLY_STYLE}>Unsaved changes</span>`
  after the existing `aria-hidden="true"` dot glyph.
- Leave the `{:else if justSaved}` branch (the `✓` flash) untouched — the issue explicitly notes it
  is "arguably the case where announcing IS unwanted" (a transient reassurance, not a state) and
  should be decided together with #798 rather than folded into this fix.

## Tests

Extend the existing `tests/client/TabItem.svelte.test.ts` (already built for #1447's dot, with a
`mount()` harness exposing `hasDot()`/`hasCheck()` off a `[data-testid="unsaved-indicator-{id}"]`
query, `syncContent()` + `setMirror()` to drive the dirty state, and `afterArm()` to wait past the
arm window) rather than inventing a new render pattern:

- Add `hasSrText: () => (indicator()?.textContent ?? "").trim() === "Unsaved changes"` to the
  `mount()` return, alongside the existing `hasDot`/`hasCheck`.
- New `describe("TabItem unsaved dot — a11y announcement (#1544)")`:
  1. Drive the tab dirty (`syncContent` + `setMirror(ydoc, true)` + `afterArm()`, mirroring C1) and
     assert `hasSrText()` is `true` — kills a fix that puts the visually-hidden text in the wrong
     branch or leaves the outer `aria-hidden` toggle in place (which would still hide it from the
     accessibility tree even with the text node present, since `textContent` reads DOM text
     regardless of `aria-hidden` — so this alone doesn't distinguish that failure; pair it with an
     explicit check that the wrapper span carries no `aria-hidden` attribute at all).
  2. Same setup then `setMirror(ydoc, false)` (a save, mirroring C6) and assert `hasSrText()` is
     `false` — kills a fix that always renders the text regardless of dirty state.

## Done when

The two new cases pass alongside the existing C1–C8 suite; `data-testid` `unsaved-indicator-{*}`
is unchanged (Critical Rule 7 — no snapshot regeneration needed, since no selector is added,
renamed or removed); `npm run typecheck` and `npm test` green.

## Not in scope

The `✓` save-confirmation flash (#798) — left as-is per the issue's own note that its right
treatment is a separate design decision. No change to `tab.fileName`'s `aria-label`.
