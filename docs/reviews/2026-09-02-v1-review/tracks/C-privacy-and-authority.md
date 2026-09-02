# Track C — Privacy and authority

**Tier:** Fable plans, Opus builds; `annotation-model-reviewer` and `security-reviewer` on every
PR. **Decisions needed:** 3 and 4 are taken (Claude may dismiss or withdraw its own annotations,
never accept; `editAnnotation` and `annotationReply` are scoped to annotations Claude authored).
**Do not hold the next minor for it**, but #1769 is a privacy defect and should be the first thing
after track A.

## Issues

| Issue | What | Area |
|---|---|---|
| [#1769](https://github.com/bloknayrb/tandem/issues/1769) | `POST /api/mode/release` writes the mode unconditionally (race leaves the server in Tandem while the UI shows Solo); `heldInSolo` is stamped from the local window's mode, so two windows diverge and a held comment is delivered after restart. Fix: the route must not set the mode, or only on a verified toggle sequence, and the client re-asserts Solo on disagreement; stamp `heldInSolo` server-side as replies already are. | [annotations](../areas/annotations.md) |
| [#1770](https://github.com/bloknayrb/tandem/issues/1770) | Author guards on `tandem_editAnnotation` and `tandem_annotationReply` (decision 4); Claude resolves as dismiss/withdraw only (decision 3), and Claude-resolved records leave `userResponses` and `applyChanges` (a `resolvedBy` stamp); the MCP accept path applies `suggestedText` for user-authored records or refuses; the inbox ledger keys on `rev` or `(status, editedAt)` so a decision after Undo surfaces. | [annotations](../areas/annotations.md), [skill-plugin](../areas/skill-plugin.md) |
| [#1779](https://github.com/bloknayrb/tandem/issues/1779) | Solo copy in `ModeToggle.svelte:30` and `welcome.md:28` says what is actually held (annotations and chat), not "comments or edits". | [product](../areas/product.md) |
| [#1803](https://github.com/bloknayrb/tandem/issues/1803) | The four Claude-facing write guards agree on `audience`: refuse `{comment, audience: private}` in edit, transition and remove as reply already does, always after `sanitizeAnnotation`. | [server-mcp](../areas/server-mcp.md) |
| [#1826](https://github.com/bloknayrb/tandem/issues/1826) | Lows: emit `accepted` after a successful apply; status gate on `userActions`; a `version` field with compare-and-set on the write helpers; close #1656 with a pin; one sentence in `docs/security.md` about the envelope holding notes in clear; check `docx-comment-export.ts` for a Solo gate. | [annotations](../areas/annotations.md) |

Experiment: `experiments/harness/g-inbox-ledger.test.ts` (the Undo ledger case). The race in
#1769 was not reproduced at runtime; write the reproduction first (two providers, one POST
delayed) so the fix has a red test.

## Invariants the fix must keep (from CLAUDE.md)

- Notes are personal: Claude never reads, edits, resolves, removes or replies to one. The guard is
  on `editPending`, `transitionPending`, `AnnotationLifecycle.remove` and `.reply`, after
  `sanitizeAnnotation`. Adding an author guard must not loosen the note guard, and must not be
  added to `addUserReply` or `removeAnnotationRecord` (the seam tests pin both).
- Only `browser`-origin writes generate channel events; a server-side `heldInSolo` stamp still
  goes through `withBrowser` for a browser-originated create or the event is lost. Check the
  helper choice with `audit:origins`.
- Solo/Tandem lives in `CTRL_ROOM`, not per document.
- `tests/server/annotation-remove-seam.test.ts` and `annotation-reply-seam.test.ts` pin importer
  sets; a new guard site changes their counts on purpose.

## Reviewer agents

`annotation-model-reviewer` (mandatory), `security-reviewer` (privacy), `svelte-migration-reviewer`
on the `useTandemModeBroadcast` and `Toolbar` changes.

## Done when

- A two-window test shows the server mode never disagreeing with the last user toggle, and a
  held comment never reaching `tandem_checkInbox` after a restart.
- `tandem_editAnnotation` and `tandem_annotationReply` on a user-authored id return a
  `not-owned` error; on a note, `invalid-note` (unchanged).
- `tandem_resolveAnnotation` on Claude's own record produces no `userResponses` entry and no
  `applyChanges` write; on a user's `suggestedText` record it either applies the text or refuses.
- `g-inbox-ledger.test.ts`, rewritten as a real spec, shows the dismiss after Undo.
- `docs/mcp-tools.md` and the shipped skill say who may accept (skill version bumped).

## Status

_(empty)_
