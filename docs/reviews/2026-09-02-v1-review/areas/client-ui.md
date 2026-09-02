# Area: Client UI (panels, dialogs, a11y)

**Raw:** [`../raw/findings-client-ui.txt`](../raw/findings-client-ui.txt) (Opus fresh run, 52 calls);
Playwright lane log [`../raw/verify-client.txt`](../raw/verify-client.txt).
**Manifest:** [`../raw/manifests/client-ui.md`](../raw/manifests/client-ui.md).
**Track:** [G client editor](../tracks/G-client-editor.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** both Highs read (no `confirm(` in `FileOpenDialog.svelte`; `SidePanel` mounted via
`PanelSlot` with no `{#key documentId}`); the bulk-confirm survival then reproduced in a browser.
That reproduction needs two or more pending annotations in the second document, because the bulk
bar unmounts below that.

Spawn `svelte-migration-reviewer` on every change here.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/client/panels/SidePanel.svelte:186,216-223,501,737-747`; `App.svelte:2789` | An armed "Accept/Reject All" confirm survives a document switch: the only reset is the filter `$effect`; `handleBulk` then iterates the *new* document's `reviewPending` and the `$effect` at `:213` re-focuses Confirm. `promoteConfirmRequested` got four resets for the same hazard (`:505-518`). | [ran] | Reproduced (browser) | [#1772](https://github.com/bloknayrb/tandem/issues/1772) |
| H | `src/client/components/FileOpenDialog.svelte:64-82,326-335,369-376` | Per-row "×" `deleteSession` and "Clear all" `clearAllSessions` fire immediately: no confirm, no undo, no toast; destroys persisted annotation state. | [read] | Source-confirmed | [#1773](https://github.com/bloknayrb/tandem/issues/1773) |
| M | `CommandPalette.svelte:390-392`, `FileOpenDialog.svelte:184-187`, `ModelEditModal.svelte:140-143`, `FirstRunModelPickerModal.svelte:157-165` | `aria-modal="true"` with no Tab trap (`focus-trap.ts` exists and is used by SettingsModal and LicenseWall). Across nine `aria-modal` dialogs, three have zero Tab handling and one lets Tab out. | [read] | Source-confirmed (grep) | [#1778](https://github.com/bloknayrb/tandem/issues/1778) |
| M | `AppearanceSettings.svelte`, `EditorSettings.svelte` | Seven of eight `role="radiogroup"` containers carry `tabindex="0"` (ChipGroup uses -1): double tab stops. | [ran] | Agent-ran (grep) | [#1778](https://github.com/bloknayrb/tandem/issues/1778) |
| M | `hooks/useRadioGroup.ts` vs `useRadioGroup.svelte.ts` | The tested hook is dead; the shipped one is untested, re-implements it and carries the `focus()` call. | [ran] | Agent-ran (0 test hits) | [#1824](https://github.com/bloknayrb/tandem/issues/1824) |
| M | Settings radiogroups | Arrow-navigable while read-only; focus drops to body. Extends #1722. | [read] | Agent-reported | [#1824](https://github.com/bloknayrb/tandem/issues/1824) |
| L | `CommandPalette.svelte:300-330`; `SidePanel.svelte:687-695`; `useDocumentWorkspace.svelte.ts:323-381`; `useChatState.svelte.ts:45-71`; `focus-trap.ts:27-33` | Palette shortcut rows inert on Enter and discard the opener; filter toggle lacks `aria-expanded` and filters persist across documents; bulk tab close is one native `confirm()` per dirty tab and Cancel does not abort the rest; three window-level Escape owners; chat seen-state shared across windows via the ctrl room; focus trap skips `position: fixed`. | [read] | Agent-reported | [#1824](https://github.com/bloknayrb/tandem/issues/1824) |

## Not read at depth

`DocumentTabs.svelte` (1,683 lines); `useNotifications`; StatusBar, ActivityTray,
OnboardingTutorial, HelpModal and SettingsModal internals; the `cowork/`, `keychain/` and `tauri/`
client directories; `MarginColumn`; about forty hooks including `yjsSync`.

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`escape-owner.ts:32-38` "four popovers" (five, with `CwdDriftPill`); `focus-trap.ts:11-16`
census undercounts; `useRadioGroup.ts:8` "retained for coverage".

## Verified fine

All 68 `localStorage` sites are wrapped in try/catch; unread-chat accounting; the `-webkit-`
pair sweep; listener and timer balance; `closeTabAndRecord` guards #864 and #1021; `PanelSlot`
display toggle; Sentry opt-in and scrub.
