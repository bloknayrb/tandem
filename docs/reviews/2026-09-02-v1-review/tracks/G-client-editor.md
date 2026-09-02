# Track G — Client editor and UI

**Tier:** Sonnet builds, Opus reviews, `svelte-migration-reviewer` on every PR. **Decisions
needed:** none. **Do not hold the next minor for it**, though #1772 and #1773 are the two client
Highs that destroy state and are each an afternoon.

## Issues

| Issue | What | Area | Experiment |
|---|---|---|---|
| [#1772](https://github.com/bloknayrb/tandem/issues/1772) | Reset the armed bulk confirm on document switch (the same four resets `promoteConfirmRequested` got), or key the bulk bar on `documentId`. | [client-ui](../areas/client-ui.md) | Playwright: two pending annotations in the second document |
| [#1773](https://github.com/bloknayrb/tandem/issues/1773) | Confirm before session delete and clear-all, or an undo toast; never destroy annotation state on one click. | [client-ui](../areas/client-ui.md) | none; write an E2E |
| [#1774](https://github.com/bloknayrb/tandem/issues/1774) | `walkMatches` maps through `hardBreak` as one position, or searches on a text with the break as one char. | [client-editor](../areas/client-editor.md) | harness `a-bugs` |
| [#1775](https://github.com/bloknayrb/tandem/issues/1775) | Slash menu gates on `$from.parent.type.spec.code`. | [client-editor](../areas/client-editor.md) | harness `a-bugs` |
| [#1776](https://github.com/bloknayrb/tandem/issues/1776) | `activity.cursor` goes through `pmSelectionToFlat` like `selection`; `docs/mcp-tools.md` and the skill name the coordinate system. | [client-editor](../areas/client-editor.md) | harness `a-bugs` |
| [#1777](https://github.com/bloknayrb/tandem/issues/1777) | The window listener honours `defaultPrevented` (Ctrl+Enter); an `altKey` gate on `e.code` chords (AltGr); `isComposing` on six Enter handlers; `capturedRange` mapped through remote transactions. | [client-editor](../areas/client-editor.md) | harness `e-keys` |
| [#1778](https://github.com/bloknayrb/tandem/issues/1778) | `focus-trap.ts` on the four untrapped `aria-modal` dialogs; `tabindex="-1"` on the radiogroup containers. | [client-ui](../areas/client-ui.md) | E2E `keyboard-a11y.spec.ts` (and un-skip its permanent skip, #1825) |

Lows to fold in from [#1824](https://github.com/bloknayrb/tandem/issues/1824): the dead
`useRadioGroup.ts` (delete it and test the `.svelte.ts` one), read-only radiogroups, the pulse
class, the palette rows, `aria-expanded`, the per-tab `confirm()` loop, the Escape owners, the
browser-reserved shortcut copy, the paste-sanitiser regression test.

## Rules that bite here

- **Never write `$state` synchronously from a Tiptap event handler**; bridge through
  `createCoalescingTick`. `transaction` subscribers are the exposed ones.
- `ChatPanel` and `SidePanel` are always mounted (display toggle); #1772 exists because of that, and
  the fix is a reset, not a remount.
- `localStorage` access needs try-catch.
- E2E selectors are `data-testid`, kebab-case, and the set is a snapshot contract: add, never
  rename without regenerating `__snapshots__/testid-set.snap.txt`.
- Two CSS pipelines: write the standard property alone in bundled CSS.

## Experiments

The harness under `experiments/harness/` runs Tiptap in happy-dom with the production schema:
`npx vitest run --config docs/reviews/2026-09-02-v1-review/experiments/harness/vitest.config.ts`.
A passing test there means the bug reproduces; rewrite each into a real spec under `tests/client/`
with the assertion inverted when the fix lands. The Playwright lane's log
(`raw/verify-client.txt`) has the browser steps for the six Highs; the spec itself was deleted and
should be recreated under `tests/e2e/` on the reserved ports.

## Reviewer agents

`svelte-migration-reviewer` (mandatory), `crdt-reviewer` on #1774 and #1776 (position mapping).

## Done when

- `a-bugs.test.ts` and `e-keys.test.ts`, inverted and moved under `tests/client/`, pass.
- An E2E on the reserved ports switches documents with an armed bulk confirm and asserts nothing
  fires; another asserts a confirm before session delete.
- `keyboard-a11y.spec.ts:271` is no longer permanently skipped.
- The testid snapshot is regenerated only if a selector was added.

## Status

_(empty)_
