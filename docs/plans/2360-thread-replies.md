# Plan: #2360, Claude replies inside a user's comment thread

**Plan rev 1, 2026-11-25.** Issue #2360 (Bryan). Tied to #2358 (multi-session ownership,
ADR-054, ships dark behind `OWNERSHIP_ENABLED`). Cites are to `origin/master` `92ff4cc8`.
"Ownership design §N" means `docs/spikes/multi-session-ownership/README.md`; "the series plan" is
`docs/plans/2358-ownership.md`. This plan writes no code; each PR below gets its own adversarial
review before code, per CLAUDE.md's workflow.

## 1. The problem

`tandem_annotationReply` refuses a user-authored parent with `NOT_OWNED`
(`src/server/annotations/lifecycle.ts:1643-1645`, `replyForClaude`), and the shipped skill tells
Claude to answer user comments in chat (`skills/tandem/SKILL.md:59`, `:65`). In the v0.30.0 Linux
smoke (#2349) Bryan saw the answer land in chat, "which is not really the desired behavior".

The ownership series also needs this. Its three open flip-blocker rows on it
(`tests/server/ownership-flip-blockers.ts`):

| Row | Line | Gap, in short | `closedBy` |
|---|---|---|---|
| H, the handled filter | :74 | Without ownership design §6.4's first two bullets, an answered comment or reply is re-owed by every handover. Without stripping client-written Claude replies, a browser client could hide a comment from every inbox. | "The PR that lets Claude reply on a user's comment thread (#2360), after its 'later reply' rule is reworked (as designed it would lose a user reply written during Solo)." |
| S, the switch | :204 | "#2360's switch has not merged (decisions 5 and 6 …)." | "#2360's switch PR merged." |
| W, answered work starts Tandem's Claude | :344 | After any handover or restart, every user comment and thread reply reads as waiting, so it starts or wakes Tandem's Claude again for work already answered. | "The handled filter (#2360), with a test where a lapse of a holder that answered everything in its threads starts nothing; for what it cannot see (answers in chat or by an edit, state lost at a restart), the restart row's closer or Bryan's answer." |

## 2. Decisions already made

- **#2360, 2026-11-04.** Bryan chose "allowing Claude to reply inside a thread the user started"
  over a chat answer linked to the comment, or deciding later. The scope is in the issue: user
  `type: "comment"` parents that are Claude-facing. Every other refusal stays: notes (ADR-027),
  private (non-outbound) comments, highlights and resolved threads. `tandem_editAnnotation` keeps
  `NOT_OWNED`.
- **The series plan, Bryan's decisions of 2026-11-04** (`docs/plans/2358-ownership.md:13-25`):
  - decision 5: "#2360's switch lands after ownership";
  - decision 6: "comments should get answered with replies to the comment directly, not in the
    chat";
  - confirmed reading (`:330`): "#2360's switch merges right before the flip, in the same
    release".
- **Already shipped live for #2360 in v0.31.0** (CHANGELOG `:83-86`, `:102`). A Claude answer in a
  user's thread chimes and notifies ("Claude replied to your comment"; `useThreadAnswers.svelte.ts`,
  `Y_MAP_REPLY_SEEN`). The user can Resolve their own comment (`dismissed`). Accept replacement is
  "prepared" for user comments that carry a usable `textSnapshot`. So both of the issue's open
  questions already have answers, and this plan adopts them:
  - **No new event or UI.** Claude's reply is a `withMcp` write, so it derives no channel event
    (Critical Rule 2). The client already gives it its own treatment.
  - **`suggestedText` is allowed.** The parent's live span is screened by
    `screenSuggestionSpan` (`lifecycle.ts:1574`, Critical Rule 6's interior term) exactly as on
    Claude's own threads. The client's Accept on a user comment is already gated on the snapshot.
- **Refusal order** (ownership design §5.1, `:257`): `NOT_DOC_OWNER` (including
  `reason: "answered"`) comes before any lifecycle refusal. `ownedIdKeyed` already runs before
  the body (`src/server/mcp/annotations.ts:1257-1335`, `owned-op.ts:236-300`).

## 3. The "later reply" rule, and why it loses a reply

Ownership design §6.4 (`:356-362`) says a user comment at a given `editedAt`, or a user thread
reply, is handled when the thread has "a later final Claude reply". "Later" compares timestamps.

**The loss, as the row says.** During Solo, the user writes reply R1, which is stamped
`heldInSolo` (`lifecycle.ts:1476-1478`). `hideFromAI` hides it (`src/server/mode.ts:89-96`), so
Claude cannot see it. Claude then replies on the same thread, for example to a chat request about
an item it saw before Solo. When Solo lifts, `mode-release.ts:19-48` removes the marker but keeps
R1's timestamp. R1 is now earlier than a final Claude reply, so the filter calls it handled, and
it is never handed to anyone.

**The same loss without Solo.** In Tandem mode, a user reply written between Claude's read and
Claude's reply is also earlier than that reply. A timestamp cannot tell "answered" from "arrived
while Claude was typing".

**A second defect in the comment bullet.** A user comment is written by the browser straight into
`Y_MAP_ANNOTATIONS`, so its `timestamp` and `editedAt` come from the client's clock. Claude's
reply `timestamp` comes from the server (`writeReply`, `lifecycle.ts:1451`). The design's "server's
own timestamps where both sides have one" never holds for the comment bullet.

**The rework: what a reply answers is recorded on the reply, at write time.** A final Claude reply
carries a new server-only field, `answers: string[]`. It holds the thread's user entries that
Claude could see at the moment the reply was accepted, using exactly the read gates
`threadItemAnsweredBy` uses (`annotations.ts:218-243`): `narrowForChannel` on the parent,
`hideFromAI(parent, mode)`, `channelVisibleReplies`, `author === "user"`, and
`!isHeldInSoloMarker`. Entries that an earlier final Claude reply on the thread already settles
are not listed again, so the total stays linear in the thread's length. The keys:

- `"c:" + (editedAt ?? 0)` for the parent comment, only when it is user-authored;
- `"r:" + replyId` for a user reply. This is the answerer key already in use
  (`annotations.ts:239`, registry kind `"r"` version 0, `inbox-selection.ts:156`).

An entry is **handled** when a final Claude reply on its thread lists its key. No clock is
compared. This handles the two cases above:

- **Solo.** A held reply is not visible, so it is not listed. In Solo, `hideFromAI` hides every
  user record, so a reply written in Solo lists nothing at all. Both stay owed after release.
- **An edit.** A comment edited after the answer has a new `editedAt`, so it gets a new key and is
  owed again, as the design intends.

The race stays as a residual (Q2): an entry the user wrote in the seconds between Claude's read
and Claude's accepted reply is visible at accept time, so it is listed.

**Final** means `author === "claude"`, no `agentIdentity` (the local model's), no `inProgress`,
and `Array.isArray(answers)`. This mirrors `isFinalClaudeReply` in
`src/server/mcp/chat-handled.ts:24-32`. Rows written before this change have no `answers`; Q3
covers them.

**What gets stripped, and why.** The design says a client-written `settles`, `superseded` or
Claude-authored reply must not count, "so a client cannot hide an item from every inbox". Without
this, any editor connection could add a reply row with `author: "claude"` and `answers: [...]`,
and the comment would read as handled for every session.

The browser never writes `Y_MAP_ANNOTATION_REPLIES`. Every reply goes through a server POST or the
MCP seam (`writeReply`, `lifecycle.ts:1487-1490`; there is no client `set` or `delete` on that
map). So the rule is simpler than chat's field-level one (`chat-client-undo.ts`): with ownership
on, **every change to the replies map whose origin is a Hocuspocus `Connection` is undone**. An add
is deleted, a changed value is put back, and a delete is restored. This is one `withInternal`
transaction inside the replies observer, keyed on the `Connection` origin the same way
`chat-client-undo.ts` keys it.

## 4. Choices made here (not for Bryan)

- **The permission is gated on `OWNERSHIP_ENABLED`.** Of everything Bryan decided, this honours
  decision 5 most strictly. The permission cannot reach users before ownership does, and it
  reaches them in the same release by construction, whatever slips. Ungated, it would be live from
  its merge, and any release cut before the flip would ship it without ownership, which decision 5
  forbids. Q1 asks Bryan to confirm this reading of "merges right before the flip".
- **Critical Rule 9 is unaffected.** `tandem_annotationReply` is already behind the `/mcp`
  admission point. This adds no `subscribe(cb, "external")` consumer, no `appendClaudeChatMessage`
  caller and no `/api` route. The undo observer is server-side state repair, not an AI surface.
  The `tests/server/license-gate-api-coverage.test.ts` and `ai-surface-inventory-claims` sets do
  not change.
- **The seam takes the policy as a required discriminant.** It does not read the flag itself, the
  way the suggestion arm does (CLAUDE.md Rule 6). `replyForClaude` gains
  `parents: "own" | "claude-facing-comment"`:
  - the MCP handler passes `ownershipOn() ? "claude-facing-comment" : "own"`;
  - the local model (`local-model/tools.ts:519`) passes `"own"` (Q4).

  So `lifecycle.ts` gains no flag import, `tests/server/ownership-module-seam.test.ts` keeps its
  set, and a new caller cannot default into the wider half.
- **The guard order is unchanged.** `isPrivateForClaude` → `invalid-note` (`:1633`) stays first,
  and only then is the `author` arm relaxed: `"user"` + `type === "comment"` passes under
  `"claude-facing-comment"`. Every other author (`"import"`) and every other type keeps
  `not-owned`, so a user highlight still answers `NOT_OWNED` as today. Resolved parents still
  answer `not-pending` from `writeReply` (`:1443`). A promoted note or promoted Word comment is
  stored `author: "user", type: "comment", audience: "outbound"`, so it becomes repliable. That is
  inside the issue's scope ("Claude-facing"), and the tool description must say so.
- **`threadItemAnsweredBy` gains the comment item.** When a user-authored parent has no visible
  user reply, it returns `c:<editedAt ?? 0>`. Its docblock (`:216-217`) already reserves this
  for #2360. Answered-once (ownership design §5.5) then covers a user comment with no replies.
- **A reply written in Solo is accepted and settles nothing.** The answers set is computed through
  `hideFromAI`, so it is empty. No new refusal arm is added, and nothing a read would hide is
  disclosed beyond what the success already shows: the id was known to the caller.

## 5. PR split

Three PRs. A and B land dark, in either release. C is the switch and lands immediately before the
flip PR (series plan PR 6), in the same release, as Bryan confirmed.

### PR A: the seam, `answers`, in-thread acknowledgement, the undo (dark)

Starts with **Carried over from #2573** (below).

**Files and functions:**
- `src/server/annotations/lifecycle.ts`:
  - `ReplySuggestion`'s sibling: a new required `ReplyTracking` arm,
    `{kind: "untracked"} | {kind: "final"; answers: string[]} | {kind: "in-progress"}`, passed
    through `AnnotationLifecycle.reply` (`:785`), `replyForClaude` (`:1606`) and `writeReply`
    (`:1403`). `writeReply` writes `answers` only for `"final"` and `inProgress: true` only for
    `"in-progress"`, and writes nothing new for `"untracked"`.
  - The `parents` discriminant (§4).
  - The `describeReplyWriteRefusal` `not-owned` default remedy (`:489-496`) is unchanged. It
    still applies to `"own"` callers and to non-comment user parents.
- `src/server/annotations/thread-handled.ts` (new, pure, the twin of `chat-handled.ts`):
  - `threadEntryKeys(parent, visibleReplies)`, the visible user entries;
  - `isFinalClaudeThreadReply(reply)`;
  - `settledThreadKeys(repliesMap): Set<"<annotationId>\0<key>">`.

  It imports types and `shared/` only, so `awareness.ts`, `inbox-selection.ts` and `lifecycle.ts`
  can share it without a cycle.
- `src/server/mcp/annotations.ts`:
  - The handler (`:1235-1335`). With ownership on it computes `answers`: `threadEntryKeys`
    minus `settledThreadKeys` for this parent, in the same synchronous run as `store.addReply`,
    with no `await` between them. It passes `{kind: "final", answers}`, or `{kind: "in-progress"}`
    when the new `inProgress` input is true. With ownership off it passes `{kind: "untracked"}`
    and `"own"`.
  - `threadItemAnsweredBy` (`:218`): the comment item.
  - `owned-op.ts:296`'s `recordAnswerer` must not run for an in-progress reply (ownership design
    §5.5: an acknowledgement sets no answerer). Pass the tracking kind through `answers?` or skip
    the record.
- **Tool registration.** The registration is built per `McpServer` from the flag, as
  `tandem_checkInbox` is (`awareness.ts:3170-3175`). Flag on, it gets a new description and an
  `inProgress?: boolean` input (Q5). Flag off, the description and schema stay byte-identical.
- `src/server/annotations/schema.ts`: `AnnotationReplyRecordSchemaV1` (`:185-203`) declares
  `answers` (array of bounded strings, capped) and `inProgress`. They are listed for type safety,
  as `suggestedText` was.
- `src/shared/types.ts` `AnnotationReply` (`:154`): the two fields, documented server-only.
- **Projection.** `answers` never reaches a Claude-facing read. Check that `replyPayload` and
  `channelVisibleReplies`' output and `output-schemas.ts`' reply shapes are allowlists. If one
  spreads, strip `answers` there. `inProgress` may be projected, so Claude can see its own
  acknowledgement.
- `src/server/events/observers/reply-client-undo.ts` (new). Called from `makeRepliesObserver`
  (`events/observers/replies.ts:19`) only when the flag is on. It undoes every change to the
  replies map whose origin is a `Connection` (§3).

**Flag off:** byte-identical. The seam is called with `"own"` and `"untracked"`, which is today's
behaviour and today's stored row. The tool's `tools/list` entry is unchanged and the observer is
not installed.
**Flag on:** Claude may reply on a Claude-facing user comment. Final replies carry `answers`,
acknowledgements carry `inProgress`, and client writes to the replies map are undone. Nothing
reads `answers` yet.

**Tests:**
- `tests/server/annotation-reply-seam.test.ts`: the importer sets are unchanged. Add a row that
  the seam's `parents` argument is required, so a call without it does not type-check. Add a
  census row for `"claude-facing-comment"`: only `mcp/annotations.ts` passes it.
- A privacy table in `tests/server/replies-privacy-readwrite.test.ts`, flag on and flag off:
  - user note → `INVALID_ARGUMENT`;
  - legacy `flag` (normalises to a note) → `INVALID_ARGUMENT`;
  - `{comment, audience: "private"}` (user, Claude and import author) → `INVALID_ARGUMENT`;
  - untriaged imported Word comment (`type: "note"`, private) → `INVALID_ARGUMENT`;
  - user highlight → `NOT_OWNED`;
  - `"import"`-authored outbound comment → `NOT_OWNED`;
  - resolved (`dismissed`) user comment → `ANNOTATION_RESOLVED`;
  - Claude-facing user comment → ok flag on, `NOT_OWNED` flag off;
  - promoted note → ok flag on.

  On every refusal the map is unchanged and no reply row is written into any note thread.
- `answers` contents:
  - a Solo-held reply is excluded, and a reply written in Solo lists nothing;
  - a private reply is never listed;
  - an earlier settled key is not re-listed;
  - an edit makes a new comment key.
- Answered-once on a user comment with no replies: a second record is refused
  `reason: "answered"`, and an `inProgress` reply sets no answerer.
- The undo: a `Connection`-origin add, change and delete each revert, flag on. Flag off, nothing
  is undone. A restore with no origin is never undone.
- `suggestedText` on a user comment: a heading overlap gives `INVALID_ARGUMENT` with the cause,
  and a clear span stores the reply.

**Docs:**
- An ADR-054 amendment: the reworked rule, the undo, and the gating choice.
- `docs/mcp-tools.md` `tandem_annotationReply` (`:842-890`): a "ships dark" paragraph. The live
  text changes in PR C.
- No `docs/security.md` change: no route, no exposure, and the undo narrows what a client can do.
  The security reviewer confirms this.

**Carried over from #2573** (its review; #2573 merges before PR A):
1. ADR-054's 2026-11-25 "Bryan's flip decisions" amendment must say explicitly that the
   stall-banner row was **closed by its own `closedBy`, Bryan's review**. His pick was "Accept as
   built (Recommended)", described as "Close the row on your acceptance". It is not an
   `acceptedFor` acceptance. The two misfires stay recorded and are checked again in smoke S10.
2. `docs/roadmap.md:58`: the PR 6 bullet still says the flip waits on a decision of Bryan's
   "(#2439 among them)". Say instead that #2439 was decided on 2026-11-25 ("Keep it accepted
   (Recommended)") and that the stall-banner row is closed.
3. The same amendment claims a new `tests/server/ownership-chat-published.test.ts` row pins the
   with-document arm of `tandemMayTakeMessage`. It does not: after the Release, Tandem's Claude
   holds the document as `default`, so the owned arm answers. Fix the ADR wording. Also add a row
   for an unowned document whose loss names Tandem's Claude, released while Tandem's Claude was
   absent: a message on it reads `tandemMayTake: true` and `heldBy: "document"`.

### PR B: the handled filter (dark). Closes rows H and W

**Files and functions** (every reader is gated on the flag):
- `src/server/mcp/awareness.ts`, the cursor and legacy collectors:
  - the user-comment arm of `processInboxAnnotations` (`userActions`, `:3921`);
  - `collectInboxUserReplies` (`:4149`);
  - their legacy-ledger twins.

  Each skips an entry whose `<annotationId>\0<key>` is in `settledThreadKeys`. This is exclusion
  with nothing logged as dropped, as ownership design §6.2 excludes. On the registry: a skipped
  entry is neither held nor retired. If its live entry is still there, it is marked acknowledged,
  the way §6.4's notice bullet treats `carryHeld` (`:999-1039`), so the filter never retires what
  it depends on.
- `handOverDocumentInbox` (`awareness.ts:518`). The retire predicate (`:540-543`) gains "and not
  handled". The legacy ledger walk (`:550`) keeps the keys of handled items. This is ownership
  design §6.3 step 1's "and that is not handled".
- `src/server/mcp/inbox-selection.ts`: `DocumentWaitingInput` gains
  `isHandled?: (annotationId, key) => boolean`, set only with the flag on. `commentWaits` (`:123`)
  and `replyWaits` (`:143`) return false for a handled entry, and so does `oldestDocumentWaitingAt`.
  `documentWaiting` (`awareness.ts:621`) supplies it.
- Q3's answer decides whether rows without `answers` count.

**Flag off:** byte-identical. The predicate is unset and every reader returns on the flag.
**Flag on:** an answered thread entry is never handed or re-owed, and never counts as waiting.

**Tests (these close the rows):**
- **Row H:**
  - `tests/server/ownership-handover.test.ts`: a handover after
    X answered every entry in a thread re-owes nothing on that thread. The next owner's fresh
    cursor is handed nothing, and a legacy poll too.
  - The Solo regression: R1 written in Solo, then a Claude reply, then release. R1 is handed at
    the next poll, and is owed again after a handover.
  - The race row as Q2 decides.
  - Undo plus filter: a `Connection` writes a Claude reply with `answers` naming the user's
    comment. It is undone, and the comment is still handed to a fresh reader.
- **Row W:** `tests/server/launcher/ownership-forward.test.ts`. Tandem's Claude holds D and
  answered everything in its threads. A terminal claims D and then lapses, so D goes back to
  Tandem's Claude. The forward starts nothing and `tandemWorkWaiting()` is false. The same with one
  unanswered user reply starts it. The agreement table in `tests/server/ownership-waiting.test.ts`
  gains handled worlds (a fresh poll and `isDocumentWaiting` agree).
- The `ownership-flag-on` CI job: all green flag on. A dark row pins that, flag off, a
  forged `answers` row hides nothing and the observer is absent.

**Rows:**
- Delete row H.
- Delete row W only with Bryan's answer to Q6, which covers what the filter cannot see. The
  restart row (`:256`) is accepted, not closed, so "the restart row's closer" does not exist yet.
  Row W's `closedBy` therefore resolves to "Bryan's answer".

**Docs:**
- An ADR-054 amendment: the rule as built, the residuals, and the rows closed.
- Mark ownership design §6.4's first two bullets and the "later" sentence as amended by it. This
  is the series' convention of `*[Amended: …]*` notes, so the merged text is not rewritten.

### PR C: the switch (live text). Lands immediately before the flip PR, same release. Closes row S

**What it changes:**
- `skills/tandem/SKILL.md:59` and `:65`, rewritten:
  - answer a user's comment in its own thread with `tandem_annotationReply`;
  - use chat for anything not about one comment;
  - the user's card text stays theirs, so `tandem_editAnnotation` still refuses;
  - an "I'm on it" in a thread passes `inProgress: true` (if Q5 is yes);
  - notes and private comments still refuse.

  Bump the frontmatter `version` (41 today). Use one bump if it rides with the flip's own skill
  edits. Per CLAUDE.md, `refreshExistingSkillIfStale` refreshes only on a strictly newer version,
  so a text edit at an unchanged version reaches nobody. The plugin's pinned ref moves with the
  flip (series plan, PR 6).
- `docs/mcp-tools.md` `tandem_annotationReply`: the live text, with the "ships dark" paragraph
  removed at the flip.
- `CHANGELOG.md` Unreleased: the user-facing line. Claude answers your comment in its thread, and
  the v0.31.0 chime and notification now fire.
- Delete row S.

**Ordering.** C merges, then the flip PR merges, then the release is cut. If the flip slips past a
release cut, C must not be in it. The skill would then tell Claude to reply where a dark server
answers `NOT_OWNED`.

**Alternative.** Fold C into the flip PR (Q1). Then "merged" and "shipped" cannot diverge.

## 6. Privacy (ADR-027)

- The guard order in `replyForClaude` is unchanged. `isPrivateForClaude` (`lifecycle.ts:282`)
  runs first, on the **sanitized** record, so a legacy `flag` is caught as a note. Only the
  following author arm is relaxed, and only for `type === "comment"`. So a Claude reply can never
  be written into a note thread, a private comment's thread, or a highlight.
- `addUserReply` and `removeAnnotationRecord` stay unguarded and unchanged.
  `annotation-reply-seam.test.ts` and `annotation-remove-seam.test.ts` keep their pins.
- `answers` is built only from what `channelVisibleReplies` and the Solo gate return, and is never
  projected to Claude. Even a wrong key could not disclose a private reply's id.
- Row H's undo also stops a client from **deleting** a Claude reply to make an entry owed again.
  That direction is safe anyway.

## 7. Questions only Bryan can answer

**Q1. How "the switch merges right before the flip, in the same release" is honoured.**
- (a) The permission is gated on `OWNERSHIP_ENABLED` and lands dark in PR A. PR C (skill and docs)
  merges right before the flip. *(Recommended: the server half cannot ship without ownership
  whatever slips. Only the live skill text needs the ordering.)*
- (b) As (a), but PR C is folded into the flip PR.
- (c) Literal: an ungated permission in its own PR, merged right before the flip. A release cut
  from master in between would ship it without ownership.

**Q2. A user reply written while Claude is composing its answer.** It is visible when Claude's
reply is accepted, so it is listed as answered and is never handed (§3).
- (a) Accept it as a known limit, recorded in the ADR. The window is the time between Claude's
  read and its reply. *(Recommended for the flip. The Solo case, which runs for hours, is fixed.)*
- (b) Add an optional `answering: <replyId | "comment">` input. Claude names what it answered, and
  only that and earlier entries are listed. It is exact, but needs a skill rule and a schema
  field.
- (c) List only entries some poll or push already handed. This depends on the delivery registry,
  which a restart empties.

**Q3. Claude replies written before this change** (no `answers`, on Claude's own threads).
- (a) They settle nothing. Every old user reply on Claude's threads is re-owed at each handover,
  as today. *(Recommended: simplest, and the lone-session re-hand is already accepted.)*
- (b) Fall back to "earlier than the Claude reply by server timestamp", for user replies only
  (both clocks are the server's). A row a modified client wrote before the flip would then count,
  because the undo was not running.

**Q4. The local model** (`reply_to_annotation`, `local-model/tools.ts:519`).
- (a) Keep `NOT_OWNED` on user comments. Its replies settle nothing (`agentIdentity`).
  *(Recommended: Bryan's decision named Claude, and the local model is outside ownership.)*
- (b) Let it reply on user comments too, still settling nothing.

**Q5. An "I'm on it" inside a thread.** Ownership design §5.5 says #2360 must mark one, or it
counts as the answer.
- (a) Add an `inProgress` input, flag on only. The row settles nothing and sets no answerer.
  *(Recommended: it matches `tandem_reply`.)* The v0.31.0 chime fires on it and again on the
  answer.
- (b) No in-thread acknowledgement. The skill says to acknowledge in chat, and every thread reply
  is final. If the run then dies, the comment is never re-owed (the #2484 class).

**Q6. Answers row W says the filter cannot see.** A comment answered in chat, or by an edit, or
handled state lost at a restart.
- (a) Accept them for the flip, under the restart row's acceptance and #2484. Row W is closed by
  that answer and PR B's test. *(Recommended: once PR C ships, the skill sends comment answers to
  the thread.)*
- (b) Keep row W open until chat-answered comments are linked (the issue's rejected option
  "a chat answer linked to the comment").

## 8. Risks, and what each reviewer looks at

- **annotation-model-reviewer.** The guard order and the discriminant. That `answers` uses the
  read path's gates and nothing wider. The origin of every new write (`withMcp` for the reply,
  `withInternal` for the undo). That a promoted note being repliable is intended. That
  `threadItemAnsweredBy` and the `answers` builder share one predicate.
- **crdt-reviewer.** The undo observer under a SyncStep2 reconnect, a Hocuspocus document swap
  (`onDocSwapped` must reattach it), session restore (no origin) and `.docx` import. The premise
  that a real tab never changes the replies map. It is analogous to the open H1 row; measure it if
  it cannot be argued.
- **security-reviewer.** "A client cannot hide an item from every inbox" holds with the undo and
  the filter together. `answers` is never projected. No route or licence surface changes
  (Critical Rule 9). That no `docs/security.md` entry is touched, or one is filed.
- **The series' own review** (ownership semantics). That the retire exclusion at handover keeps
  §6.3's notice rule intact. Agreement between the collector and `isDocumentWaiting` in every
  handled world. That flag off is byte-identical, including `tools/list`.
- **svelte-migration-reviewer.** Only if Q5(a) changes how the client renders an `inProgress`
  thread row. Otherwise not needed.
- **Residuals to record in the ADR:** Q2's race; Q3; answers in chat or by an edit; and a reply on
  a document not open at a Solo release that keeps a stale `heldInSolo` marker
  (`mode-release.ts:106`). `threadItemAnsweredBy` skips it in every mode, so no thread reply ever
  settles it, and it stays owed. That fails safe, but check whether opening a document clears
  stale markers.
