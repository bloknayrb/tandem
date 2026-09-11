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
- **`docs/troubleshooting.md:76` "Tauri app"** — the bullet's other half (alongside the SKILL.md
  wording, filed as #1961) is already gone: `grep -n 'Tauri app' docs/troubleshooting.md` returns
  no match on current master. Fixed by an earlier wave; not re-touched here.
- **`EmptyState.svelte` internal CLI hints** — the issue's "Internal vocabulary in Settings /
  About / EmptyState / toasts" bullet names this file, but its only `tandem`-CLI-shaped text is in
  comments (`:14`, `:160`); the visible copy (`empty-state-setup-claude`,
  `empty-state-setup-restart-anyway`) never names the CLI. The Settings/About/toasts half of the
  same bullet is item N below. No change needed here.

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
- **Three window-level Escape owners (palette / Toolbar / SettingsModal) compete.** Coordination
  already exists and is deliberate, not accidental: `src/client/utils/escape-owner.ts`
  (`escapeIsClaimed`/`ESCAPE_OWNER_ATTR`) lets a nested popover win against a capture-phase
  ancestor listener, and `SettingsModal.svelte`'s Escape handler is registered on `document` (not
  `window`) specifically so it intercepts, per its own comment, "BEFORE other window-level
  handlers (e.g. command palette, find/replace bar) react to the same Escape." The one gap was the
  reverse direction — the palette opening *over* an already-open Settings modal, at which point
  its window-capture Escape listener (`CommandPalette.svelte:286-293`, unconditional on `open`,
  no focus check) would out-race SettingsModal's document-bubble one — and that is exactly what
  item I below closes, in this same PR, by refusing to open the palette while
  `settingsModalOpen`. Toolbar's selection popup is not reachable at all while Settings is open:
  `SettingsModal.svelte:617-618` renders a full-viewport `position: fixed` scrim
  (`settings-modal-scrim`) over the editor and the modal's focus trap keeps keyboard focus inside
  it, so there is no way to select editor text (the popup's only trigger) while it is up. With
  item I landing here, the three named surfaces cannot be simultaneously reachable, so there is no
  live three-way race left to fix. No change.
- **Item J — `focus-trap.ts:27-33` skips `position: fixed` descendants.** Refuted, not fixed:
  `focusablesWithin` has exactly two callers (`focus-trap.ts:49` via `trapTab`, and
  `SettingsModal.svelte:355`), always scoped to a trapped dialog container. Every `position:
  fixed` element under any of those containers is either the scrim or the dialog box itself
  (`SettingsModal.svelte:618,830`, `HelpModal.svelte:177`, `IntegrationWizardModal.svelte:1408`,
  `CoworkAdminDeclinedModal.svelte:262,276`, `LicenseWall.svelte:132`, `ModelEditModal.svelte:327`)
  — every descendant of a fixed ancestor already has that ancestor as its `offsetParent`, so the
  existing filter already includes it; `CoworkAdminDeclinedModal.svelte:137`'s `.cad-toast` is
  fixed but sits outside `modalEl` (`:171`) and holds no focusable. The proposed filter change
  (`el.offsetParent !== null || getComputedStyle(el).position === "fixed"`) would also **re-admit
  hidden fixed elements**: the docblock at `focus-trap.ts:29` names `offsetParent === null` as
  what "catches `display:none` and detached subtrees," and `getComputedStyle(el).position` on a
  `display:none` element still reports `"fixed"` (position is not layout-resolved), so the change
  would let `trapTab`'s wrap/recover branches try to `.focus()` an unfocusable node. No known
  defect instance, a real regression vector, and no test at any level distinguishes the fix from a
  no-op — `focus-trap.ts` is unchanged in this PR.

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

Schema-only safety today, unpinned. **Not `tests/client/plain-paste.test.ts`** — that file drives
`buildPlainTextSlice` (the *plain-text* paste builder) with a bare string against a 3-node toy
schema; it never parses HTML, so pasting `<img src=x onerror=alert(1)>` through it just yields a
paragraph whose text content is that literal string and proves nothing about sanitization. The
real surfaces are `editor-props.ts:63-66`'s HTML paste path and `image-src-safety.ts`, over the
**real** editor schema (`Image.configure({ allowBase64: true })` at `editor-extensions.ts:407` —
an image node exists, so the `onerror` drop is a genuine parse-time claim; the link extension's
`isAllowedUri`, `editor-extensions.ts:380-382`, blanks disallowed hrefs at **renderHTML**, per its
own docblock at `:51`).

Add `tests/client/paste-sanitize.test.ts`: build the real schema (`getSchema(editorExtensions)`
or an `Editor` instance's `.schema`), parse `<img src=x onerror=alert(1)>` and
`<a href="javascript:alert(1)">` with `DOMParser.fromSchema(schema).parseSlice(...)` (via
`domFromHtml` / `happy-dom`), and assert against the **serialized** result
(`DOMSerializer.fromSchema(schema).serializeFragment(...)`) — no `onerror` attribute on the
emitted node, no `javascript:` value on an emitted `href` — never against the markup string. State
in the test (and the PR body) which layer each assertion pins: the `onerror` case is a parse-time
attribute drop (schema-level), the `javascript:` case is a render-time blank (`isAllowedUri`); if
the href instead survives in the parsed *model* and is only blanked at `renderHTML`, assert on the
`DOMSerializer` output for that case specifically and say so in the PR body — that is still "no
`javascript:` href survives," just pinned one layer later than the parse-time case. No source
change.

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

Every "Fixed here" item lands with its own test; every "Answered, not fixed" item's reasoning is
in the PR body, with its issue number where one exists (#1960, #1961) and, for the Escape-owners
and item-J bullets (neither filed — refuted/covered-by-item-I in place, per the post-cut review),
the evidence enumerated above; every "Filed separately" item's number (#1963, #1964, #1965) is in
the PR body; every "Already done" item re-verified once at implementation time and not re-touched;
`npm run typecheck`, `npm test`, `npm run test:e2e` green; Critical Rule 7 snapshot untouched (no
selector renames in this batch); `focus-trap.ts` untouched (item J refuted, not fixed).

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

## Review corrections (post-cut)

Three findings from a second review pass, adopted directly against current master (no new
mechanism added):

- **Item J refuted, not fixed.** The proposed `focus-trap.ts` filter change had no named defect
  instance — every `position: fixed` element under any trapped dialog is the scrim or the dialog
  box itself, already covered because a fixed ancestor is its descendants' `offsetParent` — and it
  re-admits `display:none; position:fixed` elements into the tab order (`getComputedStyle(...)
  .position` reports `"fixed"` on a hidden element too, unlike `offsetParent`), which is a live
  regression vector with no test at any level to catch it. Item J is removed from "Fixed here" and
  moved into "Answered, not fixed" with the full container enumeration.
  `src/client/utils/focus-trap.ts` is untouched by this PR.
- **The "Three window-level Escape owners… compete" bullet was unaccounted.** It is a literal
  bullet in #1824's body that matched none of the spec's four buckets. Recorded now under
  "Answered, not fixed": the existing `escape-owner.ts` claim mechanism plus SettingsModal's
  deliberately-ordered `document`-level (not `window`-level) Escape handler already arbitrate the
  named surfaces, and the one live gap — the palette opening over an already-open Settings modal —
  is closed by item I in this same PR; Toolbar's selection popup is unreachable while Settings is
  open (full-viewport scrim + focus trap block editor selection). Two more sub-bullets of the same
  issue-body line the spec had silently dropped are recorded too, both already N/A on master:
  `docs/troubleshooting.md`'s "Tauri app" text is gone (grep confirms no match), and
  `EmptyState.svelte`'s only `tandem`-CLI-shaped text is in source comments, never visible copy.
- **Item E's host file was wrong.** `tests/client/plain-paste.test.ts` drives the *plain-text*
  paste builder (`buildPlainTextSlice`) with a bare string against a 3-node toy schema — it never
  parses HTML, so the originally-specified assertion couldn't exercise the sanitizer at all. Item
  E now specifies a new `tests/client/paste-sanitize.test.ts` built on the real editor schema, with
  `DOMParser.fromSchema(...).parseSlice(...)` in and `DOMSerializer` out, asserting against the
  parsed/serialized model rather than the markup string, and naming which layer (parse-time schema
  drop vs. render-time `isAllowedUri` blank) each assertion pins.

No item moved between "Filed separately" and "Fixed here"; the three already-filed issue numbers
(#1963, #1964, #1965) and the two already-filed "Answered, not fixed" numbers (#1960, #1961) are
unchanged. No new issue was filed by this pass — the one candidate (the Escape-owners bullet) had
a direct, evidenced answer instead.
