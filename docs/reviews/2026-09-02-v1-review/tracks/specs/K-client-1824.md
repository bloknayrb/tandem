# K-client — #1824 Lows batch, client (v1 review): editor, UI, a11y and product copy

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. **This PR does NOT close #1824** —
three items (below, filed separately) are cut from this PR's scope because each is a
cross-cutting mechanism (a new module, a pinned-test-contract migration, a hook-arity change)
rather than a same-file fix, which is what grew this spec past review three times running. PR
body: `Refs #1824`, naming what remains. Ledger rows:
`docs/reviews/2026-09-02-v1-review/areas/client-editor.md:26`, `client-ui.md:22-24`,
`product.md:26`.

## Already done (verified against current master, not re-touched)

- **`useRadioGroup.ts` dead / untested (#1778).** Fixed in `e7606afb` (#1915).
- **CLI hints for the channel-shim push path (#1817).** `IntegrationWizardModal.svelte:1190-1206`
  already branches on `isTauriRuntime()`. Item N below is a *different* surface
  (`SettingsAboutTab.svelte`).
- **LicenseWall read-only chat copy.** Already correct; `LicenseWall.svelte`'s docblock (`:9-24`)
  narrates the fix. No recent commit touches it — filed against a stale read.

## Answered, not fixed

- **macOS Option+[/] `[inferred]`** — the reviewer's own confidence marker, not a product-doc
  claim. Documented as deliberate. No change.
- **Chat seen-state shared via the ctrl room across windows** — matches CLAUDE.md's documented
  Solo/Tandem scoping (per-account, not per-window, deliberately durable). A product decision,
  not a Low. **Filed as #1960.**
- **`useFirstRunNeeded` fetch-failure skip / version-keyed dismissal** — both intentional per the
  hook's own docblocks. No change.
- **DocumentHealth panel "No analysis available."** — dev-only visual-smoke registry
  (`svelte-harness/registry.ts`), not uniquely dead among ~30 siblings there. No change.
- **`skills/tandem/SKILL.md:159` "the Tauri app"** — real gap, but outside this group's ownership
  (`skill=false`, and the file's own version/hash pair spans two test sites, not one). **Filed as
  #1961.**

## Filed separately (cut from this PR — see header)

- **Item A — active-annotation pulse lost on decoration rebuild** (`Editor.svelte` `$effect`
  depends only on `activeAnnotationId`/`editor`, missing a y-sync/annotation-plugin rebuild).
  Needs a new `decoRevision` counter + predicate module, not a same-file fix. **Filed as #1963.**
- **Item K — Settings radiogroups stay arrow-navigable while read-only** (extends #1722; the
  `isDisabled` getter fix is small, but it requires migrating three pinned CASES in
  `tests/client/settings-readonly-ui.test.ts` from asserting native `.disabled` to
  `aria-disabled`). **Filed as #1964.**
- **Item M — Tutorial step 2 has no chat-only advance branch** (needs a `createTutorial` arity
  change, 3 getters → 4, rippling through its App.svelte wiring and its one test caller). **Filed
  as #1965.**

## Fixed here

### B — `isSlashMenuSuppressed` runs `querySelector` on every transaction

`src/client/editor/slash-menu/extension.ts`'s plugin `apply()` calls
`resolveActiveSlashCommand` (and its ~10 DOM probes) unconditionally. Hoist the existing discard
condition (`!value.active && !isTypedInsertionAtCaret(tr)`) to an early return **placed
immediately after** the existing `applySlashCommandMeta` meta-check (not before it — a meta
transaction can arrive while `value.active` is `null` and must not be swallowed). When the menu
is active, keep calling it unconditionally (menu-closes-on-caret-leave behavior unchanged).
**Test:** extend `tests/client/slash-command.test.ts` with a meta-carrying transaction while
inactive/non-typed; assert the meta-driven state still wins (pins the ordering).

### C — Ctrl+N/W/T documented unconditionally, but browser-reserved

`OnboardingTutorial.svelte`'s `BASE_STEPS[2]` unconditionally says "Ctrl+N"; gate on
`isTauriRuntime()`: keep "Ctrl+N" in the desktop build, say "the + button in the tab bar" in the
browser build (matching `user-guide.md:426`'s existing caveat). `README.md:104` gets the same
one-line caveat. `HelpModal.svelte` needs no change (reads the live keybinding registry).
**Test:** extend the tutorial component test with `isTauriRuntime` stubbed `false`, assert step-2
copy names the + button, not Ctrl+N. `README.md` verified by direct diff read in the PR body.

### D — Reject vs. Dismiss inconsistency

Visible button text says "Reject" while every internal identifier and the native right-click
menu (`src-tauri/src/context_menu.rs:385`, read-only reference — not edited, out of this group's
tree) say "Dismiss". Align the client text to "Dismiss"/"Dismiss All":
`BulkActions.svelte:51,86`, `AnnotationCardActions.svelte:88`. Same-commit docs sweep:
`user-guide.md` (~:283) and `README.md:118`. Screenshot recapture (`03-side-panel.png`) already
filed as **#1962** — not redone here. **Test:** render `BulkActions`/`AnnotationCardActions`,
assert `getByText(/Dismiss/)` exists and `queryByText(/^Reject/)` is `null`.

### E — No paste-sanitizer regression test

Schema-only safety today, unpinned. Add a test to `tests/client/plain-paste.test.ts` (or a new
sibling) pasting `<img src=x onerror=alert(1)>` and `<a href="javascript:alert(1)">`, asserting
neither `onerror` nor a `javascript:` href survives. No source change.

### F — Command palette shortcut rows discard the opener on Enter

`CommandPalette.svelte`'s `runResult` unconditionally clears `opener` before the kind-specific
branches; `"shortcut"` has none (display-only). Add `if (result.kind === "shortcut") return;` as
the **first** line of `runResult`. **Test:** open the palette from a focused trigger, highlight a
shortcut row, Enter, Escape, assert focus returns to the trigger.

### G — Filter toggle has no `aria-expanded`; filters persist across doc switch

`SidePanel.svelte`'s `filter-bar-toggle` button gets `aria-expanded={filterBarOpen}`. Separately:
add a **second, independent** `$effect` reading only `documentId` (never the filter values) that
resets `filterType`/`filterAuthor`/`filterStatus` to `"all"`. Do **not** extend the existing
"reset bulk confirm" effect — it deliberately reads all three filters as dependencies (#1772), so
writing them there makes it self-dependent and the filter bar permanently unsettable. **Test:**
(1) set a non-`"all"` filter, re-render with the same `documentId`, assert it survives; (2)
change `documentId`, assert all three read back `"all"`; (3) `aria-expanded` tracks
`filterBarOpen`.

### H — Bulk tab close: Cancel on tab 2 doesn't abort tabs 3–5

`closeTabAndRecord` returns `void`; the three loop functions (`closeOtherTabs`/
`closeTabsToLeft`/`closeTabsToRight`) have no `break`, so Cancelling one dirty tab still prompts
for the rest. Change `closeTabAndRecord` to return `boolean` (`true` = closed, `false` =
cancelled); each loop becomes `for (const id of ...) { if (!closeTabAndRecord(id)) break; }`.
Cancel **aborts the rest of the batch** (not skip-and-continue). Update the interface decl in
`useDocumentWorkspace.svelte.ts`; the bare-call sites (`App.svelte:937,1498,2670`) need no change
(a function returning `boolean` is assignable where `void` was expected). **Test:** a
confirm-stub returning `false` on the 2nd of 3 dirty tabs; assert it was called exactly twice and
only the first tab closed.

### I — Palette can stack over an open Settings modal (same class as #1713)

`App.svelte`'s `"toggle-palette"` handler has no guard against `settingsModalOpen`. Guard the
*open* path only (closing an already-open palette still works regardless):
`if (!untrack(() => paletteOpen) && settingsModalOpen) return;` before toggling. Extend the
existing `popupSuppressed` expression (`slashCommandMenuOpen || findBarOpen || paletteOpen`) to
also include `settingsModalOpen`. **Test:** same structural-assertion approach as
`K-client-1713.md` (no runtime harness mounts `App.svelte`) — assert Ctrl+Shift+P is a no-op
while `settingsModalOpen` is true, and `popupSuppressed` reads true once it is.

### J — `focus-trap.ts` skips `position: fixed` descendants

`focusablesWithin` filters on `el.offsetParent !== null`, which is `null` by spec for
`position: fixed` elements. Change the filter to
`el.offsetParent !== null || getComputedStyle(el).position === "fixed"` — reusing the exact idiom
`tests/e2e/forced-colors.spec.ts:193` already proves in real Chromium (not `getClientRects()`,
which happy-dom fakes as unconditionally non-empty). **No unit test**: both
`tests/client/focus-trap.test.ts` and `dialog-focus-trap.test.ts` run under happy-dom, which
doesn't implement `offsetParent` at all — every form of this fix is equally unpinnable there.
Verified by reading + this group's `test:e2e` run only; stated explicitly, not a silent gap.

### L — ErrorBoundary shows a raw error with no saved/unsaved reassurance

`ErrorBoundary.svelte`'s `failed` snippet shows `error.message` with no data-loss reassurance.
Add a **second, separate** `<p>` between the existing message paragraph and `<pre
class="detail">`: "Your document is synced to the server, so this doesn't affect your saved
work." **Test:** render the `failed` snippet, assert the new paragraph exists between the two.

### N — Internal CLI vocabulary in the desktop app (`SettingsAboutTab.svelte`)

Three toast messages unconditionally say "try `tandem doctor` in a terminal" — the desktop app
has no `tandem` command (per #1817's own precedent). Gate on `isTauriRuntime()` (already
imported): desktop branch points at "Open Log Folder" (`handleOpenLogFolder`, same tab);
non-Tauri branch keeps the existing wording. **Test:** stub `isTauriRuntime` true/false, trigger
each toast, assert desktop mentions "Open Log Folder" and never "tandem doctor".

## Done when

Every "Fixed here" item lands with its own test (item J excepted, stated above); every "Answered,
not fixed" item's reasoning is in the PR body with its issue number (#1960, #1961); every "Filed
separately" item's number (#1963, #1964, #1965) is in the PR body; every "Already done" item
re-verified once at implementation time and not re-touched; `npm run typecheck`, `npm test`,
`npm run test:e2e` green; Critical Rule 7 snapshot untouched (no selector renames in this batch).

## Not in scope

#1722's rail-toggle root cause itself (item K, now filed as #1964, only extends it). The Cowork
three-confirmation consolidation (#1727 — Refs only, see `K-client-1727.md`). Any
`src-tauri/src/**` change (item D reads the Rust label for context only). `skills/tandem/SKILL.md`
(#1961). Chat seen-state per-window scoping (#1960). Recapturing
`docs/screenshots/03-side-panel.png` (#1962). New CI gates, drift guards or frozen lists for any
of the above — each fix's own test is the guard.

## Review corrections (scope cut)

**Removed from this PR's scope (not repaired — split to new issues instead):**
- Item A (`decoRevision` counter + new predicate module `deco-revision.ts`) — a new mechanism,
  not a same-file fix. Filed as #1963.
- Item K (readOnly getter + native-`disabled`→`aria-disabled` swap, requiring a same-commit
  migration of three pinned CASES in `tests/client/settings-readonly-ui.test.ts`) — the most
  contract-invasive item in the batch. Filed as #1964.
- Item M (`createTutorial` arity change, 3 getters → 4, rippling through App.svelte wiring and
  its one test caller) — a hook-signature change, not a same-file fix. Filed as #1965.
- Item O (SKILL.md wording) was already out of scope (`skill=false`) — confirmed still filed as
  #1961, not re-added here.

**Kept, with round-1's corrections folded in directly (no longer narrated as history):** items
B, C, D, E, F, G, H, I, J, L, N are each single-file-or-textual fixes with a named test (J
excepted, stated). G's separate-effect fix, H's `boolean`-return + caller audit, I's
`untrack`-guarded open, and J's real-Chromium-proven filter are stated as *the* fix, not as
corrections to a prior wrong draft — the prior essay-length "originally X, corrected to Y"
sections added ~250 lines of narration with no remaining technical content once the corrected
form is the only form shipped.

**Consequence:** this PR now Refs #1824 rather than closing it, per the group's own "cross-check
Closes against your own notes" rule — three bullets remain open under #1963/#1964/#1965 in
addition to the two already-filed #1960/#1961 and the already-filed screenshot #1962.
