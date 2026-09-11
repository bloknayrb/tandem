# K-client — #1824 Lows batch, client (v1 review): editor, UI, a11y and product copy

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. This PR **closes #1824** only if
every un-cross-referenced bullet below is fixed or recorded as refuted-with-evidence — verified
bullet by bullet against current master, not against the 2026-09-02 filing. Ledger rows:
`docs/reviews/2026-09-02-v1-review/areas/client-editor.md:26`, `client-ui.md:22-24`, `product.md:26`.
No dedicated probe script; each sub-item below carries its own discriminating test.

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
  fix (below) is a DIFFERENT surface (`SettingsAboutTab.svelte`'s diagnostics/clipboard errors),
  which #1817's PR did not touch.
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
  durable so it survives a reload) — a product decision, not a Low-sized bug fix. Flagged to Bryan
  (see `bryan`) rather than silently changed.
- **`useFirstRunNeeded` fetch failure = wizard silently skipped; dismissal keyed per version.**
  Both halves are explicitly intentional per the hook's own docblocks (`useFirstRunNeeded.svelte.ts`):
  "Intentional: server-unreachable/malformed-JSON → wizard does NOT auto-open... Don't 'fix' this
  by flipping the default," and "Server version... wizard dismissal is keyed on this." No change.
- **DocumentHealth panel copy "No analysis available."** `DocumentHealth.svelte` is registered only
  in `src/client/svelte-harness/registry.ts`, a dev-only visual-smoke-test registry that lists ~30
  other components the same way (`registry.ts:1-9`'s own docblock: "Components may require props...
  the harness renders components without props, for visual smoke-testing only"). It is not
  uniquely dead among its siblings; no change.

## Fixed here

Each item names its file(s), the exact change, and the CLAUDE.md rule it touches (if any).

### A — Active-annotation pulse class lost on decoration rebuild (`Editor.svelte:286-301`)

The `$effect` re-applying `.tandem-annotation-active` depends only on `activeAnnotationId` and
`editor`; a decoration rebuild (e.g. a #1669-style y-sync replacing the DOM) doesn't touch either,
so the class silently doesn't come back. Per CLAUDE.md's Tiptap gotcha ("Never write `$state`
synchronously from a Tiptap event handler — bridge through `createCoalescingTick`... `transaction`
subscribers are the exposed ones"): add a `decoRevision` counter bumped via `createCoalescingTick`
on the editor's `transaction` event (same pattern as `FormattingToolbar.svelte`), and make the
class-application effect also read `decoRevision` so it reapplies after every transaction —
decorations are rebuilt on `docChanged` transactions, and this effect is idempotent (strip then
reapply) so re-running it on every transaction, coalesced to one microtask, is cheap.

### B — `isSlashMenuSuppressed` runs `querySelector` on every transaction

`src/client/editor/slash-menu/extension.ts`'s plugin `apply(tr, value, _oldState, newState)`
(`:292-309`) calls `resolveActiveSlashCommand` — and therefore `isSlashMenuSuppressed`'s ~10
`document.querySelector` probes — unconditionally on every transaction, including pure cursor
moves and remote CRDT syncs. The existing gate at `:306` already DISCARDS the result in exactly
one case: `!value.active && !isTypedInsertionAtCaret(tr)`. Move that check earlier: when the menu
is not currently active AND this transaction is not a typed insertion at the caret, return
`{ active: null, dismissedKey: value.dismissedKey }` before calling `resolveActiveSlashCommand` at
all — behaviour-preserving (the discarded branch already produces this exact result today), and it
skips the DOM probing on the common "menu closed, unrelated transaction" case. When the menu IS
active, keep calling it unconditionally (the existing comment: "Once already open we keep
re-deriving... so the menu closes when the caret leaves" — this must not regress).

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

### D — `annotation-context-menu` / `BulkActions.svelte:51`: Reject vs. Dismiss inconsistency

The visible button text says "Reject"/"Reject All" (`BulkActions.svelte:51,86`;
`AnnotationCardActions.svelte:~88`) while every internal identifier (`onDismiss`, `canDismiss`,
`handleDismissAnimated`, the `"Dismissed"` filter/toast label) and the NATIVE right-click context
menu (`src-tauri/src/context_menu.rs:385` — read-only reference, **not edited**: this group owns
`src/client/**`, not `src-tauri/src/**`, per COORDINATION) already say "Dismiss". Align the client
button text to "Dismiss"/"Dismiss All" rather than the reverse (renaming the Rust label is out of
this group's reach and out of scope): `BulkActions.svelte:51` (`{isAccept ? "Accept" : "Dismiss"}`),
`:86` ("Dismiss All"), `AnnotationCardActions.svelte`'s equivalent button. No `data-testid` change
(`bulk-confirm-btn` etc. are unaffected — only the text node). Confirmed no test asserts the
literal string "Reject" for annotation review (a repo-wide check found only Word's OWN
"Accept or Reject" terminology in `ApplyChangesButton.svelte:23`, describing Word's tracked-changes
UI — correctly left alone, since that names Word's vocabulary, not Tandem's).

### E — No explicit paste sanitiser regression test

Schema-only safety today (`editor-props.ts:63-66`, ProseMirror schema + `image-src-safety.ts`) with
no test pinning it. Add one test to `tests/client/plain-paste.test.ts` (or a new
`tests/client/paste-sanitize.test.ts` alongside the four existing paste specs) that pastes HTML
containing `<img src=x onerror=alert(1)>` and `<a href="javascript:alert(1)">` and asserts the
resulting document has no `onerror` attribute and no `javascript:` href — following whatever paste
harness `link-paste.test.ts`/`markdown-paste.test.ts` already use (Tiptap's `clipboardTextParser`
path via a synthetic paste event or `editor.commands.insertContent` with `parseOptions:
{preserveWhitespace: false}` matching the existing suite's pattern).

### F — Command palette shortcut rows inert on Enter, discard the opener

`CommandPalette.svelte`'s `runResult` (`:335-364`) unconditionally sets `opener = null` before the
kind-specific branches, but the `"shortcut"` kind has no branch (comment: "shortcut items:
display-only, no action on Enter") — so pressing Enter on a highlighted shortcut row silently
discards the focus-restore reference for no reason, and a later Escape/dismiss can no longer
return focus to whatever opened the palette. Add an early return: `if (result.kind === "shortcut")
return;` as the FIRST line of `runResult`, before `opener = null` — preserves "no action on Enter"
(display-only stays display-only) while fixing the actual defect (opener no longer discarded).

### G — Filter toggle has no `aria-expanded`; filters persist across document switch

`SidePanel.svelte`'s `filter-bar-toggle` button (`:737-745`) has no `aria-expanded` reflecting
`filterBarOpen`. Add `aria-expanded={filterBarOpen}`. Separately, the existing `$effect` at
`:229-236` already resets `bulkConfirmRequested` on `documentId` change (the #1772 precedent, same
file) but does not reset `filterType`/`filterAuthor`/`filterStatus` — extend the same effect to
also reset the three filter values to `"all"` on `documentId` change, matching the file's own
established pattern rather than inventing a second effect.

### H — Bulk tab close: one native `confirm()` per dirty tab, Cancel doesn't abort the rest

`useDocumentWorkspace.svelte.ts`'s `closeOtherTabs`/`closeTabsToLeft`/`closeTabsToRight` (`:367-
381`) each `for`-loop over `closeTabAndRecord(id)`, which internally calls `opts.confirm(...)` for
a dirty scratchpad or source-view tab and `return`s (skip-this-tab) on Cancel — but the enclosing
loop has no `break`, so Cancelling tab 2 of 5 still prompts for tabs 3, 4, 5. Change the three
loop functions to check a cancellation signal and stop: have `closeTabAndRecord` return a boolean
(`true` = closed, `false` = cancelled) instead of `void`, and change each loop to
`for (const id of ...) { if (!closeTabAndRecord(id)) break; }`. This is a signature change on an
internal function with three same-file call sites plus any existing test callers — audit
`tests/client/` for `closeTabAndRecord` callers expecting `void` before landing.

### I — Three window-level Escape owners compete (palette / Toolbar / SettingsModal)

Root-caused: `CommandPalette`, `Toolbar`'s selection popup and `SettingsModal` each register their
own capture-phase `stopPropagation()` Escape handler at `window`/`document`, so which one wins on a
shared Escape keypress depends on registration order, not on which is visually topmost. The
concrete, reachable instance is the same class as #1713: `"toggle-palette"`
(`App.svelte:1482-1485`) has no guard against `settingsModalOpen`, so Ctrl+Shift+P while Settings
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

### J — `focus-trap.ts:27-33` skips `position: fixed` descendants

`focusablesWithin` filters on `el.offsetParent !== null`, but `offsetParent` is `null` for
`position: fixed` elements by spec — so a focus-trapped dialog containing a `position: fixed`
child (rare today, but the filter is silently wrong for it) drops that child from the trap. Add an
explicit visibility check that doesn't rely on `offsetParent`: `getComputedStyle(el).display !==
"none"` combined with the existing `!el.closest("[inert]")`, OR check
`el.getClientRects().length > 0` (catches `display:none` AND zero-size without excluding
`position:fixed`). Prefer `getClientRects().length > 0` — it's the narrower, more standard
"is this actually rendered" test and doesn't need a second `display` read.

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
- Pass `readOnly ? () => true : undefined` as the 4th arg to each `createRadioGroup(...)` call
  (`themeRg`, `primaryTabRg`, `textSizeRg`, `densityRg` in `AppearanceSettings.svelte`;
  `editorFontRg`, each `fontByExtensionRgs[...]`, `measureRg` in `EditorSettings.svelte`) so
  `handleKeyDown`'s arrow navigation and `tabIndexFor` both correctly treat every value as disabled
  when read-only (the hook already supports this parameter; nothing else changes).
- On each `role="radio"` `<button>`, replace `disabled={readOnly}` with `aria-disabled={readOnly}`
  (keeps `disabledControlStyle(readOnly)` visual styling, which is JS-driven and unaffected) and
  guard the `onclick` handler: `onclick={readOnly ? undefined : () => onUpdate({...})}` — since
  `aria-disabled` (unlike native `disabled`) doesn't block clicks or keep focus reachability, both
  guards are needed together.

### L — ErrorBoundary shows a raw error message with no saved/unsaved line

`ErrorBoundary.svelte`'s `failed` snippet (`:56-73`) shows `error.message` (not the full stack —
the issue's "raw stack" framing slightly overstates today's code, but the underlying gap is real:
no reassurance about data loss). Since "All document mutations go through the server's Y.Doc;
changes sync to the editor via Hocuspocus" in real time (CLAUDE.md Key Patterns), a client
render-time crash does not lose already-typed content. Add one line to the `<p class="message">`
block: "Your document is synced to the server, so this doesn't affect your saved work." — placed
after the existing recovery-attempt message, before the `<pre class="detail">`.

### M — Tutorial step 2 has no AI-absent (chat-only) branch

`useTutorial.svelte.ts`'s step-1 effect (`:115-122`, the "Ask a question" step — `OnboardingTutorial
.svelte`'s `BASE_STEPS[1]`) advances only on `isNonTutorialUserAnnotation`, but its own copy and
`user-guide.md:24` both say sending a chat message also completes it. A user who only uses Chat
during this step never advances. Fix: thread a `getChatMessages: () => ChatMessage[]` getter into
`createTutorial(...)` (same getter-function convention as `getAnnotations`/`getEditor`
/`getActiveTabFileName`), wired from `App.svelte`'s existing chat-state hook, and extend the
step-1 effect to also advance when `chatMessages.some((m) => m.author === "user")` — `welcome.md`'s
chat is empty at tutorial start, so "any user message exists" is sufficient, mirroring the
annotation check's own simplicity.

### N — Internal CLI vocabulary in the desktop app: `SettingsAboutTab.svelte`

Three toast messages (`:37`, `:50`, `:62`) unconditionally tell the user to "try `tandem doctor` in
a terminal" / "run `tandem doctor` in a terminal instead" — but per #1817's own established
precedent (see "Already done" above), the desktop app has no `tandem` command. `isTauriRuntime` is
already imported in this file. Gate: in the desktop build, drop the CLI suggestion and instead
point at the "Open Log Folder" action already present in the same tab (`handleOpenLogFolder`,
`:67+`) — e.g. "Diagnostics failed on the server — try Open Log Folder below" for the desktop
branch, keep the existing `tandem doctor` wording for the non-Tauri (npm/browser) branch.

### O — `skills/tandem/SKILL.md:159` says "the Tauri app"

The shipped skill's not-running message says "Start the Tauri app or run `tandem start`" — "Tauri"
is the underlying framework, invisible to a real user; the product name used everywhere else
(README, user-guide, CHANGELOG) is "the desktop app". `docs/troubleshooting.md:155`'s own "Tauri
shell" mention is left AS IS — it's inside a technical explanation of why the desktop app is exempt
from the port-reclamation refusal, correctly precise for that developer-facing context, not
end-user instructional copy.

Change `skills/tandem/SKILL.md:159`: "Start the Tauri app" → "Start the desktop app". This is a
skill-body edit, so per the Hard Rules: bump the frontmatter `version:` from `21` to `22`, and
recompute + update BOTH literals in `tests/skill-instruction-contract.test.ts`'s "reds on a
body-only skill edit" test (`:406-431`) in the same commit — `version: "22"` and a fresh `bodyHash`
computed exactly as that test does: `sha256(body-after-frontmatter, CRLF→LF normalised).hex.slice(0,
12)`. Re-check `origin/master` immediately before this edit lands (per the wave notes, master moved
a lot on 2026-09-10) in case another concurrent group already bumped past 21.

## Tests (summary; each item's own test is under "Fixed here")

Every fix above names its own discriminating test inline. Cross-cutting: `npm run typecheck` +
`npm test` after every commit; `npm run test:e2e` once at the end of the group (this is an e2e
group) since items D, F, G, H, I, K touch client-visible behaviour E2E could plausibly exercise —
no NEW E2E spec is required unless an existing one breaks, since each item already has a
unit/component-level discriminating test named above.

## Done when

Every "Fixed here" item lands with its own test; every "Answered, not fixed" item's reasoning is
recorded in the PR body (not silently dropped); every "Already done" item is verified once more at
implementation time (source may have moved again) and NOT re-touched; SKILL.md version/bodyHash
pair updated together or not at all; `npm run typecheck`, `npm test`, `npm run test:e2e` green;
Critical Rule 7 snapshot untouched by this issue's own fixes (item D changes text nodes only, no
selector renames — if any fix here incidentally needs a testid change, regenerate the snapshot in
that fix's own commit).

## Not in scope

The `#1722` rail-toggle root cause itself (item K only fixes the radiogroup-specific instance of
the same underlying `_readOnly` condition, per the issue's own "extends #1722" framing — not a
general "make every read-only control aria-friendly" sweep). The Cowork three-confirmation
consolidation and the `cowork-enable-confirm-btn` testid split (#1727, this group does no work
against it — see `K-client-1727.md`). Any `src-tauri/src/**` change (item D reads the Rust label
for context only; E2-rust owns that tree). New CI gates, drift guards or frozen lists for any of
the above — each fix's own test is the guard.
