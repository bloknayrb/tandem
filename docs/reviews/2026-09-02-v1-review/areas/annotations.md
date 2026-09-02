# Area: Annotation lifecycle, ADR-027 privacy and the Solo hold

**Raw:** [`../raw/report-O-annotations.md`](../raw/report-O-annotations.md) (Fable, one of the two
fan-out reviewers that finished). Harness: [`../experiments/harness/g-inbox-ledger.test.ts`](../experiments/harness/g-inbox-ledger.test.ts).
**Track:** [C privacy and authority](../tracks/C-privacy-and-authority.md).
**Spot-check:** F1, F2 and F5 read at the cited lines by the orchestrator; F4 re-run through the
harness; F3 confirmed by grep (`applySuggestion` exists only in the client).

Spawn `annotation-model-reviewer` on every change here, and `security-reviewer` on F1/F2, which
are privacy. The rules in CLAUDE.md's Key Patterns (notes never read or written by Claude; the
four write families; replies split the opposite way) are the invariants a fix must keep.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H (privacy) | `src/server/mcp/routes/mode-release.ts:85`; `useTandemModeBroadcast.svelte.ts:213-214,236-262,296-303` | `POST /api/mode/release` sets the room mode to Tandem unconditionally under `withModeRelease`. The client fires the POST and its observer only logs, never adopts (the comment names the race as open). Solo→Tandem then Tandem→Solo inside the POST latency, or a failed first POST whose retry lands later, leaves the server in Tandem while the UI shows Solo: held comments surface on the next `checkInbox`, `getAnnotations` or export, and the push hold opens. | [read] | Source-confirmed (not reproduced at runtime) | [#1769](https://github.com/bloknayrb/tandem/issues/1769) |
| H (privacy, restart path) | `Toolbar.svelte:801-812`; `annotation-actions.ts` `heldInSoloOnCreate`; `lifecycle.ts:~1197`; `mode.ts:89` | `heldInSolo` on annotations is stamped from the *local window's* mode; replies are stamped server-side from `readModeState()`. Two windows (Tauri WebView plus a browser tab, separate localStorage, observer never adopts) diverge: a comment created in the Tandem-believing window is held live but unmarked, so after a restart with the ctrl session lost it is delivered to Claude while the UI says Solo; release with `released === 0` sends no wake; the held pill under-reports. Fix: stamp server-side, as replies are. | [read] | Source-confirmed | [#1769](https://github.com/bloknayrb/tandem/issues/1769) |
| M | `awareness.ts:632`; `output-schemas.ts:246-248`; `docx-apply.ts:193-199`; `license-gate-coverage.test.ts:70-72` | Claude's own `tandem_resolveAnnotation` is reported as the user's decision (`userResponses` = author claude and status not pending, no actor), and `tandem_applyChanges` writes every accepted suggestion into the `.docx` regardless of who accepted. The test's claim "accept/dismiss never writes document content" is false via `applyChanges`. | [read] | Source-confirmed | [#1770](https://github.com/bloknayrb/tandem/issues/1770), [decision 3](../decisions.md) |
| M | `awareness.ts:562-565,634`; `useAnnotationReview.svelte.ts:732` | The inbox ledger is keyed on `editedAt`; undo writes status pending without touching it, so any decision after an Undo is never surfaced on pull: accept → poll → undo → dismiss → poll returns `userResponses: []`. | [ran] | Reproduced (`g-inbox-ledger.test.ts`) | [#1770](https://github.com/bloknayrb/tandem/issues/1770) |
| M | `lifecycle.ts:891-953` (comment at `:939-945`); `annotation-context-menu.ts:65-69` | `tandem_editAnnotation` has no author guard (the comment admits it edits a user-authored pending comment; the client menu states the opposite rule). Claude can rewrite a user's pending comment under the user's byline, including a Solo-held one by id, and `newText` turns it into a Replacement card. Reply has no Solo or author check either. | [read] | Source-confirmed | [#1770](https://github.com/bloknayrb/tandem/issues/1770), [decision 4](../decisions.md) |
| M | `lifecycle.ts:1279-1306` vs `:844,905,1327` | The four Claude-facing write guards disagree on `audience` (the MCP-area M-4). | [ran] | Reproduced | [#1803](https://github.com/bloknayrb/tandem/issues/1803) |
| L | `useAnnotationReview.svelte.ts:528-538`; `awareness.ts:610`; concurrent `map.set` | Push and pull disagree after a failed Accept (`accepted` emitted, apply fails, reverts silently); `userActions` has no status gate so a Claude-resolved user comment re-surfaces as fresh, and `resolveAnnotation` accepts user highlights; concurrent `map.set` on one key resolves by clientID (verified 3/3, `experiments/yjs-race.ts`): browser Accept vs Claude `editPending` can leave a live suggestion over applied text, force-reload clear vs browser Accept resurrects a record with anchors into gone content. | [ran]/[read] | Agent-ran / source-confirmed | [#1826](https://github.com/bloknayrb/tandem/issues/1826) |

## Already tracked or already fixed

- #1656 appears fixed (`awareness.ts:632` has the note gate): close with a pin (in #1826).
- #1696 structurally confirmed (`open.ts:407` wiring precedes inject at `:458`; guard `map.has`;
  `withInternal` so never persisted).
- #1698: no further raw-type-before-sanitize reads on Claude-facing paths.
- #1619 / #1710: `userResponses` (`awareness.ts:632`) also lacks an audience check; folded into
  #1803.

## Leads not run

`tandem_save` on a `.docx` in Solo writes held comments into the file
(`docx-comment-export.ts` has no mode gate); the durable envelope on disk holds notes in clear (by
design, worth one sentence in `docs/security.md`). Both in #1826.

## Doc drift

`user-guide.md:296` "held back from the document" is an opacity fade plus rail hide, not a hold;
`tandem_comment` in Solo still creates, decorates and toasts (in #1826 and #1779).

## Verified fine

Solo pull-side gates for annotations; notes never leave via export, inbox or observers; the
`heldInSolo` marker semantics at `mode.ts:89` (indeterminate hides only `heldInSolo === true`);
every creation path goes through `anchoredRange` under the right origin helper.
