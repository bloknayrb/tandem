# Area: Client editor (Tiptap extensions, shortcuts, awareness)

**Raw:** [`../raw/findings-client-editor.txt`](../raw/findings-client-editor.txt) (Fable, resumed, 4 calls);
the Playwright lane log [`../raw/verify-client.txt`](../raw/verify-client.txt) (Opus).
**Manifest:** [`../raw/manifests/client-editor.md`](../raw/manifests/client-editor.md).
**Track:** [G client editor](../tracks/G-client-editor.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** the orchestrator re-ran `experiments/harness/a-bugs.test.ts` and `e-keys.test.ts`
(passing means the bug reproduces); the three Highs and Ctrl+Enter were then confirmed in a real
browser by the Playwright lane.

Spawn `svelte-migration-reviewer` on any `.svelte` / `.svelte.ts` change and `crdt-reviewer` on
anything that maps positions.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/client/editor/extensions/awareness.ts:226,238,252`; server `awareness.ts:269,438`; `mcp-tools.md:907-925`; `SKILL.md:79` | `Y_MAP_ACTIVITY.cursor` is written as a ProseMirror position (`state.selection.from`) while `Y_MAP_SELECTION` goes through `pmSelectionToFlat`; the server publishes it as flat and the docs tell Claude to use it. Harness: 38 vs flat 32. | [ran] | Reproduced (harness + browser) | [#1776](https://github.com/bloknayrb/tandem/issues/1776) |
| H | `src/client/editor/extensions/find-replace.ts:74-88` | `walkMatches` searches `node.textContent` (hardBreak = 0 chars) but maps `pos + 1 + idx` (hardBreak = 1): off by one per break after a Shift+Enter; `replaceActive` / `replaceAll` corrupt text. | [ran] | Reproduced (`"alphaXXXXXo charlie"`) | [#1774](https://github.com/bloknayrb/tandem/issues/1774) |
| H | `src/client/editor/slash-menu/extension.ts:80-108,342-345` | No `$from.parent.type.spec.code` gate: `/e` + Enter inside a code block converts it to a paragraph; `cd /t` + Enter deletes text. | [ran] | Reproduced | [#1775](https://github.com/bloknayrb/tandem/issues/1775) |
| M | `src/client/hooks/useAppShortcuts.ts:266`; `App.svelte:1563-1571` | Ctrl+Enter inserts a hard break (Tiptap) *and* accepts or dismisses the pending annotation (the window listener ignores `defaultPrevented`). | [ran] | Reproduced (browser) | [#1777](https://github.com/bloknayrb/tandem/issues/1777) |
| M | `useAppShortcuts.ts:126-312` | `mod = ctrlKey || metaKey` with no `altKey` gate on `e.code` chords: AltGr letters on pl/ro/cs/de layouts fire save/new/open/tab-pick and are swallowed. Synthetic events only; real-browser flag delivery confirmed the DOM half. | [ran] | Reproduced (synthetic) | [#1777](https://github.com/bloknayrb/tandem/issues/1777) |
| M | `ChatPanel.svelte:184`, `LinkEditor.svelte:42`, `FindReplaceBar.svelte:256`, `TabRenameInput.svelte:55`, `CommandPalette.svelte:344`, `OutlinePanel.svelte:116` | Six Enter handlers ignore `isComposing`; a CJK candidate-confirm Enter sends a half-converted chat message. Zero `isComposing` references in all six files. | [read] | Source-confirmed (grep) | [#1777](https://github.com/bloknayrb/tandem/issues/1777) |
| M | `Toolbar.svelte:738-749,788-793,821-825` | `capturedRange` is a frozen PM range not mapped through remote transactions while the composer has focus; a Claude edit above lands the annotation on shifted text. | [read] | Agent-reported | [#1777](https://github.com/bloknayrb/tandem/issues/1777) |
| M | toolbar heading toggle | Rebuilds the XmlElement, both RelativePositions die, flat fallback three chars early, server reports ok forever. Filed with the anchor collapse. | [ran] | Reproduced | [#1764](https://github.com/bloknayrb/tandem/issues/1764) |
| L | `Editor.svelte:287-303`; `user-guide.md:406-409`, `README.md:104`, `OnboardingTutorial.svelte:42`; `editor-props.ts:63-66` | Active-annotation pulse class lost on decoration rebuild; Ctrl+N/W/T documented unconditionally but browser-reserved; macOS Option+[ ] claimed `[inferred]`; `isSlashMenuSuppressed` runs `querySelector` per transaction; no explicit paste sanitiser (schema-only; add one regression test). | mixed | Agent-reported | [#1824](https://github.com/bloknayrb/tandem/issues/1824) |

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`mcp-tools.md:907-925,951` (`activity.cursor` as flat); `architecture.md` never says UTF-16 units;
nested headings carry no `#` in flat text; `useAppShortcuts.ts` header's "layout independence"
claim.

## Verified fine

PM↔flat mapping byte-identical to the server's `extractText` on 24 corpus shapes; separator
`assoc` retry; listener and timer cleanup across eight extensions; coalescing-tick usage;
`PlaintextBreaks` code exemption; hardBreak embeds normalised; `linkOnPaste` default true.
