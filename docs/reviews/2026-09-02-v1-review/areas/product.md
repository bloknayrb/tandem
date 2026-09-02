# Area: Product (first-run, wizard, copy, error surfaces)

**Raw:** [`../raw/findings-product.txt`](../raw/findings-product.txt) (Fable, resumed, 6 calls);
[`../raw/gapfill-B.txt`](../raw/gapfill-B.txt) (Sonnet, copy checks).
**Manifest:** [`../raw/manifests/product.md`](../raw/manifests/product.md).
**Tracks:** [J words](../tracks/J-words.md) for copy and docs; [C](../tracks/C-privacy-and-authority.md)
for the Solo wording; [H](../tracks/H-the-flip.md) for the two dark-license items; the
`freePort` High is filed under server-runtime (#1758, track E).
**Spot-check:** the `freePort` ordering, the Solo pull-side gates and the browser-build
`openByPath` reachability read by the orchestrator; the never-logged-in path was not executed.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/server/index.ts:580-581`; `platform.ts:179-244`; `release-smoke-checklist.md:209-214`; `troubleshooting.md:141` | Duplicate of the server-runtime finding: `tandem` from npm while the desktop app runs SIGKILLs the desktop sidecar under open documents. The smoke checklist certified the opposite. | [read] | Source-confirmed (race winner on Windows unverified) | [#1758](https://github.com/bloknayrb/tandem/issues/1758) |
| H | `src/client/editor/toolbar/ModeToggle.svelte:30`; `sample/welcome.md:28` | Solo copy "won't see your comments or edits" overstates: only `annotation:*` and chat events are held; `tandem_checkInbox` still returns `selectedText` (`awareness.ts:377-386`) and `tandem_getTextContent` is ungated. README wording is accurate. | [read] | Source-confirmed | [#1779](https://github.com/bloknayrb/tandem/issues/1779) |
| H | `src/server/launcher/supervisor.ts:1205-1250`; `useAiReadiness.svelte.ts:256-259`; `EmptyState.svelte` | Claude Code installed but never logged in: the auth exit is counted as a crash; after ten attempts a generic "Restart Claude Code" chip; no login guidance anywhere in the product. `troubleshooting.md:123-137` names expired login but the remedy is start-fresh. | [read] | Agent-reported (auth-exit path not executed) | [#1780](https://github.com/bloknayrb/tandem/issues/1780) |
| H | `src/client/components/FileOpenDialog.svelte`; `NewTabMenu.svelte:123`; `docs/user-guide.md:138` | The browser/npm build has no way to open a disk file for editing from the UI: Browse… is `upload://` read-only with session-only save; the user guide's "Path input" does not exist. `openByPath` is reachable only from the native picker, recents and sessions. | [read] | Source-confirmed | [#1781](https://github.com/bloknayrb/tandem/issues/1781) |
| M | `IntegrationWizardModal.svelte:863-904` | "We couldn't find Claude" headline keyed on `existing.length === 0`, not presence; contradicts "Claude Code is installed" two lines down. | [read] | Agent-reported | [#1814](https://github.com/bloknayrb/tandem/issues/1814) |
| M | `welcome.md`, README vs `IntegrationWizardModal.svelte:1029-1034,1091-1101` | "One click connects" vs a Done step that requires a terminal and `/mcp`. | [read] | Agent-reported | [#1815](https://github.com/bloknayrb/tandem/issues/1815) |
| M | `document-service.ts:543-557,879-893,1380-1395`; `builtin.svelte.ts:425`; `_shared.ts:125-300` | Raw errno and absolute path in save-failure toasts on loopback; `GENERIC_ERROR_MESSAGE` exists only for non-loopback. | [read] | Agent-reported | [#1816](https://github.com/bloknayrb/tandem/issues/1816) |
| M | `IntegrationWizardModal.svelte:1147-1167`; `SettingsClaudeCodeTab.svelte:440-452` | CLI-only push-route instructions (`--dangerously-load-development-channels`, `tandem setup --apply --with-channel-shim`) shown ungated to desktop users, who have no CLI. | [read] | Agent-reported | [#1817](https://github.com/bloknayrb/tandem/issues/1817) |
| M | `NetworkSettings.svelte` vs `lib.rs:1729` vs `troubleshooting.md:159` vs `App.svelte:290`; `NetworkSettings.svelte:212` | "Restart sidecar" / "Restart server" / "Sidecar failed… see logs" (no link) for one action; the hint `tandem start --port <N>` names a flag that does not exist (`cli/index.ts:180-181`, `start.ts:11-45`). | [read] | Source-confirmed (`runStart()` takes no args) | [#1818](https://github.com/bloknayrb/tandem/issues/1818) |
| M | `license-state.ts:127-144`; `lib.rs:2157-2168` | `daysRemaining` unclamped ("24 of 14 days left" after a clock change); the up-to-date dialog has no ended-update-window branch. Both dark. | [read] | Agent-reported | [#1819](https://github.com/bloknayrb/tandem/issues/1819) |
| L | Settings / About / EmptyState / toasts; `BulkActions.svelte:51`; LicenseWall; `ErrorBoundary`; `useFirstRunNeeded`; tutorial step 2 | Internal vocabulary including `tandem …` CLI hints inside the desktop app; Reject/Dismiss/reject inconsistency; LicenseWall promises read-only chat (extends #1521); SKILL.md and `troubleshooting.md:76` say "Tauri app"; raw stack with no saved/unsaved line; wizard silently skipped on fetch failure and dismissal keyed per version; tutorial step 2 has no AI-absent branch. | [read] | Agent-reported | [#1824](https://github.com/bloknayrb/tandem/issues/1824) |

## Leads not run

500-page document latency; a 200-annotation panel; two windows across sleep/wake; a malformed
`.docx`; Cowork on WSL (#1704). Eight smoke candidates from this area are in
[smoke-lines.md](../smoke-lines.md) or folded into existing lines.

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`user-guide.md:387` "Undo/redo not yet available" vs `:80` and `editor-extensions.ts:266-268`;
`user-guide.md:138` Path input; `:509,527` developer prose; `troubleshooting.md` opens with
`npm run doctor`; README "Real-time updates" developer prose; `release-smoke-checklist.md:209-214`.

## Verified fine

Solo pull-side gates for annotations (`annotations.ts:403,414,623,645,815`,
`awareness.ts:607,707`); notes never leave via export, inbox or observers; wizard Done gated on a
real MCP connection; no-AI send CTAs; graduated connection copy; conflict and fidelity banners;
single-instance plugin; the 50 MB cap message; docx import toast; file-association rejection copy;
the file-deleted-while-open toast exists (`builtin.svelte.ts:453,536`); DocumentHealth is
dev-harness only.
