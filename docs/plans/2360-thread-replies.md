# Plan: #2360, Claude replies inside a user's comment thread

**Plan rev 3, 2026-11-26.** Rev 3 records Bryan's answers to §7's seven questions (2026-11-26,
picked from options) and adjusts the plan where answer 2 differs from rev 2's recommendation
(the local model, §4 and §5); §9's last rows record what rev 3 changed. Rev 2 (2026-11-25) applied
two adversarial reviews (annotation-model and security); §9 records how each item was handled. Issue #2360 (Bryan). Tied to #2358
(multi-session ownership, ADR-054, ships dark behind `OWNERSHIP_ENABLED`). Cites are to
`origin/master` `92ff4cc8`. "Ownership design §N" means
`docs/spikes/multi-session-ownership/README.md`; "the series plan" is
`docs/plans/2358-ownership.md`. This plan writes no code; each PR below gets its own adversarial
review before code, per CLAUDE.md's workflow.

## 1. The problem

`tandem_annotationReply` refuses a user-authored parent with `NOT_OWNED`
(`src/server/annotations/lifecycle.ts:1643-1645`, `replyForClaude`). The shipped skill tells
Claude to answer user comments in chat (`skills/tandem/SKILL.md:59`, `:65`). In the v0.30.0 Linux
smoke (#2349), Bryan saw the answer land in chat, "which is not really the desired behavior".

The ownership series needs this too. Three open flip-blocker rows depend on it
(`tests/server/ownership-flip-blockers.ts`):

| Row | Line | Gap, in short | `closedBy` |
|---|---|---|---|
| H, the handled filter | :74 | Without ownership design §6.4's first two bullets, every handover re-owes an answered comment or reply. Without stripping client-written Claude replies, a browser client could hide a comment from every inbox. | "The PR that lets Claude reply on a user's comment thread (#2360), after its 'later reply' rule is reworked (as designed it would lose a user reply written during Solo)." |
| S, the switch | :204 | "#2360's switch has not merged (decisions 5 and 6 …)." | "#2360's switch PR merged." |
| W, answered work starts Tandem's Claude | :344 | After any handover or restart, every user comment and thread reply reads as waiting, so Tandem's Claude is started or woken again for work it already answered. | "The handled filter (#2360), with a test where a lapse of a holder that answered everything in its threads starts nothing; for what it cannot see (answers in chat or by an edit, state lost at a restart), the restart row's closer or Bryan's answer." |

## 2. Decisions already made

- **#2360, 2026-11-04.** Bryan chose "allowing Claude to reply inside a thread the user started".
  He was offered two alternatives: a chat answer linked to the comment, or deciding later. The
  issue sets the scope: user `type: "comment"` parents that are Claude-facing. Every other refusal
  stays: notes (ADR-027), private (non-outbound) comments, highlights and resolved threads.
  `tandem_editAnnotation` keeps `NOT_OWNED`.
- **The series plan, Bryan's decisions of 2026-11-04** (`docs/plans/2358-ownership.md:13-25`):
  - decision 5: "#2360's switch lands after ownership";
  - decision 6: "comments should get answered with replies to the comment directly, not in the
    chat";
  - confirmed reading (`:330`): "#2360's switch merges right before the flip, in the same
    release".
- **Already shipped live for #2360 in v0.31.0** (CHANGELOG `:83-86`, `:102`):
  - a Claude answer in a user's thread chimes and notifies ("Claude replied to your comment";
    `useThreadAnswers.svelte.ts`, `Y_MAP_REPLY_SEEN`);
  - the user can Resolve their own comment (`dismissed`);
  - Accept replacement is "prepared" for user comments that carry a usable `textSnapshot`.

  This plan adopts the answers those changes give to the issue's two questions:
  - **No new event or UI.** Claude's reply is a `withMcp` write, so it derives no channel event
    (Critical Rule 2).
  - **`suggestedText` is allowed.** It is screened against the parent's live span by
    `screenSuggestionSpan` (`lifecycle.ts:1574`, Critical Rule 6's interior term).
- **Refusal order** (ownership design §5.1, `:257`): `NOT_DOC_OWNER` (with
  `reason: "answered"`) comes before any lifecycle refusal. `ownedIdKeyed` already runs before the
  body (`src/server/mcp/annotations.ts:1257-1335`, `owned-op.ts:236-300`).

## 3. The "later reply" rule, why it loses replies, and the rework

Ownership design §6.4 (`:356-362`) calls a user comment at a given `editedAt`, or a user thread
reply, handled when its thread has "a later final Claude reply". "Later" compares timestamps.
That rule fails in four ways.

1. **Solo, as the row says.** A reply R1 that the user writes in Solo is stamped `heldInSolo`
   (`lifecycle.ts:1476-1478`). `hideFromAI` (`src/server/mode.ts:89-96`) hides it from Claude.
   Claude then replies on the thread. When Solo lifts, `mode-release.ts:19-48` drops the marker
   but keeps R1's timestamp, so R1 reads as answered and is never handed out.
2. **The window when Claude has not seen the reply.** This is not a few seconds. It runs from
   Claude's last look at the thread until its reply is accepted. Reply R2 arriving while Claude
   works on comment C counts as answered.
3. **Another session.** The holder lapses. A session that was handed nothing claims the document
   and replies, which settles items the earlier holder was handed.
4. **The comment's clock.** The browser writes a user comment's `timestamp` and `editedAt`, so they
   come from the client's clock. Claude's reply `timestamp` comes from the server
   (`lifecycle.ts:1451`).

### The rework: a reply lists what it answers, and only what this owner was given

A final Claude reply carries a server-only field, `answers: string[]`. It is computed **inside
`replyForClaude`**, after both guards, from the sanitized record. Each key is listed only if it
passes all three conditions below:

- **(a) Visible at accept time.** Visibility uses the same gates as `threadItemAnsweredBy`
  (`annotations.ts:218-243`): `narrowForChannel` on the parent, `hideFromAI(parent, mode)`,
  `channelVisibleReplies`, `author === "user"`, and `!isHeldInSoloMarker`. The two functions share
  one predicate in the new module.
- **(b) Already handed out and acknowledged.** The delivery registry must hold a live acknowledged
  entry for the key at its current version (`handedAtOrAbove`, `inbox-selection.ts:90`, read
  through the same adapter `documentWaiting` uses).
- **(c) Held by the caller.** The document must be held by the calling record. A handover retires
  the old holder's entries (ownership design §6.3), and since the scope PR only the holder reads a
  held document. So every live entry on a document the caller holds was handed to the caller.

Keys already settled by an earlier final Claude reply on the thread are not listed again.

**Second step, at the next acknowledgement.** This mirrors chat's two-step `settles` (ownership
design §5.5). A key can fail condition (b) only because the poll that would acknowledge it has not
happened yet: the normal flow is poll, reply, poll. So an in-memory map
`threadReplyWriter: replyId → {ownerId, seqAtAccept}` is recorded when the reply is accepted. When a
later poll by the same owner commits its acknowledgement, it appends to that reply's `answers`
every key that poll acknowledges on the reply's thread and that the registry had handed out at or
below `seqAtAccept`.

- The append is one `withInternal` write per document, with a `rev` bump.
- Only keys from the caller's own scope are appended.
- If the map is lost at a restart, the second step does not happen. That fails safe: the entry is
  owed again.

**Keys.**
- The parent comment, only when it is user-authored: `"c:" + (finiteOrNull(editedAt) ?? 0)`.
  `finiteOrNull` moves from `awareness.ts:1706` to the new module so both share one.
- A user reply: `"r:" + replyId`. This is the answerer key already used at `annotations.ts:239`
  (registry kind `"r"`, version 0, `inbox-selection.ts:156`).

**Bounds, enforced when the reply is written.** Two new constants in `src/shared/constants.ts`,
`THREAD_ANSWER_KEY_MAX` and `THREAD_ANSWERS_MAX`, are read by both `writeReply` and the durable
schema. This avoids the #1295 L3 class, where a value is accepted live and then `normalizeReply`
(`sync.ts:165-178`) drops the whole reply at reload.

- A key longer than the key bound is skipped, so its entry stays owed.
- Over the array cap, the oldest keys in thread order are kept and the rest stay owed.
- The second step obeys the same cap.

**Handled.** An entry is handled when a final Claude reply on its thread lists its key. No clock is
compared. A reply is **final** when it has `author === "claude"`, no `agentIdentity`, no
`inProgress`, and `answers` is an array (mirroring `isFinalClaudeReply`,
`src/server/mcp/chat-handled.ts:24-32`). This covers the four failures above:

- an entry Claude was never given is never listed;
- a held reply is not visible, so it is not listed;
- an edit makes a new comment key;
- a lapse retires the registry entries, so the next session lists nothing it was not handed.

Rows written before this change carry no `answers` and settle nothing (§4). **No timestamp
fallback**, because a fallback would bring back failure 2.

### Undoing client writes (what "stripping" means)

The browser never writes `Y_MAP_ANNOTATION_REPLIES`. Every reply goes through a server POST or the
MCP seam (`writeReply`, `lifecycle.ts:1487-1490`), and there is no client `set` or `delete` on that
map. So with ownership on, **every change to the replies map whose origin is a Hocuspocus
`Connection` is undone**:

- an add is deleted;
- a changed value is put back;
- a delete is restored.

Only plain-object old values are restored (`chat-client-undo.ts`'s M2). The undo is one
`withInternal` transaction, keyed on the `Connection` origin the same way `chat-client-undo.ts`
keys it. Three further parts:

- **It runs before derivation.** The undo is the first step of the replies observer, before
  `makePerKeyChangeObserver` derives events (`factory.ts:70-90`; `replies.ts:31` returns early for
  a non-add). Derivation skips any transaction the undo repaired, and otherwise reads the repaired
  map. A forged add pushes no event.
- **Every room gets it.** Upload and scratchpad documents included. Today `attachObservers` skips
  `makeRepliesObserver` for an `uploadDoc` (`events/queue.ts:750-760`). The undo is attached the
  way `makeHeldInSoloStampObserver` is (`queue.ts:776-780`): for every document at room creation,
  and again from `reattachObservers` after the Hocuspocus swap (`queue.ts:812-821`).
- **A guard for structs held pending.** Per document Y.Doc, with the flag on:
  `dropPendingUpdates` plus an `afterTransaction` guard on `Connection` origins, copied from
  `chat-client-undo.ts:189-208` and `ctrl-chat.ts:196-210`. Without it, a struct that waits on the
  server's next clock would land under the origin of the server's next write and dodge the undo.
  **This widens the unmeasured H1 premise (a real tab never leaves data pending) from the CTRL doc
  to document rooms, where a wrong premise would drop a user's typing.** So PR A adds a flip-blocker
  row for it, closed by the same measurement as the H1 row, run in document rooms.

### Rows already on disk

The reply schema is `.passthrough()`. The envelope merge, session restore and `onLoadDocument` all
load with no origin, so a forged `answers` row saved before the undo existed would otherwise
survive.

- **Flag off.** Every build from PR A on strips `answers` and `inProgress` from every reply row on
  load. No legitimate row carries them while the flag is off.
- **Flag on.** The same strip runs unless the document's annotation-store envelope meta carries
  `threadAnswersTrusted: true`. That marker is server-only (it is not in the Y.Doc, so a client
  cannot write it). It is set by the first flag-on write of `answers` after a load that already
  stripped. A user who jumps from a pre-PR-A release straight to the flip release therefore loses
  any forged rows at the first load. A read-only or unwired store has no marker, so it strips,
  which fails safe.
- **Where the sweep runs.** At room creation and after the swap, next to `reconcileAnnotationKeys`
  (`queue.ts:820`), after the file-sync rebind so the strip persists. It is one `withInternal`
  transaction.

**Chat has the same gap** (`chat-handled.ts:35-46`). Today's undo is flag-gated, so while dark a
client can save a Claude row with `settles`, `superseded` or `replyTo` into the CTRL session. That
row counts at the first flag-on boot.

- PR A applies the same treatment to `settles` and `superseded` on CTRL restore: stripped while the
  flag is off, and stripped without a CTRL-meta marker while it is on. Both are written only with
  the flag on.
- `replyTo` cannot be stripped, because it is legitimate data while the flag is off. PR A records
  it as a new flip-blocker row for the chat side: a forged pre-flip Claude row naming a message
  hides that message after the flip. Its `closedBy` is a decision by Bryan, or a server-written
  provenance stamp on Claude chat rows.

### What the guarantee covers

The ADR claim is **"a client cannot mark an entry answered through the replies map"**, and no more.
A client can still hide a user comment by editing its parent in `Y_MAP_ANNOTATIONS`: changing
`author`, `audience` or `status`, or rewinding `editedAt` to a settled key. That is ownership
design D4 (coordination, not security). It is not a security boundary, and it goes into
`docs/security.md` (§5, PR B; Q7).

## 4. Choices made here (not for Bryan)

- **The permission is gated on `OWNERSHIP_ENABLED`.** This keeps decision 5 most strictly: the
  permission cannot reach users before ownership does, and it reaches them in the same release
  whatever slips. Q1 asks Bryan to confirm this reading of "merges right before the flip".
- **Critical Rule 9 is unaffected.** `tandem_annotationReply` is already behind the `/mcp`
  admission point. Nothing here adds a `subscribe(cb, "external")` consumer, an
  `appendClaudeChatMessage` caller or an `/api` route. The undo and the load sweep are server-side
  state repair.
- **The seam takes two required discriminants.** The seam does not read the flag itself, matching
  the suggestion arm.
  - `parents: "own" | "claude-facing-comment"`. The MCP path passes
    `ownershipOn() ? "claude-facing-comment" : "own"`. **Rev 3 (Q2, Bryan: "Yes, settles
    nothing"):** the local model (`local-model/tools.ts`, `reply_to_annotation`) passes the same
    choice, read through `chat-client-writes.ts`' `clientWritesUndoneGrant()`, the fail-closed
    read of the ownership predicate `index.ts` wires at boot (as built in PR A: `owned-op.ts` is
    pinned to tool files by `ownership-api-no-context.test.ts`, and the local model is not a flag
    importer; unwired or throwing, it answers `"own"`). It is **the same gate**: the local model can reply inside a user's Claude-facing
    comment thread exactly when Claude can, with the same privacy refusals and the same Solo
    refusal (Q5), and never while the flag is off.
  - `tracking: "untracked" | "final" | "in-progress"`. The seam computes `answers` itself for
    `"final"`. The MCP path passes `"final"`, or `"in-progress"` for an `inProgress` call, with the
    flag on, and `"untracked"` with it off. **The local model always passes `"untracked"`**, flag
    on or off. Its replies therefore **settle nothing**: they carry no `answers` (and its rows
    carry `agentIdentity`, which `isFinalClaudeThreadReply` also refuses), so they are never a
    final Claude reply; it never passes through `ownedWrite`, so it never records or is refused
    as an answerer; and it pushes nothing (its rows are local-period activity, `replies.ts`).
    The `tracking` arm `"final"` carries the thread's answerable keys as a required callback, so
    the local model cannot reach `answers` without supplying one.

  As a result, `lifecycle.ts` gains no flag import and `tests/server/ownership-module-seam.test.ts`
  keeps its set.
- **The guard order is unchanged.** `isPrivateForClaude` → `invalid-note` (`:1633`) stays first.
  Only after it is the `author` arm relaxed, for `"user"` + `type === "comment"` under
  `"claude-facing-comment"`.
  - **Rev 3 (Q5, Bryan: "Refuse it (Recommended)").** Right after the relaxed arm, a user parent
    that `hideFromAI(parent, readModeState())` hides answers `not-found` (`NOT_FOUND`), the answer
    a read gives. In the seam, so it covers the local model too; only on the relaxed arm, so a
    Claude-authored parent and every flag-off call are unchanged (and `readModeState` stays off
    Claude's own-parent path, `writeReply`'s ordering note).
  - Every other author (`"import"`) and every other type keeps `not-owned`, so a user highlight
    still answers `NOT_OWNED`.
  - A resolved parent still answers `not-pending` (`:1443`).
  - Promoted notes and promoted Word comments (`author: "user"`, `outbound`) become repliable.
    This is inside the issue's scope, and the description must say so.
- **The `not-owned` remedy with the flag on.** The MCP path passes a `notOwnedRemedy`
  (`lifecycle.ts:441-447`, `:489-496`) that no longer says "answer a user's comment with
  tandem_reply". Proposed text: "only comments take your replies; leave a fresh tandem_comment on
  the text instead". With the flag off, the default text stays byte-identical.
- **`threadItemAnsweredBy` gains the comment item** (`c:` key) when a user-authored parent has no
  visible user reply (its docblock, `:216-217`, reserves this).
- **Claude replies written before this change settle nothing.** Rev 1's Q3 is withdrawn: its
  timestamp fallback would reopen failure 2.
- **A `.docx` comment export skips `inProgress` rows** (`docx-comment-export.ts:360`,
  `prepareExportComments`). An "I'm on it" written into the user's Word file is noise, and with no
  answer after it, it would stand as Claude's last word. `.docx` ships dark, so nothing visible
  changes now.

## 5. PR split

There are three PRs:

- **A** and **B** land dark, in any release.
- **C** is the switch. It lands immediately before the flip PR (series plan PR 6), in the same
  release.

### PR A: the seam, `answers`, acknowledgements, the undo, the load sweep (dark)

Starts with **Carried over from #2573** (below).

**Files and functions:**
- `src/server/annotations/lifecycle.ts`:
  - the two discriminants, passed through `AnnotationLifecycle.reply` (`:785`), `replyForClaude`
    (`:1606`) and `writeReply` (`:1403`);
  - `answers` is computed in `replyForClaude` after both guards, through the new module, and the
    cap and key bound are enforced in `writeReply`;
  - the registry read reaches the seam as an injected predicate, so `lifecycle.ts` does not import
    `awareness.ts`.
- `src/server/mcp/document-store.ts:450` (`YDocStore.addReply`) takes and forwards the
  discriminants and the registry predicate. It joins the census in
  `tests/server/annotation-reply-seam.test.ts`.
- `src/server/annotations/thread-handled.ts` (new, pure, the twin of `chat-handled.ts`):
  - `visibleThreadEntries` (shared with `threadItemAnsweredBy`);
  - `threadEntryKey`;
  - `isFinalClaudeThreadReply`;
  - `settledThreadKeys`;
  - `finiteOrNull`.
- `src/server/mcp/annotations.ts`:
  - the handler (`:1235-1335`) passes `parents`, `tracking` and `notOwnedRemedy` by flag;
  - `threadItemAnsweredBy` (`:218`): the comment item;
  - `recordAnswerer` (`owned-op.ts:296`) does not run for `"in-progress"`;
  - **strip `answers` and `inProgress`** from the reply spread in `tandem_getAnnotations`
    (`channelVisibleReplies(...)` at `:670`) and `tandem_exportAnnotations` (`:1036`). Both go
    through one projection helper, next to the `byLocalModel` strip at `:87`. (The reviewers cited
    `:72-76` and `:970-985`; on `92ff4cc8` the reply spreads are at `:670` and `:1036`.)
- **Tool registration**, built per `McpServer` from the flag, as `tandem_checkInbox` is
  (`awareness.ts:3170-3175`). With the flag on there is a new description and an
  `inProgress?: boolean` input (Q3). With it off, the description and schema stay byte-identical.
- `src/server/annotations/schema.ts`: `AnnotationReplyRecordSchemaV1` (`:185-203`) declares
  `answers` (with both constants) and `inProgress`.
- `src/shared/types.ts`: `AnnotationReply` (`:154`) gains both fields.
- `src/shared/constants.ts`: the two constants.
- `src/server/events/observers/reply-client-undo.ts` (new): the undo and the pending guard.
  `src/server/events/queue.ts` (`attachObservers`, `reattachObservers`) attaches them to every
  document, with the undo ahead of derivation.
- The load sweep (§3), in `queue.ts`'s attach path, plus the envelope meta marker in
  `src/server/annotations/store.ts` and `schema.ts`.
- The CTRL `settles` / `superseded` restore strip, in `src/server/session/manager.ts`
  (`restoreCtrlDoc`), with a CTRL-meta marker.
- `src/server/file-io/docx-comment-export.ts`: skip `inProgress` rows.
- `tests/server/ownership-flip-blockers.ts`: **add** two rows, the pending guard in document rooms
  (§3) and chat `replyTo` on pre-flip forged rows (§3).
- **Rev 3: the second step (§3) lands here, not in PR B.** PR A's tests already exercise it, and
  `answers` is not complete without it. `sessions/ownership.ts` keeps `threadReplyWriter` (it is
  identity plumbing: it holds owner ids), recorded by `owned-op.ts` after an accepted final reply;
  the poll's `acknowledgeCursor` (`awareness.ts`) appends through a new `InboxPollScope` member,
  as chat's `settleHandOut` does. Only a document the caller **holds** at the poll's start is
  appended to. Nothing reads `answers` yet.
- **Rev 3: the envelope marker is set in memory by the load's strip itself** (flag on), and
  reaches the envelope with the post-merge write that strip queues, rather than at "the first
  flag-on write of `answers`". The safety argument is the same (after a flag-on strip, only the
  server can write the fields), and it does not depend on Claude replying before the next close.
  A flag-off load of an envelope carrying the marker strips and rewrites it without the marker.
- `src/server/local-model/tools.ts`: passes `parents` by the flag and `tracking: "untracked"`
  (Q2, rev 3).

**Flag off:** behaviour is byte-identical except for the load sweeps, which remove fields that no
legitimate row carries while the flag is off. A test shows that a store with no such fields loads
byte-identical.

**Flag on:** Claude may reply on a Claude-facing user comment. Final replies carry `answers` and
acknowledgements carry `inProgress`. Client writes and pending structs are undone or dropped on
every document. Nothing reads `answers` yet.

**Tests:**
- **Seam census** (`annotation-reply-seam.test.ts`): importer sets unchanged; both discriminants
  required; only `mcp/annotations.ts` via `document-store.ts` passes `"final"`; `parents` is
  decided by the flag at both producers (`mcp/annotations.ts` and, rev 3, the local model);
  the local model passes `"untracked"` only.
- **Local model (rev 3, Q2):** flag on, it replies on a Claude-facing user comment, and the row
  carries no `answers`, settles nothing, records no answerer and pushes nothing; flag off, it
  keeps `NOT_OWNED`; its privacy refusals are the same table as Claude's.
- **Privacy table** (`replies-privacy-readwrite.test.ts`), flag on and flag off:

  | Parent | Expected |
  |---|---|
  | user note | `INVALID_ARGUMENT` |
  | legacy `flag` | `INVALID_ARGUMENT` |
  | `{comment, private}`, any author | `INVALID_ARGUMENT` |
  | untriaged Word import | `INVALID_ARGUMENT` |
  | user highlight | `NOT_OWNED` |
  | `"import"` outbound comment | `NOT_OWNED` |
  | dismissed user comment | `ANNOTATION_RESOLVED` |
  | Claude-facing user comment | ok flag on; `NOT_OWNED` flag off |
  | promoted note | ok flag on |

  On every refusal nothing is written. With the flag on, the `NOT_OWNED` text does not name
  `tandem_reply`.
- **`answers` contents:**
  - R2, arriving after the last poll, is not listed, and the next acknowledging poll does not
    append it (it was handed after the reply);
  - a session that claims after a lapse lists nothing;
  - a Solo-held reply, and a Solo-edge reply with no stamp that was never handed, are not listed;
  - a private reply is not listed;
  - the second step appends exactly what the acknowledging poll confirmed and was handed before
    the reply;
  - after a restart the second step appends nothing;
  - an edit makes a new key;
  - a non-finite `editedAt` keys as `c:0`.
- **Bounds:** a reply whose keys exceed both bounds is written with the kept prefix, and **the same
  row survives `normalizeReply`** (a store round-trip). The skipped entries stay owed.
- **Answered-once** on a user comment with no replies: a second record is refused `answered`, and
  `inProgress` sets no answerer.
- **Undo:**
  - a `Connection` add, change and delete each revert, and a forged add pushes no event;
  - on an **upload** document;
  - **after a swap** (`reattachObservers`);
  - a non-object old value is not restored;
  - a restore with no origin is not undone.
- **Pending guard:** a document update leaving pending structs is dropped, flag on only.
- **On-disk forgery:** a row with `answers` saved with the flag off settles nothing after a flag-on
  boot, through the envelope path and through the session path. The same holds for a CTRL Claude
  row with `settles`.
- **Projection:** `answers` and `inProgress` are absent from `tandem_getAnnotations` and
  `tandem_exportAnnotations` output, and from the reply event payload.
- **`.docx` export:** an `inProgress` row is not exported.

**Docs:**
- An ADR-054 amendment covering the reworked rule, both bounds, the undo and its scope, the load
  sweep and marker, the chat finding, the gating choice, and the two new rows.
- `docs/mcp-tools.md` `tandem_annotationReply` (`:842-890`): a "ships dark" paragraph.

**Carried over from #2573** (from its review; #2573 merges before PR A):
1. ADR-054's 2026-11-25 "Bryan's flip decisions" amendment must say explicitly that the
   stall-banner row was **closed by its own `closedBy`, Bryan's review**. His pick was "Accept as
   built (Recommended)", described as "Close the row on your acceptance". It is not an
   `acceptedFor` acceptance. The two misfires stay recorded and are checked again in smoke S10.
2. `docs/roadmap.md:58`: the PR 6 bullet still says the flip waits on a decision of Bryan's
   "(#2439 among them)". Change it to say #2439 was decided on 2026-11-25 ("Keep it accepted
   (Recommended)"), and that the stall-banner row is closed.
3. The same amendment claims a new `tests/server/ownership-chat-published.test.ts` row pins the
   with-document arm of `tandemMayTakeMessage`. It does not: after the Release, Tandem's Claude
   holds the document as `default`, so the owned arm answers. Fix the ADR wording. Also add a row
   for an unowned document whose loss names Tandem's Claude, released while Tandem's Claude was
   absent: a message on it reads `tandemMayTake: true` and `heldBy: "document"`.

### PR B: the handled filter (dark). Closes rows H and W

**Files and functions.** Every reader below is gated on the flag.

- **`src/server/mcp/awareness.ts` collectors.** The user-comment arm feeding `userActions`
  (`:3921`), `collectInboxUserReplies` (`:4149`), and their legacy-ledger twins each skip an entry
  whose key is in `settledThreadKeys`.
  - This is exclusion: nothing is logged as dropped (ownership design §6.2).
  - A skipped entry is neither held nor retired. A live registry entry for it is marked
    acknowledged, as §6.4 treats `carryHeld` (`:999-1039`).
- **The second step's append** (§3) runs in the poll's acknowledgement commit.
- **`handOverDocumentInbox` (`awareness.ts:518`).** The retire predicate (`:540-543`) gains "and
  not handled", and the legacy walk (`:550`) keeps handled keys (ownership design §6.3 step 1).
- **`src/server/mcp/inbox-selection.ts`.** `DocumentWaitingInput` gains
  `isHandled?: (annotationId, key) => boolean`, set only with the flag on.
  - `commentWaits` (`:123`), `replyWaits` (`:143`) and `oldestDocumentWaitingAt` use it.
  - `documentWaiting` (`awareness.ts:621`) supplies it.

**Flag off:** byte-identical.

**Flag on:** an answered thread entry is never handed out, re-owed or counted as waiting.

**Moved to PR A in rev 3:** the second step's append (above). PR B keeps every reader of
`answers`.

**Rev 3 (Q6, Bryan: "Yes, start it (Recommended)") lands here, flag-gated.** A user's follow-up
in a thread holding a final Claude reply starts a stopped Claude: the server sets a new
`annotation:reply` payload field (a boolean, computed in `replies.ts` from the thread's rows,
only with the flag on), and `isStartWorthy` (`src/shared/events/wake-scope.ts`) accepts a user
reply carrying it. It is in PR B because it reads final Claude replies, which PR A only writes,
and because it is a start decision next to row W's.

**Tests (these close the rows):**
- **Row H:**
  - `tests/server/ownership-handover.test.ts`: after X answered every entry it was handed, a
    handover re-owes nothing on that thread, to a fresh cursor or a legacy poll;
  - **the Solo regression:** R1 is written in Solo, Claude replies, Solo is released, and R1 is
    handed at the next poll and owed again after a handover;
  - **the window regression:** R2 arrives while Claude answers C, C is handled, and R2 is handed
    out;
  - **forgery plus filter:** a `Connection`'s Claude row is undone and hides nothing, including on
    an upload document and after a swap;
  - **on-disk forgery** across a flag-on boot (from PR A) still hides nothing with the filter
    reading.
- **Row W:** in `tests/server/launcher/ownership-forward.test.ts`, Tandem's Claude holds D and
  answered everything it was handed. A terminal claims D and lapses. The forward starts nothing and
  `tandemWorkWaiting()` is false. With one unanswered reply, the same sequence starts it. The
  agreement table in `ownership-waiting.test.ts` gains handled worlds.
- **Dark row:** flag off, a forged `answers` row hides nothing.

**Rows:**
- Delete row H.
- Delete row W with Bryan's answer to Q4 ("Accept for the flip (Recommended)", 2026-11-26): it
  closes on that acceptance, under the restart row's acceptance and #2484, plus PR B's test. Row W
  cites "the restart row's closer", but the restart row (`:256`) is accepted, not closed, so that
  closer does not exist; the acceptance stands in for it.

**Docs:**
- An ADR-054 amendment on the filter as built and the residuals (§8).
- `*[Amended: …]*` notes on ownership design §6.4's first two bullets and its "later" sentence.
- **`docs/security.md`, a new register entry** (rev 1's "no change" was wrong). It describes the
  client-writable Y.Map threat to `answers` and its bound:
  - the replies-map undo, the pending guard and the load sweep stop forgery through that map;
  - parent-record edits in `Y_MAP_ANNOTATIONS` (`author`, `audience`, `status`, an `editedAt`
    rewind) can still hide a comment;
  - pre-PR-A forged chat `replyTo` rows remain (the new chat row).

  Filed as **accepted (bounded)** under ownership design D4 (Q7, Bryan: "Accepted, bounded
  (Recommended)", 2026-11-26), with its bound (the three bullets above) and its void conditions
  (the replies-map undo, the pending guard or the load sweep is removed or narrowed; a client
  write to `Y_MAP_ANNOTATION_REPLIES` comes to be accepted; `answers` comes to gate anything but
  the inbox's handled filter). It stays in PR B, which is where the filter that the entry bounds
  first reads `answers`. CLAUDE.md's Security bullet count and
  `tests/docs/security-findings-claims.test.ts` move with it, in PR B.

### PR C: the switch (live text). Lands immediately before the flip PR, same release. Closes row S

**What it changes:**
- `skills/tandem/SKILL.md:59` and `:65`, rewritten to say:
  - answer a user's comment in its own thread with `tandem_annotationReply`;
  - use chat for anything that is not about one comment;
  - the user's card text stays theirs, so `tandem_editAnnotation` still refuses;
  - mark an "I'm on it" in a thread with `inProgress: true` (Q3: yes);
  - notes, private comments, highlights and resolved threads still refuse.

  The frontmatter `version` (41 today) goes up once if this rides with the flip's other skill
  edits. `refreshExistingSkillIfStale` refreshes only on a strictly newer version. The plugin's
  pinned ref moves with the flip.
- `docs/mcp-tools.md`: the live `tandem_annotationReply` text replaces the "ships dark" paragraph.
- `src/server/local-model/tools.ts`: `reply_to_annotation`'s description stops saying a user's
  comment cannot be replied to (rev 3, Q2). It is model-facing text, so it moves with the skill
  rather than in PR A, where it would be wrong only while the flag is on in development.
- `CHANGELOG.md` Unreleased: Claude answers your comment in its thread, and the v0.31.0 chime and
  notification now fire.
- Delete row S.

**Ordering.** C merges, then the flip PR, then the release is cut. If the flip slips past a cut, C
must not be in that release. The alternative is to fold C into the flip PR (Q1).

## 6. Privacy (ADR-027)

- The guard order in `replyForClaude` is unchanged. `isPrivateForClaude` (`lifecycle.ts:282`) runs
  first, on the sanitized record, and `answers` is computed only after both guards. Only the author
  arm is relaxed, and only for `type === "comment"`. A Claude reply can never land in a note
  thread, a private comment's thread or a highlight.
- `addUserReply` and `removeAnnotationRecord` stay unguarded. Their seam pins hold.
- `answers` comes only from the visible-and-handed entries, and is stripped from every
  Claude-facing output.

## 7. Questions only Bryan can answer

**Q1. How "the switch merges right before the flip, in the same release" is honoured.**
- (a) The server permission is gated on `OWNERSHIP_ENABLED` and lands dark in PR A. PR C (skill and
  docs) merges right before the flip. *(Recommended: the server half cannot ship without ownership
  whatever slips.)*
- (b) As (a), with PR C folded into the flip PR.
- (c) Literal: an ungated permission in its own PR merged right before the flip. A release cut in
  between would ship it without ownership.
- **Answer.** Bryan, 2026-11-26: **"Gate it, skill last (Recommended)"** — (a).

**Q2. The local model** (`reply_to_annotation`, `local-model/tools.ts:519`).
- (a) It keeps `NOT_OWNED` on user comments (`"own"`, `"untracked"`). *(Recommended: Bryan's
  decision named Claude, and the local model is outside ownership.)*
- (b) It may reply on user comments, settling nothing.
- **Answer.** Bryan, 2026-11-26: **"Yes, settles nothing"** — (b), not the recommendation. Applied in §4 and §5 (rev 3): the same flag gate as Claude's permission, `tracking: "untracked"`.

**Q3. An "I'm on it" inside a thread** (ownership design §5.5 requires a marker).
- (a) An `inProgress` input, flag on only: it settles nothing, sets no answerer, and is not exported
  to `.docx`. *(Recommended: it matches `tandem_reply`.)* The v0.31.0 chime fires twice, once for
  the acknowledgement and once for the answer.
- (b) No in-thread acknowledgement. The skill acknowledges in chat, and every thread reply is
  final.
- **Answer.** Bryan, 2026-11-26: **"Yes, as in-progress (Recommended)"** — (a).

**Q4. What row W says the filter cannot see.** That is a comment answered in chat or by an edit,
handled state lost at a restart, and (new in rev 2) an answer given from a push before any poll
acknowledged the entry. That last case fails safe: the entry is owed again.
- (a) Accept these for the flip, under the restart row's acceptance and #2484. Row W closes on that
  answer plus PR B's test. *(Recommended.)*
- (b) Keep row W open until chat answers are linked to comments.
- **Answer.** Bryan, 2026-11-26: **"Accept for the flip (Recommended)"** — (a). Recorded now; row W is deleted in PR B.

**Q5. Claude replying to a user comment the Solo hold hides** (`hideFromAI`, `mode.ts:89`).
- (a) Refuse it as an unknown id is refused (`NOT_FOUND`), the same answer a read gives. *(Recommended:
  a read filter is not a write guard, #1680. In Solo Claude cannot see the comment, so it should
  not write into it.)*
- (b) Accept it. With the registry rule it settles nothing, and a later release re-owes the thread.
- **Answer.** Bryan, 2026-11-26: **"Refuse it (Recommended)"** — (a). In the seam (§4, rev 3).

**Q6. A user's follow-up in their own thread that Claude answered.** Its parent is the user's, so
`isStartWorthy` (`src/shared/events/wake-scope.ts:57-64`) does not start a stopped Claude for it.
It waits for the next start, while still counting as owed and as a wake.
- (a) Start-worthy when the thread holds a final Claude reply. This needs an `annotation:reply`
  payload field set by the server. It is inert until Claude can reply there. *(Recommended: the
  user is talking to Claude, which is Bryan's line for a start.)*
- (b) Leave it: only chat and replies on Claude's own threads start Claude.
- **Answer.** Bryan, 2026-11-26: **"Yes, start it (Recommended)"** — (a). Lands in PR B, flag-gated (§5, rev 3).

**Q7. The new `docs/security.md` entry** (a client can hide a comment from every inbox by editing
the parent record; forged pre-flip chat `replyTo` rows).
- (a) File it as accepted (bounded) under ownership design D4 (coordination, not security), with
  its void conditions. *(Recommended.)* This needs Bryan's own acceptance: one made during review
  does not count (#1602).
- (b) File it as open, owed a fix before the flip (for example a server-only parent fingerprint
  inside `answers`).
- **Answer.** Bryan, 2026-11-26: **"Accepted, bounded (Recommended)"** — (a). Filed in PR B (§5).

## 8. Risks, residuals, and what each reviewer looks at

- **annotation-model-reviewer:**
  - the guard order and both discriminants;
  - that `answers` is computed after the guards from the sanitized record;
  - the bounds' parity with `normalizeReply`;
  - the origins (`withMcp` for the reply; `withInternal` for the undo, the sweep and the append);
  - promoted notes becoming repliable.
- **crdt-reviewer:**
  - the undo-before-derivation order under one observer;
  - the pending guard's premise in document rooms (the new row);
  - the sweep's timing after the swap and file-sync rebind;
  - the second step's write racing the user's edits.
- **security-reviewer:**
  - the guarantee's stated scope;
  - attachment on every room;
  - the envelope marker's unforgeability;
  - the chat finding;
  - Critical Rule 9;
  - the register entry.
- **The series' own review:**
  - that "live entries on a held document were the holder's" holds for claim-less legacy polls and
    for the claimable-unowned case (§3's condition (c));
  - that the notice rule survives the retire exclusion;
  - collector / waiting agreement;
  - that flag off stays byte-identical except for the sweeps.
- **svelte-migration-reviewer:** only if Q3(a) changes how `inProgress` thread rows render.
- **Closed in PR B (2026-11-26): PR A's known gap.** Condition (b) accepted any reader's
  acknowledgement once the caller held. PR B counts only registry entries registered above the
  caller's hold mark (`OwnershipEntry.holdSinceSeq`, kept across a same-holder rewrite) in both steps; ADR-054's #2360 PR B amendment
  records why that was chosen over retiring entries at a claim.
- **Residuals for the ADR:**
  - answers in chat or by an edit;
  - an answer from a push before acknowledgement, or after a restart (owed again: fails safe);
  - entries over the bounds (owed again);
  - pre-flip forged chat `replyTo` rows (new row);
  - a parent-record rewrite or `editedAt` rewind by a client (D4; security.md);
  - a reply on a document not open at a Solo release that keeps a stale `heldInSolo` marker
    (`mode-release.ts:106`). It is never listed, so it fails safe. Check whether opening the
    document clears the marker.
- **PR B departure (2026-11-26, from its code review).** §5's "a live registry entry for it is
  marked acknowledged" and the handover's "and not handled" are not built: a handled item's entry
  is retired like any other, so a handled mark that is later lost (the load sweep on an untrusted
  room) re-owes the item instead of leaving it read as delivered. ADR-054's #2360 PR B amendment
  records it.

## 9. Review dispositions

| Item | Disposition |
|---|---|
| B1: cap at write time, normalized key, bound skips, oldest kept, `normalizeReply` survival test | Fixed (§3 Bounds; PR A tests). |
| B2: list only entries handed to this owner | Fixed: adopted rev 1's Q2(c), with chat's two-step append for the poll → reply → poll flow (§3). Rev 1's Q2 is dropped. |
| B3: undo on every room, upload and scratchpad included, reattached after swap | Fixed (§3; `attachObservers` / `reattachObservers`; upload and swap tests). |
| B4: forged rows on disk; chat check | Fixed: a flag-off strip on load from PR A on, plus a flag-on strip unless the server-only envelope marker is set (§3). Chat `settles` / `superseded` get the same; chat `replyTo` is recorded as a new flip-blocker row and in the security entry. |
| Pending-structs guard | Fixed (§3), and its premise in document rooms is a new flip-blocker row. |
| Undo before derivation; plain-object restore; no event on a forged add | Fixed (§3; tests). |
| `answers` computed inside `replyForClaude`; `document-store.ts` in files and census | Fixed (§4, PR A). The review's `document-store.ts:439` is `:450` on `92ff4cc8`. |
| Strip `answers` / `inProgress` from getAnnotations and export | Fixed (PR A). The real sites are `:670` and `:1036`, not the cited lines. |
| Scope the guarantee; security.md entry warranted | Fixed (§3 "What the guarantee covers"; PR B docs; Q7). Rev 1's "no change" is withdrawn. |
| Solo: refuse or accept a reply to a hidden parent | Made Q5 (recommend refuse). |
| Flag-on `notOwnedRemedy` | Fixed (§4). |
| `isStartWorthy` for a follow-up in the user's thread | Made Q6. |
| `.docx` export of `inProgress` rows | Decided: skip them (§4). |
| Local model's `ReplyTracking` | Stated: `"untracked"`, with `parents: "own"` (§4; Q2). |
| Pre-flip forged rows and `editedAt` rewind as residuals | Recorded (§8; security entry). |
| Rev 1's Q3 (legacy rows, timestamp fallback) | Withdrawn on the merits: a fallback reopens failure 2. Legacy rows settle nothing (§4). |
| Rev 3: Bryan's answers (2026-11-26) | Recorded under each question in §7, verbatim. |
| Rev 3: Q2 differs from the recommendation | The local model may reply in a user's Claude-facing comment thread, behind the same flag, settling nothing (`tracking: "untracked"`): §4, §5's census, PR A's tests. Its model-facing description moves in PR C. |
| Rev 3: Q5 | The Solo refusal is in the seam, on the relaxed arm only (§4). |
| Rev 3: Q6 placement | PR B, flag-gated (§5): it reads final Claude replies, which PR A only writes. |
| Rev 3: second step placement | Moved to PR A (§5), since PR A's own tests exercise it; it lives in `sessions/ownership.ts` (owner ids) and runs in `acknowledgeCursor`. |
| Rev 3: envelope marker timing | Set in memory by the flag-on load strip and written with its post-merge write (§5); the same safety argument, with no dependence on a reply before close. |
