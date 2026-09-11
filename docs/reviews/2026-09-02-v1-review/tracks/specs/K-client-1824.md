# K-client — #1824 Lows batch, client (v1 review): editor, UI, a11y and product copy

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. This PR **closes #1824** only if
every un-cross-referenced bullet below is fixed or recorded as refuted-with-evidence — verified
bullet by bullet against current master, not against the 2026-09-02 filing. Ledger rows:
`docs/reviews/2026-09-02-v1-review/areas/client-editor.md:26`, `client-ui.md:22-24`, `product.md:26`.
No dedicated probe script; each sub-item below carries its own discriminating test or an explicit
note of why none applies.

Wave-table note honoured: bullets carrying their own `(#NNNN)` are NOT this group's (already
shipped by that issue's own PR) — recorded below as **already done**, with the commit/evidence
that closed them, not re-fixed.

## Already done (verify, don't re-fix)

- **`hooks/useRadioGroup.ts` dead / `useRadioGroup.svelte.ts` untested (#1778).** Fixed in
  `e7606afb` (#1915): `hooks/useRadioGroup.ts` no longer exists in the tree; `tests/client/
  useRadioGroup.test.ts`'s own docblock records the retarget. Confirmed via
  `find src/client -iname useRadioGroup*` (only `.svelte.ts` remains) and the test file importing
  `createRadioGroup` from it.
- **`tandem …` CLI hints inside the desktop app for the channel-shim push path (#1817).**
  `src/client/components/IntegrationWizardModal.svelte:1190-1206` already branches on
  `isTauriRuntime()` and names the `npm install -g tandem-editor@latest` step before the `tandem
  setup --apply` command, with a comment citing #1817 by number. This group's remaining CLI-hint
  fix (below, item N) is a DIFFERENT surface (`SettingsAboutTab.svelte`'s diagnostics/clipboard
  errors), which #1817's PR did not touch.
- **LicenseWall promises read-only chat (extends #1521).** `src/client/components/LicenseWall.svelte`
  already carries a "Continue in read-only mode" dismiss button and a docblock (`:9-24`)
  explicitly narrating the fix: the old copy ("you can still read and export them, and chat with
  Claude") was falsified by the full-bleed scrim covering the chat rail, so dismissing steps the
  user into read-only mode instead. No recent commit touches this file (last change predates this
  sweep) — it was already correct when #1824 was filed against a stale read.

## Answered, not fixed (recorded with reasoning, per the wave-4 G5′ precedent)

- **macOS Option+[ / ] claimed `[inferred]`.** The `[inferred]` tag in
  `docs/reviews/2026-09-02-v1-review/raw/findings-client-editor.txt:72` is the REVIEWER's own
  confidence marker on their finding, not a claim in the product's user-facing docs. The finding's
  own text says the `Alt+[`/`Alt+]` → `e.code` binding intercepting macOS's Option-produced
  typographic quotes is "documented as a deliberate choice; recorded so the trade-off is explicit
  in the review." No code or doc changes it.
- **Chat seen-state shared via the ctrl room across windows (`useChatState.svelte.ts:45-71`).**
  `seenIds` derives from `Y_MAP_CHAT_SEEN` on the ctrl-room `Y.Doc`, which is genuinely shared
  across every window on the same account/server — matching the issue's own read. This is the SAME
  scoping CLAUDE.md already documents as deliberate for Solo/Tandem mode ("Solo/Tandem mode lives
  in `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS`... not per-document; changes broadcast to all open
  documents"). Making seen-state per-window would need a new per-window identity concept this
  codebase doesn't have (awareness is ephemeral and per-client already, but "seen" is deliberately
  durable so it survives a reload) — a product decision, not a Low-sized bug fix. **Filed as
  #1960** (round-1 review correction — this bullet carried no tracked home before; "flagged to
  Bryan" alone is not a filed deferral, and closing #1824 without one would violate the group's own
  "NO UNFILED DEFERRALS" rule). Referenced, not fixed, here.
- **`useFirstRunNeeded` fetch failure = wizard silently skipped; dismissal keyed per version.**
  Both halves are explicitly intentional per the hook's own docblocks (`useFirstRunNeeded.svelte.ts`):
  "Intentional: server-unreachable/malformed-JSON → wizard does NOT auto-open... Don't 'fix' this
  by flipping the default," and "Server version... wizard dismissal is keyed on this." No change.
- **DocumentHealth panel copy "No analysis available."** `DocumentHealth.svelte` is registered only
  in `src/client/svelte-harness/registry.ts`, a dev-only visual-smoke-test registry that lists ~30
  other components the same way (`registry.ts:1-9`'s own docblock: "Components may require props...
  the harness renders components without props, for visual smoke-testing only"). It is not
  uniquely dead among its siblings; no change.
- **`skills/tandem/SKILL.md:159` says "the Tauri app".** Real gap, confirmed unchanged on current
  master (`version: 21`, line 159 still reads "Start the Tauri app or run `tandem start`"). **Out
  of this group's reach**: this group's flags are `skill=false` and its COORDINATION ownership is
  `src/client/**`, `tests/client/**`, `tests/design-system-impl/**`, the testid snapshot and
  `docs/design-system-impl/` — `skills/tandem/SKILL.md` and
  `tests/skill-instruction-contract.test.ts` (whose version+hash pair the edit must update
  together, per the Hard Rules) are outside that. **Filed as #1961** rather than done here (round-1
  review correction — the original spec put this in "Fixed here" as item O, which both crosses
  ownership and undercounted the literals that must move together: it named only two of the three
  pinned sites — the `bodyHash`/`version` pair at `tests/skill-instruction-contract.test.ts:430`
  AND a separate `version: 21` regex at `:109` inside a different assertion,
  `expectPerSessionAutoArmContract`).

## Fixed here

Each item names its file(s), the exact change, the CLAUDE.md rule it touches (if any), and a
concrete discriminating test or an explicit note of why none applies.

### A — Active-annotation pulse class lost on decoration rebuild (`Editor.svelte:~286-301`)

The `$effect` re-applying `.tandem-annotation-active` depends only on `activeAnnotationId` and
`editor`; a decoration rebuild (e.g. a #1669-style y-sync replacing the DOM) doesn't touch either,
so the class silently doesn't come back. Per CLAUDE.md's Tiptap gotcha ("Never write `$state`
synchronously from a Tiptap event handler — bridge through `createCoalescingTick`... `transaction`
subscribers are the exposed ones"): add a `decoRevision` counter bumped via `createCoalescingTick`
on the editor's `transaction` event, and make the class-application effect also read
`decoRevision` so it reapplies after every qualifying transaction — the effect is idempotent
(strip then reapply), so re-running it is cheap.

**Round-1 review correction:** bump `decoRevision` only on transactions that can actually rebuild
decorations — `tr.docChanged || tr.getMeta(ySyncPluginKey) || tr.getMeta(annotationPluginKey)`
(the exact set `annotation.ts`'s own decoration-rebuild logic reacts to, `:277-278, :347, :372`) —
not on every transaction unconditionally. Bumping on every transaction (including pure cursor
moves and remote awareness-only syncs) reintroduces per-transaction work in the same PR that item
B removes it; gating to the qualifying subset keeps the fix cheap without the tradeoff.

Extract the gate as a pure predicate so it's unit-testable without mounting a real Tiptap editor
(this repo's own vitest-probe gotcha: a Tiptap `Editor` with no `element` hangs the run under
vitest, so integration-testing the full effect here is the wrong instrument):

```ts
// src/client/editor/deco-revision.ts
export function shouldBumpDecoRevision(tr: {
  docChanged: boolean;
  getMeta: (key: unknown) => unknown;
}): boolean {
  return Boolean(tr.docChanged || tr.getMeta(ySyncPluginKey) || tr.getMeta(annotationPluginKey));
}
```

**Test:** new `tests/client/editor/deco-revision.test.ts` — pass synthetic transaction-shaped
objects (plain objects satisfying the narrow type above) and assert `true` for `docChanged: true`,
for a `getMeta` returning a value keyed on `ySyncPluginKey`, and for one keyed on
`annotationPluginKey`; assert `false` for a bare cursor-move shape (`docChanged: false`, `getMeta`
returning `undefined` for both keys). The full re-apply behavior (the effect actually reapplying
the class after a coalesced tick) is covered by this group's `npm run test:e2e` run, not a new
unit test, per the vitest-Tiptap hazard above.

### B — `isSlashMenuSuppressed` runs `querySelector` on every transaction

`src/client/editor/slash-menu/extension.ts`'s plugin `apply(tr, value, _oldState, newState)`
(`:292-309`, current master) calls `resolveActiveSlashCommand` — and therefore
`isSlashMenuSuppressed`'s ~10 `document.querySelector` probes — unconditionally on every
transaction, including pure cursor moves and remote CRDT syncs. The existing gate later in the
function already DISCARDS the result in exactly one case: `!value.active &&
!isTypedInsertionAtCaret(tr)`. Move that check earlier: when the menu is not currently active AND
this transaction is not a typed insertion at the caret, return `{ active: null, dismissedKey:
value.dismissedKey }` before calling `resolveActiveSlashCommand` at all — behaviour-preserving (the
discarded branch already produces this exact result today), and it skips the DOM probing on the
common "menu closed, unrelated transaction" case. When the menu IS active, keep calling it
unconditionally (the existing comment: "Once already open we keep re-deriving... so the menu
closes when the caret leaves" — this must not regress).

**Round-1 review correction — placement is load-bearing, not incidental:** the hoisted check MUST
be placed immediately AFTER the existing `const metaState = applySlashCommandMeta(tr, value); if
(metaState) return metaState;` lines (`apply`'s first two statements), never before them. A meta
transaction is not a typed insertion and can legitimately arrive while `value.active` is `null`; a
hoisted check placed ahead of the meta branch would swallow it.

**Test:** extend `tests/client/slash-command.test.ts` with a case that dispatches a transaction
carrying `applySlashCommandMeta`'s recognized meta while `value.active` is `null` and the
transaction is not a typed insertion at the caret, and asserts the meta-driven state still wins
(pins the ordering — a hoist placed one line too early reds this case). Regression net:
`tests/e2e/slash-command-menu.spec.ts` (existing spec, unmodified) via this group's `test:e2e` run.

### C — Ctrl+N/W/T documented unconditionally as working, but browser-reserved

`docs/user-guide.md:426` already carries the browser-reservation caveat (landed in `36341bf3`,
part of the #1821 docs-drift wave) — no change there. Two sites remain:
- `src/client/components/OnboardingTutorial.svelte`'s `BASE_STEPS[2]` ("edit") text unconditionally
  says "Open a tab or scratchpad with Ctrl+N" even though the component already computes
  `const tauri = isTauriRuntime();`. Gate the sentence: in the Tauri build keep "Ctrl+N"; in the
  browser build say "the + button in the tab bar" (matching `user-guide.md:426`'s own wording).
- `README.md:104` — "A scratchpad (`Ctrl+N`) for drafts you don't want to save to disk." Add the
  same one-line caveat used in `user-guide.md:426`, or a short parenthetical
  ("remappable in Settings → Shortcuts if your browser reserves it").
- `HelpModal.svelte` needs no change: it renders shortcuts from the live keybinding registry
  (`src/client/actions/keybindings.ts`, where `close-tab`/`new-tab-menu`/`new-scratchpad` are all
  user-remappable per ADR-041), so it already shows whatever the user actually has bound, not a
  static claim.

**Test:** extend `tests/client/OnboardingTutorial.svelte.test.ts` (or the nearest existing tutorial
component test) with a case rendering with `isTauriRuntime` stubbed `false` and asserting step 2's
copy names "the + button in the tab bar", not "Ctrl+N". The `README.md` line has no automated test
— it is prose, verified by direct diff read in the PR body, consistent with how this file's other
copy-only edits (e.g. item N's toast wording) are verified.

### D — `annotation-context-menu` / `BulkActions.svelte:51`: Reject vs. Dismiss inconsistency

The visible button text says "Reject"/"Reject All" (`BulkActions.svelte:51,86`;
`AnnotationCardActions.svelte:88`) while every internal identifier (`onDismiss`, `canDismiss`,
`handleDismissAnimated`, the `"Dismissed"` filter/toast label) and the NATIVE right-click context
menu (`src-tauri/src/context_menu.rs:385` — read-only reference, **not edited**: this group owns
`src/client/**`, not `src-tauri/src/**`, per COORDINATION) already say "Dismiss". Align the client
button text to "Dismiss"/"Dismiss All" rather than the reverse (renaming the Rust label is out of
this group's reach and out of scope): `BulkActions.svelte:51` (`{isAccept ? "Accept" : "Dismiss"}`),
`:86` ("Dismiss All"), `AnnotationCardActions.svelte:88`'s equivalent button. No `data-testid`
change (`bulk-confirm-btn` etc. are unaffected — only the text node). Confirmed no test asserts the
literal string "Reject" for annotation review (a repo-wide check found only Word's OWN
"Accept or Reject" terminology in `ApplyChangesButton.svelte:23`, describing Word's tracked-changes
UI — correctly left alone, since that names Word's vocabulary, not Tandem's).

**Round-1 addition — docs sweep, same commit:** the vocabulary change also touches two doc sites
that quote the old button text and would otherwise drift out of sync the same day the rename
lands: `docs/user-guide.md` (the margin-view section's "keep their Accept/Reject buttons" sentence,
near `:283`) and `README.md:118`'s "More screenshots" caption/alt text
("...with Accept and Reject buttons", "...accept the change, reject it, or reply..."). Update both
to say "Dismiss"/"dismiss it". The referenced screenshot pixels
(`docs/screenshots/03-side-panel.png`) still show the old label and are **not** recaptured in this
PR — filed as **#1962** (screenshot recapture needs the screenshots skill against a running build
with the rename in it, disproportionate to bundle into a text-label PR).

**Test:** a small assertion in `tests/client/` (e.g. render `BulkActions` and
`AnnotationCardActions` and assert `getByText(/Dismiss/)` exists and `queryByText(/^Reject/)` is
`null`) — pick whichever of these components already has a render-based test file and extend it,
per this repo's existing per-component test convention.

### E — No explicit paste sanitiser regression test

Schema-only safety today (`editor-props.ts:63-66`, ProseMirror schema + `image-src-safety.ts`) with
no test pinning it. Add one test to `tests/client/plain-paste.test.ts` (or a new
`tests/client/paste-sanitize.test.ts` alongside the four existing paste specs) that pastes HTML
containing `<img src=x onerror=alert(1)>` and `<a href="javascript:alert(1)">` and asserts the
resulting document has no `onerror` attribute and no `javascript:` href — following whatever paste
harness `link-paste.test.ts`/`markdown-paste.test.ts` already use (Tiptap's `clipboardTextParser`
path via a synthetic paste event or `editor.commands.insertContent` with `parseOptions:
{preserveWhitespace: false}` matching the existing suite's pattern).

**Test:** the new test file itself IS the discriminating test (this item already named one in the
original spec; unchanged).

### F — Command palette shortcut rows inert on Enter, discard the opener

`CommandPalette.svelte`'s `runResult` (`:335+`) unconditionally sets `opener = null` before the
kind-specific branches, but the `"shortcut"` kind has no branch (comment: "shortcut items:
display-only, no action on Enter") — so pressing Enter on a highlighted shortcut row silently
discards the focus-restore reference for no reason, and a later Escape/dismiss can no longer
return focus to whatever opened the palette. Add an early return: `if (result.kind === "shortcut")
return;` as the FIRST line of `runResult`, before `opener = null` — preserves "no action on Enter"
(display-only stays display-only) while fixing the actual defect (opener no longer discarded).

**Test:** extend `tests/client/CommandPalette.svelte.test.ts` (or the nearest existing palette
test) — open the palette from a focused trigger element, highlight a `"shortcut"`-kind result,
press Enter, close the palette via Escape, and assert focus returns to the original trigger
(kills a fix that still clears `opener` before the early return, or places the return after the
`opener = null` line).

### G — Filter toggle has no `aria-expanded`; filters persist across document switch

`SidePanel.svelte`'s `filter-bar-toggle` button (`:~738`) has no `aria-expanded` reflecting
`filterBarOpen`. Add `aria-expanded={filterBarOpen}`.

**Round-1 review correction — the filter-reset half was wrong and would have made the filter bar
permanently unusable.** The original spec said to extend the file's existing effect (`:~220-236`,
"Reset bulk confirm when the filters or the document change") to also reset
`filterType`/`filterAuthor`/`filterStatus` to `"all"`. That effect deliberately READS all three
filter values as tracked dependencies (its own comment: `// read filter state to establish
reactivity`) so it can clear `bulkConfirmRequested` on ANY filter change (the #1772 precedent).
Adding a write to those same three values inside it makes the effect self-dependent: the user
picks a filter → the effect re-runs (it reads the filter that just changed) → the effect
immediately writes it back to `"all"` → the filter can never be set. Silent failure, not a crash.

Corrected fix: add a **separate, second** `$effect` next to the existing one, reading ONLY
`documentId` and writing the three filter resets — it must not read `filterType`/`filterAuthor`/
`filterStatus` at all:

```ts
$effect(() => {
  void documentId;
  filterType = "all";
  filterAuthor = "all";
  filterStatus = "all";
});
```

Leave the existing effect (`bulkConfirmRequested = null`) untouched — it still fires on both
filter changes and document changes, which is its intended behaviour per the #1772 precedent.

**Test:** new case in `tests/client/SidePanel.svelte.test.ts` (or nearest existing SidePanel test):
(1) set `filterType` to a non-`"all"` value with `documentId` unchanged, re-render, assert it
SURVIVES — this is exactly the case the original (wrong) fix would have broken; (2) change
`documentId` and assert all three filters read back `"all"`. Also assert the toggle button's
`aria-expanded` attribute tracks `filterBarOpen` in both states.

### H — Bulk tab close: one native `confirm()` per dirty tab, Cancel doesn't abort the rest

`useDocumentWorkspace.svelte.ts`'s `closeOtherTabs`/`closeTabsToLeft`/`closeTabsToRight` (`:~367-
381`, re-grep at implementation time) each `for`-loop over `closeTabAndRecord(id)`, which
internally calls `opts.confirm(...)` for a dirty scratchpad or source-view tab and `return`s
(skip-this-tab) on Cancel — but the enclosing loop has no `break`, so Cancelling tab 2 of 5 still
prompts for tabs 3, 4, 5. Change the three loop functions to check a cancellation signal and stop:
have `closeTabAndRecord` return a boolean (`true` = closed, `false` = cancelled) instead of `void`,
and change each loop to `for (const id of ...) { if (!closeTabAndRecord(id)) break; }`.

**Semantics, stated explicitly (the issue text doesn't settle this):** Cancel on any tab in the
batch ABORTS the rest of the bulk-close operation entirely (no further prompts, no further
closes) — it does not skip-and-continue past the cancelled tab. `break`, not `continue`.

**Round-1 addition — full audit list.** This is a signature change on `closeTabAndRecord`
(`void` → `boolean`); every caller must be checked, not only the three same-file loops:
- `src/client/hooks/useDocumentWorkspace.svelte.ts:~173` — the returned interface's
  `closeTabAndRecord: (tabId: string) => void;` declaration must become `=> boolean`.
- `src/client/App.svelte:937` and `:1498` — bare calls (`documentWorkspace.closeTabAndRecord(id)`);
  discarding the new return value is fine here (`(id) => boolean` is assignable where `void` was
  expected), no change needed.
- `src/client/App.svelte:2670` — `onTabClose={documentWorkspace.closeTabAndRecord}`, passed
  straight through as a prop; same assignability note applies, no change needed, but confirm at
  implementation time that `onTabClose`'s own declared prop type doesn't require an exact `void`
  return (TypeScript structural typing allows a wider return type here, but re-check the prop's
  type declaration since a stricter one could reject it).
- Any test file calling `closeTabAndRecord` and asserting on its return — none found in
  `tests/client/` at spec-revision time; re-check at implementation time since master moves fast.

**Test:** new case in `tests/client/useDocumentWorkspace.svelte.test.ts` (or nearest existing test
for this hook) — a `confirm` stub that returns `false` on the 2nd of 3 dirty tabs, driving
`closeOtherTabs` (or either sibling), asserting `confirm` was called exactly twice (not three
times) and only the first tab actually closed.

### I — Three window-level Escape owners compete (palette / Toolbar / SettingsModal)

Root-caused: `CommandPalette`, `Toolbar`'s selection popup and `SettingsModal` each register their
own capture-phase `stopPropagation()` Escape handler at `window`/`document`, so which one wins on a
shared Escape keypress depends on registration order, not on which is visually topmost. The
concrete, reachable instance is the same class as #1713: `"toggle-palette"`
(`App.svelte:~1482`) has no guard against `settingsModalOpen`, so Ctrl+Shift+P while Settings
is open renders the palette STACKED over Settings (Settings' own focus trap only intercepts Tab,
not other shortcuts). The Toolbar-popup leg is already unreachable in the open-over-editor
direction — both `SettingsModal` and `CommandPalette` render full-viewport `position: fixed; inset:
0` backdrops (verified: `SettingsModal.svelte:618`, `CommandPalette.svelte:412`) that block mouse
selection and keep keyboard focus trapped away from the editor — but NOT in the reverse direction
(popup already open, then Settings/Palette opens over it), since neither modal's open path
currently suppresses an already-visible selection-toolbar popup.

Fix, mirroring #1713's pattern (close/suppress rather than let stack):
- `App.svelte`'s `"toggle-palette"` handler: don't open the palette while `settingsModalOpen` is
  true (`if (!untrack(() => paletteOpen) && settingsModalOpen) return;` before toggling) — closing
  an already-open palette still works regardless of Settings state.
- Extend the existing `popupSuppressed`/`suppressSelectionToolbar` expression
  (`slashCommandMenuOpen || findBarOpen || paletteOpen`, `App.svelte:~1590,~2245`) to also include
  `settingsModalOpen`, so the Toolbar's popup is suppressed the moment Settings opens over it, the
  same way it's already suppressed for the palette/find-bar/slash-menu.

**Test:** extend or add a `tests/client/` case mounting the relevant App-level keybinding logic (or
a structural source-text assertion in the same style as K-client-1713's, if no runtime harness
exists for `"toggle-palette"`) — assert Ctrl+Shift+P is a no-op while `settingsModalOpen` is true,
and that `popupSuppressed` reads true once `settingsModalOpen` is true. Regression net: this
group's `npm run test:e2e` run.

### J — `focus-trap.ts:27-33` skips `position: fixed` descendants

`focusablesWithin` filters on `el.offsetParent !== null`, but `offsetParent` is `null` for
`position: fixed` elements by spec — so a focus-trapped dialog containing a `position: fixed`
child (rare today, but the filter is silently wrong for it) drops that child from the trap.

**Round-1 review correction — use this codebase's own existing idiom, not `getClientRects()`.**
`tests/e2e/forced-colors.spec.ts:193` already solves exactly this in real Chromium:
`el.offsetParent !== null || getComputedStyle(el).position === "fixed"`. Use the same expression in
`focusablesWithin`'s filter (combined with the existing `!el.closest("[inert]")`), rather than
switching to `getClientRects().length > 0` — the original spec's preferred alternative. Both forms
are **equally untestable under this repo's unit environment**: `tests/client/focus-trap.test.ts`
and `tests/client/dialog-focus-trap.test.ts` both run `@vitest-environment happy-dom`, and
happy-dom does not implement `offsetParent` at all (always `undefined`, so `!== null` is always
already true, mooting either fix form under happy-dom) while its `getClientRects()` unconditionally
returns one non-empty rect regardless of `display:none`. Neither change is pinnable by a unit test
in this environment; picking the idiom already proven in real Chromium (rather than inventing a
new one with the same blind spot) is the tie-breaker.

**Test:** none at the unit level — state this explicitly rather than leaving the blanket "every
fix names a test" claim standing. Add the assertion to the real-browser accessibility E2E suite
instead: a `position:fixed` focusable inside a trapped dialog (a small addition to
`tests/e2e/accessibility.spec.ts` or wherever dialog focus-trapping is already exercised) is
reachable via Tab. Recorded in the PR body as "changed, verified by reading + e2e only."

### K — Settings radiogroups remain arrow-navigable while read-only; focus drops to body (extends #1722)

Same `settings._readOnly` (downgraded-client) condition as #1722, different surface. In
`AppearanceSettings.svelte` and `EditorSettings.svelte`, every `createRadioGroup(...)` call omits
the 4th `isDisabled` argument, and every radio `<button>` uses the NATIVE `disabled={readOnly}`
attribute. A native `disabled` on the currently-focused element causes the browser to auto-blur it
to `<body>` the instant `readOnly` flips true mid-interaction — matching #1722's "focus drops to
body" symptom via a different mechanism (there: an unmounted focus target; here: the native
disabled-focus-drop). Fix, scoped to the `role="radio"` buttons only (not every other `disabled=
{readOnly}` control in these files — a plain disabled checkbox/select losing focus on flip is a
much rarer path this bullet doesn't name):

**Round-1 review correction — the 4th argument must be a getter, not a one-shot ternary.** Every
`createRadioGroup(...)` call (`themeRg`, `primaryTabRg`, `textSizeRg`, `densityRg` in
`AppearanceSettings.svelte`; `editorFontRg`, each `fontByExtensionRgs[...]`, `measureRg` in
`EditorSettings.svelte`) is top-level component-init code, evaluated exactly once. The original
spec's `readOnly ? () => true : undefined` evaluates that ternary at that one moment — with
`readOnly` false at mount (the common case), the 4th arg is `undefined` forever, and the hook's
`handleKeyDown`/`tabIndexFor` (which DO re-invoke `isDisabled` on every call, per
`useRadioGroup.svelte.ts:33,56-63`) never see a later flip to `readOnly = true`. A test that mounts
already-read-only would pass either form and miss this; the scenario that matters is the flip.

Corrected: pass a getter that re-reads the prop on every call —

```ts
() => readOnly
```

— as the 4th argument to all seven `createRadioGroup(...)` calls listed above (typed
`(_v: T) => readOnly`). This is a plain reactive closure over the component's `readOnly` prop, not
a value snapshotted at call time.

On each `role="radio"` `<button>`, replace `disabled={readOnly}` with `aria-disabled={readOnly}`
(keeps `disabledControlStyle(readOnly)` visual styling, which is JS-driven and unaffected) and
guard the `onclick` handler: `onclick={readOnly ? undefined : () => onUpdate({...})}` — since
`aria-disabled` (unlike native `disabled`) doesn't block clicks or keep focus reachability, both
guards are needed together.

**Round-1 addition — the pinned native-`disabled` contract must move in the same commit.**
`tests/client/settings-readonly-ui.test.ts`'s `CASES` array includes three `role="radio"` buttons —
`theme-dark-btn`, `density-compact-btn` (`AppearanceSettings`), `editor-measure-wide`
(`EditorSettings`) — and its generated specs assert `control.disabled === true` when read-only and
`=== false` when not (`:~175-189`). Swapping native `disabled` for `aria-disabled` on exactly these
three targets reds both assertions for all three. In the same commit: change those three CASES'
assertions to check `getAttribute("aria-disabled") === "true"` / absent-or-`"false"` instead of
`.disabled`, and add a one-line comment in the test file recording WHY the native-`disabled`
contract is relaxed for `role="radio"` only (the focus-drop this item fixes) while every other
(non-radio) control in `CASES` keeps asserting native `.disabled` unchanged.

**Round-1 note, not a fix required — `tabIndexFor` returning `-1` for every value when all are
disabled is intentional continuity, not a regression.** With every value disabled,
`tabIndexFor`'s `enabled` array is empty and every radio returns `-1` — the radiogroup drops out of
the Tab order entirely when read-only. This matches today's existing behaviour with native
`disabled` (a natively-disabled button is already unfocusable and untabbable), so it is not a new
defect introduced by this item; no change needed beyond what's specified above.

**Test:** (1) mount `AppearanceSettings` (or `EditorSettings`) with `readOnly: false`, flip the
prop to `true` on an already-mounted instance, and assert ArrowRight/ArrowLeft no longer move the
selection and `tabIndexFor` returns `-1` for every value — a test that mounts already-read-only
cannot distinguish the getter fix from the broken ternary, so the flip is required. (2) The three
updated `settings-readonly-ui.test.ts` CASES (see above) asserting `aria-disabled` instead of
`disabled` for exactly `theme-dark-btn`/`density-compact-btn`/`editor-measure-wide`.

### L — ErrorBoundary shows a raw error message with no saved/unsaved line

`ErrorBoundary.svelte`'s `failed` snippet (`:~54-73`) shows `error.message` (not the full stack —
the issue's "raw stack" framing slightly overstates today's code, but the underlying gap is real:
no reassurance about data loss). Since "All document mutations go through the server's Y.Doc;
changes sync to the editor via Hocuspocus" in real time (CLAUDE.md Key Patterns), a client
render-time crash does not lose already-typed content.

**Round-1 review correction — the original placement instruction was self-contradictory.** It said
to add the line both "to the `<p class="message">` block" and "after the existing recovery-attempt
message, before the `<pre class="detail">`" — but the `<p class="message">` element's entire body
is a single ternary expression (recovery-attempt text one way or the other) closed before
`<pre class="detail">` begins; there is no way to be inside the first `<p>` AND after it
simultaneously. Corrected: add a **second, separate** `<p class="message">` (or a plain `<p>` with
its own class) between the existing `<p class="message">` and `<pre class="detail">`, containing
exactly: "Your document is synced to the server, so this doesn't affect your saved work."

**Test:** extend the existing `ErrorBoundary` component test (or add one) rendering the `failed`
snippet and asserting the new reassurance text is present as its own DOM node between the
recovery-attempt paragraph and the `<pre class="detail">` element.

### M — Tutorial step 2 has no AI-absent (chat-only) branch

`useTutorial.svelte.ts`'s step-1 effect (`:~115-122`, the "Ask a question" step —
`OnboardingTutorial.svelte`'s `BASE_STEPS[1]`) advances only on `isNonTutorialUserAnnotation`, but
its own copy and `user-guide.md:24` both say sending a chat message also completes it. A user who
only uses Chat during this step never advances. Fix: thread a `getChatMessages: () =>
ChatMessage[]` getter into `createTutorial(...)` (same getter-function convention as
`getAnnotations`/`getEditor`/`getActiveTabFileName`), wired from `App.svelte`'s existing chat-state
hook, and extend the step-1 effect to also advance when `chatMessages.some((m) => m.author ===
"user")` — `welcome.md`'s chat is empty at tutorial start, so "any user message exists" is
sufficient, mirroring the annotation check's own simplicity.

**Round-1 addition — audit the existing test caller.** `createTutorial`'s arity changes from three
getters to four; its one existing test caller,
`tests/client/use-tutorial-restart.svelte.test.ts:37`, must be updated to pass the new
`getChatMessages` getter (an empty-array stub is sufficient unless that test specifically exercises
step 1).

**Test:** extend `tests/client/use-tutorial-restart.svelte.test.ts` (or add a sibling test) with a
case that drives the hook to step 1, supplies a `getChatMessages` stub returning one user message
and no annotations, and asserts the tutorial advances past step 1 — kills a fix that wires the
getter but never reads it, or reads it with the wrong author check.

### N — Internal CLI vocabulary in the desktop app: `SettingsAboutTab.svelte`

Three toast messages (`:37`, `:50`, `:62`) unconditionally tell the user to "try `tandem doctor` in
a terminal" / "run `tandem doctor` in a terminal instead" — but per #1817's own established
precedent (see "Already done" above), the desktop app has no `tandem` command. `isTauriRuntime` is
already imported in this file. Gate: in the desktop build, drop the CLI suggestion and instead
point at the "Open Log Folder" action already present in the same tab (`handleOpenLogFolder`,
`:67+`) — e.g. "Diagnostics failed on the server — try Open Log Folder below" for the desktop
branch, keep the existing `tandem doctor` wording for the non-Tauri (npm/browser) branch.

**Test:** extend `tests/client/SettingsAboutTab.svelte.test.ts` (or nearest existing test for this
component) with cases stubbing `isTauriRuntime` `true` and `false`, triggering each of the three
toast paths, and asserting the desktop branch mentions "Open Log Folder" and never "tandem doctor",
while the browser branch keeps the existing wording unchanged.

## Tests (summary; each item's own test is under "Fixed here")

**Round-1 review correction:** the original summary's blanket claim ("Every fix above names its own
discriminating test inline") was false — 13 of the then-15 items named no test at all. Every
remaining item above now names a concrete test file/assertion, except item J, which explicitly
names none (untestable under this repo's happy-dom unit environment; verified by reading + this
group's e2e run instead, per that item's own text) — that is a deliberate, stated exception, not a
silent gap. Cross-cutting: `npm run typecheck` + `npm test` after every commit; `npm run test:e2e`
once at the end of the group (this is an e2e group) since items D, F, G, H, I, K touch
client-visible behaviour E2E could plausibly exercise.

## Done when

Every "Fixed here" item lands with its own test (item J excepted, per above, with that exception
stated in the PR body); every "Answered, not fixed" item's reasoning is recorded in the PR body —
the chat seen-state item as `Refs #1960` and the SKILL.md item as `Refs #1961`, both genuinely
filed rather than only "flagged"; every "Already done" item is verified once more at
implementation time (source may have moved again) and NOT re-touched; `npm run typecheck`,
`npm test`, `npm run test:e2e` green; Critical Rule 7 snapshot untouched by this issue's own fixes
(item D changes text nodes only, no selector renames — if any fix here incidentally needs a testid
change, regenerate the snapshot in that fix's own commit).

## Not in scope

The `#1722` rail-toggle root cause itself (item K only fixes the radiogroup-specific instance of
the same underlying `_readOnly` condition, per the issue's own "extends #1722" framing — not a
general "make every read-only control aria-friendly" sweep). The Cowork three-confirmation
consolidation and the `cowork-enable-confirm-btn` testid split (#1727, this group does no work
against it — see `K-client-1727.md`). Any `src-tauri/src/**` change (item D reads the Rust label
for context only; E2-rust owns that tree). `skills/tandem/SKILL.md`'s "Tauri app" wording (filed as
#1961 — out of this group's `skill=false` scope). The chat seen-state per-window scoping decision
(filed as #1960 — a product call, not a code fix). Recapturing
`docs/screenshots/03-side-panel.png` (filed as #1962 — needs a running build with item D's rename
already in it). New CI gates, drift guards or frozen lists for any of the above — each fix's own
test is the guard.

## Review corrections (round 1)

**Adopted:**
- Item G: replaced "extend the existing effect" (which reads the three filter values as
  dependencies and would have made them permanently unsettable the moment it also wrote them) with
  a separate `$effect` keyed only on `documentId`. Named a discriminating test for both the survive
  case and the reset case.
- Item K: changed the 4th `createRadioGroup` argument from a one-shot `readOnly ? () => true :
  undefined` ternary (evaluated once at component init, inert for the exact mid-interaction flip
  the item exists to fix) to a getter, `() => readOnly`, re-read on every call. Added the required
  same-commit update to the three `role="radio"` CASES in
  `tests/client/settings-readonly-ui.test.ts` that the `aria-disabled` swap would otherwise red.
  Noted that `tabIndexFor` returning `-1` for every value when fully read-only is intentional
  continuity with today's native-`disabled` behaviour, not a new gap.
- Item O (SKILL.md wording): dropped from "Fixed here" — out of this group's declared ownership
  (`skill=false`) and undercounted its own literal-update surface (two test sites, not one). Filed
  as #1961 and moved to "Answered, not fixed".
- Chat seen-state bullet: filed as #1960 rather than left as an unfiled "flagged to Bryan" note,
  satisfying the group's own "NO UNFILED DEFERRALS" rule before this PR can close #1824.
- Item J: corrected the proposed filter to reuse this codebase's own existing
  `offsetParent !== null || position === "fixed"` idiom (already proven in
  `tests/e2e/forced-colors.spec.ts:193`) rather than switching to `getClientRects()`, and stated
  explicitly that neither form is unit-testable under this repo's happy-dom environment — the item
  is verified by reading plus this group's e2e run, not a unit test, and the Tests summary no
  longer claims otherwise.
- Item A: gated the `decoRevision` bump to transactions that can actually rebuild decorations
  (`docChanged` / `ySyncPluginKey` meta / `annotationPluginKey` meta) instead of every transaction,
  avoiding reintroducing per-transaction cost in the same PR item B removes it. Extracted the gate
  as a pure, unit-testable predicate.
- Item B: stated explicitly that the hoisted early-return must sit after the existing `metaState`
  check, never before it, and named a test pinning that ordering.
- Item D: added the required docs sweep (`user-guide.md`, `README.md:118`) in the same commit and
  filed the screenshot recapture as #1962 rather than silently leaving the docs/screenshot drift
  unaddressed or bundling a disproportionate screenshot-capture step into a text-rename PR.
- Item H: added the full caller/interface audit (`useDocumentWorkspace.svelte.ts:~173`'s returned
  interface, plus `App.svelte:937,1498,2670`), and stated the Cancel semantics explicitly (abort
  the rest of the batch, not skip-and-continue) since the issue text left it open.
- Item L: fixed the self-contradictory placement instruction (two different, mutually exclusive
  locations for the same new text) — it's a second `<p>`, not a graft onto the existing one's
  single ternary.
- Item M: added the audit note for `createTutorial`'s one existing test caller
  (`tests/client/use-tutorial-restart.svelte.test.ts:37`), mirroring the audit note item H already
  carries.
- Tests summary: replaced the false "every fix names its own test" claim with an accurate one,
  naming item J as the sole, stated exception.

**Not adopted:**
- Re-litigating whether item D's docs/screenshot drift should be fixed inline vs. filed — filing
  the screenshot recapture (disproportionate scope for this PR) while fixing the docs text inline
  (cheap, same commit) was judged the right split; not adopted as "fix everything inline" or "file
  everything," per the specific cost of each half.
- Extending item K's fix to also restore a Tab stop when a radiogroup is fully read-only (a
  behavior change beyond what #1722's precedent or this item's own scope calls for) — recorded as
  intentional continuity instead, not adopted as a new behavior.
