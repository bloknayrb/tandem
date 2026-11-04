# Multi-Session Document Ownership — Design v5

> **Not implemented.** Design v5 is PR 0 of the approved plan, [`docs/plans/2358-ownership.md`](../../plans/2358-ownership.md) (rev 7, issue #2358). It replaces v4.1 (Bryan, 2026-09-17) and meets the plan's requirements R1–R5. Bryan's eleven decisions of 2026-11-04 and the items he confirmed are settled and are restated, not reopened. ADR-054 stays reserved for this design and is written in PR 1a.
>
> - Every `file:line` here was verified against master `4fb053a5` on 2026-11-04.
> - [stories.md](./stories.md) and [reviews/](./reviews/annotation-model.md) are the v4.1 story pass and review set, kept as history and **not** re-statused for v5. v5's acceptance tests are the plan's, mapped per requirement and per PR in §16.
> - v4.1's text is in git history. Where v5 keeps a v4.1 mechanism it says so in one line.

## 0. What changed from v4.1

| Area | v4.1 | v5 | Why |
|---|---|---|---|
| Who answers by default | The first session handed the work claims an unowned document | **Tandem's Claude holds every document no other session opened**, while it is present (§4) | Decisions 1, 2, 11 |
| Ownership kinds | One kind | `default`, `claimed`, `opened`, `assigned`; the kind decides what can move a document (§4) | The plan's kind table |
| Taking a document | No MCP transfer | Another session's `tandem_open` takes a `default` or `claimed` document; `opened` and `assigned` refuse (§5.4) | Decision 3 |
| Inbox bookkeeping | A per-item delivered-to ledger replacing `surfacedIds` | Gone. #2330's cursor registry stays; ownership is **scope exclusion** plus a **handover** that re-owes unhandled items (§6) | `inbox-cursor.ts` replaced what v4.1 was written against |
| Answered-once | Not specified for comments | One answerer per item; handled items are never handed to anyone (§5.5, §6.4) | R1.5, R1.2, decision 6 |
| Doc-less chat | D5: disable send on an empty tab | D5 dropped. Doc-less chat belongs to Tandem's Claude while present, else per message (§7) | Plan |
| Channel shim | §5.5-A: no identity | §5.5-B: its `X-Claude-Session-Id` selects a record; its stream narrows and its replies are checked (§9) | Decision 9 |
| Direct-HTTP terminal's shim | n/a | **Never linked**, measured (probe 4); keeps today's stream, replies refused with a remedy (§9.3) | R4.8 |
| Launcher | Handle per run; the child's record dies with it | The handle binds each run to the one **Tandem's Claude** record, which outlives runs; presence, take-back, widened starts, waking (§8) | Decisions 2, 7, 10, 11 |
| Dead terminal | ~32 min (idle reaper) | 2-minute grace after its `GET /mcp` stream closes (§3.4) | Probe 3 |
| `#1952` | Fixed per request | `peerIsLoopback` set in PR 1a and read by nothing; PR 1b is conditional on Bryan (§11.5) | #1952 is accepted and bounded by ADR-056 |
| Error code | `NOT_OWNER` | `NOT_DOC_OWNER` with a `reason` (§5.3) | R4.2 |
| Names on the badge | Nicknames (set by Bryan or the session), client name | Server-derived display kind, label and held-document names only; rename is not built (§10.3) | R3.6 |
| `tandem_open` activation | Re-open and claim do not activate | Today's behaviour kept: every `tandem_open` activates (§5.4) | No unlisted single-session change |
| Subagent hand-off (`issueHandle`) | Built | Not built (§15) | No requirement needs it |
| `ChatMessage.ownerLabel` | Stamped from Phase 1 | Not built (§15) | Labels are per run; a persisted one would mislead after a restart |
| Wake socket scoping (`?watch=`, socket pin) | Phase 3 | After the flip; Phase 3 starts from v4.1's text | Plan |

## 1. Summary

- Every open document has **at most one owner**. Only the owner is handed its items (inbox and push), and only the owner's answers and writes are accepted. Reads stay open. The server enforces this in the MCP tool layer and on `/api/channel-reply`; the rest of `/api` is Bryan's own surface (D4).
- **Tandem's Claude** is one owner record across all its child runs. While **present**, it holds every document no other session opened. A terminal answers only documents it opened or took with `tandem_open`, documents Bryan assigned to it, and documents it was handed while Tandem's Claude was not present.
- **Kinds** say what can move a document: a starting Tandem's Claude run takes back `claimed` documents; another session's `tandem_open` takes `default` and `claimed` ones; `opened` and `assigned` move only by Bryan's Release or Assign, or when their owner goes away.
- **The inbox stays on #2330's cursors.** A document held by someone else is not in the caller's scope. When ownership changes, items the old owner was handed and did not answer are owed again to everyone; answered items are never handed to anyone.
- **One answer per item.** The first record whose final answer is accepted is the item's answerer.
- **Starting and waking.** A present Tandem's Claude that is not running is started for asks on its own documents, even with a terminal attached, and for documents that come back to it with items waiting. A running owner that receives a document with items waiting is woken.
- **It ships dark** behind one build-time flag. Its tests run in the blocking `check` job; an advisory job runs everything else flag-on.

## 2. Terms

| Term | Meaning |
|---|---|
| **Owner record** | Server memory: `{ownerId, recordKind, label, transports, lastPollAt, lost}`. Lost on restart (decision 8). |
| **Record kind** | `tandem` (one per server run), `claude` (a transport carrying `X-Claude-Session-Id`), `bridge` (the stdio bridge without one), `http` (a direct-HTTP transport with neither), `stdio` (stdio transport mode). Server-derived. |
| **Display kind** | `Tandem's Claude` (only for `recordKind: "tandem"`), `terminal`, `Claude Desktop`, `other app`. Chosen by the server from a closed list (§10.3). |
| **Label** | A random per-run id such as `owner-k7qx`. Never derived from a session id or a handle. |
| **Ownership entry** | `ownerByDoc: Map<documentId, {ownerId, kind, since}>`. No entry means **unowned**. |
| **Kind** | `default`, `claimed`, `opened` or `assigned` (§4.1). |
| **Present** | Tandem's Claude may hold documents (§8.1). |
| **Default rule** | Where a document goes when nobody in particular should have it: Tandem's Claude as `default` if present, otherwise unowned. |
| **Handed** | Returned to a reader by `tandem_checkInbox`, or written to a consumer's push stream. |
| **Handled** | Answered by a final (not `inProgress`) reply, judged from persisted state (§6.4). Notices are handled once handed (§6.5). |
| **Waiting** | An item on a document that is not handled and that passes the Solo hold, `hideFromAI` and the ADR-027 and withheld predicates (§8.4). |
| **Lapsed** | A record whose documents went back to the default rule because its client went away (§3.4). |
| **Handle** | `th_` plus 32 base64url characters, minted per Tandem's Claude child run, named in that run's supervisor prompts (§3.3). |

## 3. Identity

### 3.1 Records from transports

**Problem.** Ownership needs to know who is calling. Direct-HTTP Claude Code sends no per-session header (probes 3 and 4, §13), the stdio bridge forwards one (`src/cli/mcp-stdio.ts:438`), Claude Desktop sends neither, and stdio mode has no transport registry.

**Rule.** Each transport resolves to one record, decided at `initialize`:

1. `X-Claude-Session-Id` present → `claude:<id>`. Several transports may share it (bridge reconnects and respawns). **Exception:** an id equal to the current Tandem's Claude run's session id (§3.3) gets a private record per transport, never shared, so nothing can pre-create or join the child's record.
2. Else `X-Tandem-Client-Id` present → `bridge:<id>`. A new header, minted once per bridge process and reused by its reconnects (PR 1a).
3. Else → `http:<Mcp-Session-Id>`.
4. Stdio transport mode → one process-wide `stdio` record.

**Callers with no request context.** `getCurrentOwner()` returns the `stdio` record in stdio transport mode. In HTTP mode, no context means server-internal work (the reload family, startup restore, the local-model collaborator's in-process writes, tests calling handlers directly); it is the `internal` caller, which bypasses ownership checks and never answers or claims. Every MCP request path enters a context (`runWithMcpContext` at `src/server/mcp/server.ts:875` and `:930`); PR 1a pins that with a test, so no MCP caller can reach `internal`.

**Mechanism.** The registry entry already stores `claudeSessionId` and `clientName` (`McpSessionEntry`, `src/server/mcp/transport-registry.ts:54-84`), filled in at `onsessioninitialized` (`server.ts:550`). PR 1a adds `ownerId` to the entry and to `McpRequestContext` (`src/server/sessions/context.ts:37-59`), set in `dispatchToSession` (`server.ts:858`) and on the initialize path (`server.ts:930`). It also adds `peerIsLoopback`, from `req.socket.remoteAddress` through `isLoopback` only; nothing reads it unless PR 1b lands (§11.5).

**Two Tandem toolsets in one Claude Code session.** The plugin bundles a bridge `tandem` entry and the shim (`.claude-plugin/plugin.json`), and `tandem setup` writes a user-level direct-HTTP entry (`src/server/integrations/apply.ts:514`). A terminal with both loads the toolset twice (the doctor already warns, `src/cli/doctor.ts:2136-2138`) and is **two records**: `claude:<id>` for the plugin's tools and shim, `http:<sid>` for setup's. Nothing can link them: the direct-HTTP transport carries no per-session value (probe 4). Each record holds what it opened, and a refusal on the other names it like any other holder. v5 does not merge them. Whether setup stops writing the direct-HTTP entry for Claude Code when ownership flips is Bryan's call (§14), because it changes setup and the launcher's "configured" check.

### 3.2 The Tandem's Claude record

**Problem.** Tandem's Claude is a sequence of child processes (spawn, idle-stop, resume, crash-resume, relaunch), each with its own transports. Decisions 2, 7 and 11 need one identity that outlives them.

**Rule.** The ownership module creates one record `tandem` at boot. It holds documents only while present (§8.1). Its transports are those bound with the current run's handle. Its label is fixed for the server run, and its display kind is always `Tandem's Claude`.

### 3.3 Binding a child run

**Problem.** The child's setup entry is direct-HTTP, so its transport carries no header (probe 3). What reaches the child on every turn is the supervisor's stdin prompt.

**Rule.**
- Each spawn mints a handle. **All three** prompt builders replacing `SUPERVISOR_INITIAL_PROMPT`, `SUPERVISOR_GREETING_PROMPT` and `SUPERVISOR_WAKE_PROMPT` (`src/shared/launcher/contract.ts:741`, `:760`, `:819`) name it first: *"Your Tandem owner handle for this run is `th_…`. Pass it as `ownerHandle` on your first Tandem call in this turn."* The no-unasked-work clause stays.
- `ownerHandle` is an optional argument on four entry tools: `tandem_status`, `tandem_open`, `tandem_scratchpad`, `tandem_checkInbox`.
- **Bind check.** The handle is the current run's, and the presenting transport carries no `X-Claude-Session-Id` or carries the current run's session id (`currentSessionId`, set at spawn, `src/server/launcher/supervisor.ts:1998`). Probe 1 shows a resumed child keeps its id, so a legitimate child passes. At most **one** headerless transport may be bound per run; a second headerless bind while the first is still registered → `OWNER_HANDLE_CONFLICT`. A child with two toolsets (if `claude -p` loads the plugin) binds each by presenting the handle on each.
- **Outcomes.** Presenting the current handle on a transport already bound to it: a no-op success (every wake prompt repeats the handle). A fresh transport: re-pointed to `tandem`; if its prior record is a never-bound single-transport record that already holds documents (the child opened something before binding), those move to `tandem` as `default` (v4.1 §5.10's absorb). A prior record that holds documents and is anything else, or a transport with a document operation in flight → `OWNER_HANDLE_CONFLICT`, no side effects. An unknown, stale or malformed handle → `INVALID_OWNER_HANDLE`, no side effects, and the message never echoes the value.
- **Teardown.** When the run ends (`teardownTurnDelivery`, `supervisor.ts:2275`), the handle dies and every transport bound with it is re-pointed to a fresh empty `http` record. The `tandem` record keeps its documents: presence, not the run, decides what it holds.
- **An unbound child.** Every refusal whose holder is Tandem's Claude ends with: *"If you are Tandem's Claude, call `tandem_checkInbox` with your `ownerHandle` and retry."*

**If a later Claude Code build differs (probe 1).** If a resumed child got a new `CLAUDE_CODE_SESSION_ID`, the header half of the bind check would refuse a resumed bridge-entry child. The fallback is to accept any header on a handle bind; the one-headerless-transport cap still applies.

### 3.4 When a client goes away

**Problem.** A dead terminal's documents should come back promptly, but a live client must not lose them to a blip.

**Rule.** A non-`tandem` record is **attached** while one of its transports is registered and, if any of its transports has ever held a `GET /mcp` stream, one such stream is open. When it stops being attached a 2-minute grace starts (v4.1 §5.8). A reopened stream, a new transport for the record, or any request on one of its transports ends the grace. At expiry the record **lapses**: each of its documents goes to the default rule through `setDocOwner` (§4.3), and its chat follows (§7.2). A lapsed record whose transport is still registered keeps its label and holds nothing.

**Mechanism.** The registry counts open streams per entry (`openStreams`, `transport-registry.ts:83`) and fires `onEvicted` on `lru | idle | explicit` closes (`:100`). The ownership module listens to both.

**Bounds** (probe 3): a Claude Code terminal that exits or crashes closes its stream with the process, so its documents return about 2 minutes later. A client that never holds a stream is noticed only by the idle reaper: 30 minutes of idleness (`transport-registry.ts:290`), the 5-minute reap interval, then the grace — about 37 minutes. The stale-owner hint (§10.2) shows the gap and Assign closes it.

**An `http` record is its `Mcp-Session-Id`.** A direct-HTTP terminal evicted by the 16-session cap re-initializes as a new record: its old record lapses after the grace and it holds nothing (§15).

**If a later build differs (probe 3).** Without a held stream, Claude Code terminals fall into the reaper bound. Nothing else changes.

### 3.5 Stateless clients (MCP `2026-07-28`)

In probes 3 and 4, Claude Code sent `server/discover` (protocol `2026-07-28`) before `initialize`: it tries the stateless era first and falls back. Tandem serves only the legacy branch (ADR-045 amendment), so every caller still gets a transport. Ownership keys on the **record**; only rule 3 derives one from `Mcp-Session-Id`, as CLAUDE.md permits on the legacy branch. When Tandem adds the stateless branch, that work must give a stateless caller a record, or it holds nothing (§15).

## 4. Ownership

### 4.1 Kinds

| Kind | Holder | How it arises | A starting Tandem's Claude run | Another session's `tandem_open` |
|---|---|---|---|---|
| `default` | Tandem's Claude only | The default rule while present: Bryan's opens, restores, `welcome.md`, his scratchpads; documents Tandem's Claude opens or writes; take-back; documents returning to it | (its own) | takes it → `opened` |
| `claimed` | A non-`tandem` record | It was handed the document's work, or wrote to it, while the document was unowned | takes it back → `default` | takes it → `opened` (its holder too) |
| `opened` | A non-`tandem` record | Its `tandem_open` of a closed file, or its take of an unowned, `default` or `claimed` document | not taken | refused |
| `assigned` | Any record | Bryan's Assign | not taken | refused |

### 4.2 Transitions

| Event | Result |
|---|---|
| Bryan opens a document (`POST /api/open`, upload, file association, startup restore, `welcome.md`, a scratchpad he creates) | Default rule |
| Tandem's Claude's `tandem_open` or `tandem_scratchpad` | `default`; refused on an `opened` or `assigned` document held by another record |
| Another session's `tandem_open` of a closed file, or `tandem_scratchpad` | `opened` by it |
| Another session's `tandem_open` of an open document | Unowned, `default` or `claimed` → `opened` by it; `opened` or `assigned` held by someone else → refused; its own `opened` or `assigned` → unchanged |
| A write, or an inbox poll that hands items, on an unowned document | Claimed: `default` for Tandem's Claude, `claimed` for anyone else — except a record that lost this document by Release or Assign, which must `tandem_open` it (§5.3) |
| A Tandem's Claude run **starts** (§8.2) | Every unowned and every `claimed` document → `default` |
| Tandem's Claude becomes present without a start (Off→On, Configure) | Nothing moves |
| Tandem's Claude stops being present | Every document it holds (`default` or `assigned`) → unowned, and its doc-less chat follows (§7.2) |
| A record lapses (§3.4) | Each of its documents → default rule |
| Release | Default rule |
| Assign to record R | `assigned` to R |
| Bryan closes the tab | The entry is removed; unanswered chat on it keeps that owner (§7.2) |
| Server restart | Everything is forgotten; Tandem's Claude is not present until its first start this run (decision 11), so restored documents start unowned |

A read, `tandem_switchDocument`, list-mode `tandem_restoreBackup` and `tandem_exportAnnotations` never claim (v4.1 §3.7).

### 4.3 One composite for every change

Every change goes through `setDocOwner(documentId, next | null, kind, cause)`, run at its turn in the document's operation queue (§5.1), or synchronously at the close point for a tab close. In order:

1. update `ownerByDoc`;
2. if the previous owner was a different record, run the **handover** (§6.3) and record the loss on that record (§5.3);
3. queue a change notice for both records, drained by their next poll (§6.6);
4. publish through `broadcastOpenDocs` (`src/server/documents/registry.ts:162`), never an ad-hoc broadcast;
5. if the new owner has **waiting** items on the document, start or wake it (§8.4, §8.5) — **except** when the change was made by the new owner's own call (its poll, write or take), and at take-back (§8.2). Holding with nothing waiting wakes nobody (R4.4). If the document became unowned with items waiting, send the unscoped `ownership` wake frame (§8.5) so an attached terminal can pick it up.

**Lock order.** `setDocOwner` never awaits the supervisor's operation lock: step 5 calls a fire-and-forget seam that records the owed wake synchronously (§8.4). The supervisor never awaits a document queue: take-back and the presence-loss sweep enqueue their `setDocOwner` calls and return. So no wait cycle exists between the two.

## 5. Enforcement

### 5.1 The operation queue and refusal placement

v4.1 §3.4a is kept: every MCP mutation and every ownership change on a document runs through a per-document serial queue, and the ownership check is the first thing inside the operation. Refusals decided by the arguments or by facts fixed at open (`LICENSE_REQUIRED`, `NO_DOCUMENT`, `DOCUMENT_REQUIRED`, `INVALID_ARGUMENT`, `INVALID_PATH`, `READ_ONLY`, extension-decided `FORMAT_ERROR`, handle errors) run before the queue and never claim. Refusals decided by live content, the disk or the save lock (`INVALID_RANGE`, `RANGE_MOVED`, `SAVE_IN_PROGRESS`, `EXTERNAL_CONFLICT`, serializer `FORMAT_ERROR`, I/O) run inside and keep the claim. Browser edits and the reload family stay outside the queue. PR 1c re-derives v4.1's line numbers, which are stale.

On a document held by someone else, `NOT_DOC_OWNER` is answered before any lifecycle refusal, including #2360's `NOT_OWNED`.

### 5.2 Which document a call means (R4.1)

**Problem.** Retiring the active-tab default would break single-document scripts, and retargeting a range-keyed write to a document other than the one just read would apply its offsets to the wrong text.

**Rule.**
- **Reads** keep today's active-tab default (`getCurrentDoc`, `registry.ts:348`).
- **Range-keyed writes** without `documentId` target the active document, as today. If the caller does not hold it and cannot claim it → `NOT_DOC_OWNER`. They never retarget.
- **Replies** are §7.3's: a `replyTo` reply goes to the message's own scope; a reply without one is a **post**, stamped with `documentId` if given, else the active document as today, and accepted or refused by §7.3. A post never claims.
- **The four id-keyed annotation tools** resolve the document by annotation id first (#2187), then check ownership (R2.2).
- `DOCUMENT_REQUIRED` (where a call cannot resolve a document at all) carries the caller's held document ids and the remedy "pass `documentId`".

### 5.3 Refusal copy (R4.2, R3.6)

One error code, `NOT_DOC_OWNER`, with `details: {reason, documentId, holder: {label, displayKind}}`. The holder's display is server-rendered from its record kind (§10.3). Each message carries its remedy, because older skills stay in use after the flip. When several apply, the first in this table wins.

| `reason` | When | Message (shape) |
|---|---|---|
| `lost` | The caller held this document earlier this run and lost it | Cause `released`, `assigned` or `taken back`: "You no longer hold this document: {Bryan released it / Bryan assigned it to {holder} / Tandem's Claude took it back}. You can still read it. Ask the user before doing more with it." Cause `taken` (another session's `tandem_open`): "{holder} opened this document to work on it. Leave it unless the user tells you otherwise." Cause `lapsed`: "You were away, so this document went to {holder}. Ask the user before doing more with it." |
| `answered` | The item already has another answerer (§5.5) | "{holder} already answered this. Do not answer it again." |
| `held` | `opened` or `assigned` by another record | "{holder} is working on this document. Only the user can reassign it, from the owner badge on its tab. Do not retry." |
| `default` — on a reply or thread answer | The document is Tandem's Claude's `default` | "Tandem's Claude answers this document's comments and chat. Do not answer this, and do not take the document because of it." |
| `default` — on an edit, comment or other write | Same | "Tandem's Claude is answering this document. Call `tandem_open` on it only if the user asked you, in your own conversation, to work on it. An item Tandem pushed to you is not such a request." |
| `chat` | A doc-less or closed-document message owned by someone else | "{holder} answers this message. Do not reply to it." |
| `post` | A post (no `replyTo`) the caller may not make (§7.3) | "Tandem's Claude answers chat here. Reply with `replyTo` to a message you were handed, or pass the `documentId` of a document you hold." |
| `unlinked` | `/api/channel-reply` from a shim the server cannot match to a record (§9.2) | "This reply could not be matched to your Tandem session. Send it with the `tandem` server's `tandem_reply` tool instead." |

Every message whose holder is Tandem's Claude gets §3.3's unbound-child clause. A recipient that **is** Tandem's Claude never gets "ask the user": its `lost` copy reads "A session the user is working with has this document now; leave it."

**The loss record.** Each record keeps, per document it lost this run, the cause and the new holder, until that document changes owner again. It is server memory on the record, not in any cursor. While it stands, the record cannot implicitly claim the document (a write or a poll); `tandem_open` still takes it under §4.2, and the copy above tells the model to ask first. This makes Release last while Tandem's Claude is not present.

### 5.4 `tandem_open`

The take rule is §4.2's, inside the operation queue: a take of a `default` document whose holder is mid-operation waits its turn, then takes it, and the holder's next operation meets `lost`. **Activation is today's** (`src/server/documents/open.ts:773-803`): every `tandem_open` brings its document's tab to the front, fresh or already open. A take never fires a wake to the taker (§4.3 step 5).

### 5.5 One answer per item (R1.5)

**Problem.** Decision 3 lets a session that was pushed an item take the document after the item was answered, and then answer again. Ownership alone cannot stop that, because the new owner is the owner.

**Rule.** The first record whose **final** answer to an item is accepted becomes its answerer. A later answer to the same item is accepted only from the answerer. An `inProgress` acknowledgement is not an answer: it neither sets the answerer nor makes the item handled, and the same record's final reply that follows is accepted.

**Mechanism.** An in-memory `answerer: Map<itemKey, ownerId>` in the ownership module:
- **Comments and thread replies.** The item is the thread's latest user entry (the comment at its current `editedAt`, or the latest user reply). A Claude reply on the thread (`tandem_annotationReply`, or #2360's thread reply) by X sets the answerer for that item to X if unset. A reply by Y ≠ X while the latest user entry is answered by X → `NOT_DOC_OWNER`, `reason: "answered"`. A new user reply or an edit makes a new item.
- **Chat.** The item is the message named by `replyTo`. Today's batch rule (`answeredBy`, `src/server/mcp/awareness.ts:1554`) also settles earlier messages some model received. Under the flag it expands only over messages in the replier's current scope (§6.2), and every message it settles takes the replier as answerer. A message settled in persisted state with no recorded answerer exists only after a restart; its current owner's reply is then accepted (decision 8).
- **A post** (no `replyTo`) answers nothing, so this rule cannot see it (§15).

### 5.6 `tandem_switchDocument`

It brings a document's tab to the front and never claims. Under the flag it is refused only on a document held by another record (`NOT_DOC_OWNER`, `held` or `default` copy). On an unowned document and on the caller's own it works as today.

### 5.7 Reads and labels

Reads are open. `tandem_getAnnotations` and `tandem_listDocuments` label each document with `owner: {label, displayKind, kind, you}` (or `null`). `tandem_status` returns the caller's own label, display kind and held document ids, so Bryan can ask a session which one it is.

## 6. The inbox under cursors

### 6.1 What the inbox is today

`tandem_checkInbox` keeps no per-reader state. One process-wide registry gives every returned item version a sequence number the first time any poll returns it (`src/server/mcp/inbox-cursor.ts:10-12`); each reader's position is a mark per scope inside the opaque cursor it passes back (`inbox-cursor.ts:22-31`). A fresh reader counts as seen whatever some reader acknowledged (`seenBy`, `inbox-cursor.ts:107-110`). Default polls read every open document (`collectInboxDocuments`, `awareness.ts:1152`) and skip quiet background documents (`awareness.ts:1227-1237`). Chat is one scope read on every poll, and a message answered by a `replyTo` reply is skipped for every reader (`awareness.ts:1621`). Cursor-less (legacy) polls still keep the process-wide `surfacedIds` / `replySurfacedIds` ledgers (`legacyLedgers`, `awareness.ts:861`).

Ownership changes four things: which documents and messages a poll reads (scope), what a poll acknowledges, what happens when ownership changes (handover), and which items are ever handed (the handled filter).

### 6.2 Scope and acknowledgement (R1.1, R4.6)

**Rule.** A poll by record X reads:
- documents X holds;
- unowned documents, claiming each one that yields items (claim on delivery, below), unless X lost it (§5.3);
- chat messages whose owner (§7.1) is X, or which are claimable by X.

Anything held by someone else is **not read**: it is left out of `collectInboxDocuments`'s order and out of the chat pass. This is exclusion, not an `admit` refusal, so nothing is logged as dropped and no "malformed" text appears. A named poll of such a document returns no items and lists it in `ownership.notYours`.

**The cursor treats an excluded document as read with nothing handed.** Its mark moves to the counter like any document the poll read, with no held seqs, so excluded documents are never listed in the cursor (R4.6). This is safe because every change of owner re-owes, with new seqs above every mark, each item the next owner could be owed (§6.3).

**Acknowledgement is scoped.** `acknowledgeCursor` (`awareness.ts:1674`) acknowledges a scope's entries for the fresh-reader floor, and stamps chat `read`. Under the flag it does both only for documents and messages in the caller's scope at that poll. A reader's mark passing another owner's entries therefore never hides them from a fresh reader, and never stamps another owner's chat read. The handler reads the caller's record to choose scope; nothing is written into the cursor (R3.7).

**Claim on delivery.** For an unowned document that yields items, the pass stages a claim. The handler applies staged claims in its commit step, after the response validates and in the same synchronous tick (`awareness.ts:1852-1866`); a response that fails validation claims nothing. A claim is applied only if the document is still unowned and its queue idle; otherwise the document's items are left out unmarked.

**Cost (R4.6).** An excluded document costs no collection and no cursor space. Foreign items never enter a reader's held lists. 300 pending items, or 300 open documents, held by another owner add nothing to a reader's cursor and nothing to its work beyond enumerating open documents.

### 6.3 Handover (R1.2, R2.1, R2.3, R4.5)

**Problem.** Once the old owner acknowledged items, a fresh new owner counts them as seen; and a new owner whose mark passed them is not owed them. Either way the item is lost.

**Rule.** When `setDocOwner` moves document D away from record X (to anyone, or to unowned), every item on D that is **not handled** is owed again to every reader, and handled items stay settled.

**Mechanism**, one synchronous step inside `setDocOwner`:
1. **Retire** every live registry entry in D's scope whose item is answerable and not handled (`retire`, `inbox-cursor.ts:308`). A retired item that qualifies again gets a new seq above every mark.
2. **Legacy ledgers.** Delete D's keys for the same items from `surfacedIds` and `replySurfacedIds`, so a cursor-less next owner is owed them too.
3. **Notices** (accept, dismiss) are handled: their entries in D are marked acknowledged (`markAcked`) and kept. Because a reader's mark already passed them (§6.2) and a fresh reader counts acknowledged entries as seen, no next owner is handed them.
4. **Chat** on D, and the closed-document and doc-less chat X owned (§7.2), that is not handled: retire its chat entry and set `read: false` on the message, in one `withInternal` transaction on `Y_MAP_CHAT` (Critical Rule 2; the chat observer emits `chat:message` only for browser-origin writes). `delivered` is left as it is, so the editor's pickup row does not flash a false stall. Retiring alone is not enough for chat: a message with no entry is owed only while unread (`awareness.ts:1622-1627`). X's `inProgress` row for such a message is finalized, so it stops showing as in progress.
5. **Bump the quiet epoch** of D (`quietDocState`, `awareness.ts:809`), so no reader skips D on a stale quiet record (R4.5).

### 6.4 The handled filter

**Rule.** Under the flag, a handled item is never handed to anyone, on cursor and legacy polls alike (the legacy chat path, `collectUnreadChat` at `awareness.ts:1471`, gains the check it lacks today):
- a user comment at a given `editedAt` with a later final Claude reply on its thread;
- a user thread reply with a later final Claude reply on the thread;
- a chat message settled by a final `replyTo` reply (today's `answeredChatIds`, `awareness.ts:1586`, minus `inProgress` rows, and with §5.5's scoped expansion).

It judges from persisted state, so it covers an answer given from a **push** before any poll registered the item (R1.2), and it holds across a restart. For a single session nothing visible changes: a reader that was handed an item already has it, and an edit or a new user reply makes a new item.

### 6.5 Notices (R2.6)

Accept and dismiss notices need no answer. They count as handled once their owner was handed them: by a poll (handover acknowledges their entries, §6.3 step 3) or by a mapped push stream (§9.1 registers and acknowledges the entry when it writes the event). A notice nobody was handed has no entry and goes to the next owner.

### 6.6 What the response says about ownership

`tandem_checkInbox` gains `ownership: {holding: [documentId], notYours: [documentId], changed: [{documentId, change: "gained" | "lost", cause}]}`. `holding` is computed per poll; `changed` drains the record's change notices (§4.3 step 3). The loss record (§5.3) is separate and outlives the drain. Nothing here is read from or written into the cursor.

### 6.7 Delivery rounds

`pendingSince` (`src/server/events/delivery-state.ts:86`) is one global round, closed by any poll; under ownership a terminal's poll would close a round Tandem's Claude has not seen. Under the flag it becomes per document (doc-less chat under one `"*"` key), and a poll closes only the rounds of documents it read. `/health` keeps reporting one aggregate (the oldest open round's age) and never a document id or a per-document breakdown.

### 6.8 The cursor pin (R3.7)

`tests/server/inbox-cursor.test.ts:1060-1078` pins that the cursor module and the inbox handler import no transport or session identity. It is amended to: `inbox-cursor.ts` imports nothing from the ownership module; the inbox handler may import `getCurrentOwner` and the scope predicate from it and nothing else; and a new test shows that two records with the same position and the same holdings receive byte-identical cursors.

## 7. Chat ownership and replies

### 7.1 Who owns a message (R1.4)

| Message | Owner |
|---|---|
| On an open document D | D's owner; if D is unowned, claimable with D (§6.2) |
| On a closed document, or doc-less | Its per-message owner if one is set; else Tandem's Claude while present; else claimable |

A claimable message gets a per-message owner when a poll hands it to a record (applied at commit, §6.2) or when a record's answer to it is accepted, whichever comes first. So at any moment exactly one record may answer it, or none is set and the first accepted answer sets it. A per-message owner keeps its message when Tandem's Claude becomes present (the plan's call).

### 7.2 Successors (R2.3)

- When Bryan closes D, each unanswered chat message on D takes D's owner at that moment as its per-message owner (nothing, if D was unowned).
- When a per-message owner lapses, each of its unanswered messages loses that owner and follows the table again, with §6.3 step 4.
- When Tandem's Claude stops being present, every unanswered doc-less or closed-document message it owned — by a per-message owner or by being present — follows the table again, with §6.3 step 4.

### 7.3 Reply acceptance (R2.2)

`tandem_reply({text, replyTo?, documentId?, inProgress?})`:
1. **With `replyTo`.** The message's own scope decides: on an open document, that document's ownership; otherwise its owner (§7.1). A claimable message is claimed by the accepted reply. Then §5.5's answered-once check. An explicit `documentId` that contradicts the message's → `INVALID_ARGUMENT`.
2. **Without `replyTo`, a post.** Stamped with `documentId`, else the active document, as today. Accepted when any of these holds: the caller holds the stamped document; the caller is Tandem's Claude and it is present; Tandem's Claude is not present and the stamped document (if any) is unowned. Otherwise `NOT_DOC_OWNER`, `reason: "post"`. A post never claims and never answers.

**The first-run greeting** (#2193) is Tandem's Claude's post, accepted under rule 2. The greeting classifier (`isGreetingReply`, and the supervisor's own-child check at `supervisor.ts:1270` and `:1310`) keys today on the reply's session header, and treats a reply with **no** header as possibly the child's. Under the flag it keys on `getCurrentOwner().recordKind === "tandem"` on the MCP path, and never classifies a `/api/channel-reply` reply as the greeting.

## 8. Tandem's Claude: presence, take-back, starting, waking

### 8.1 Presence (R4.3, decision 11)

**Rule.** Tandem's Claude is present when all of these hold:
- a run has **started** this server run (§8.2);
- it is configured;
- the saved mode is not Off;
- it is not staying down: the breaker is not tripped, and either `lastError` is unset or a restart is scheduled (`restartTimer` set, or a launch in progress). Today's `lastError` values are `needs-login`, `unlicensed`, `cli-unusable`, `binary-not-found`, `spawn-failed`, `stop-failed`, `circuit-open` and `wake-delivery-failed`. A new value counts as staying down; an exhaustive-switch test makes adding one a decision.

Presence is computed from those stable fields only — not from `restartPending()`, which also reads a queued message start and a time-based branch. It keeps its documents through idle-stop, resume, crash-resume and relaunch (decision 7), none of which leaves an error with no restart scheduled.

**Announcer.** The fields above are written in several places, some outside the operation lock (the exit handler, the stream parser's sign-in trip, restart scheduling). PR 3b routes every write of them through one setter that recomputes presence and calls `onPresenceChange(present)` only when the value differs from the last announced one. The ownership module reads only the last announced value. `status()` is not a transition: its `cli-unusable` lapse (`supervisor.ts:3412-3418`) clears the error without recomputing, and presence follows at the next transition, whatever it is.

### 8.2 Take-back (decision 2)

**Rule.** A run **starts** when the supervisor reads the child's first stream-json envelope — the child is alive, not merely spawned. Then every unowned and every `claimed` document becomes `default`, each through `setDocOwner` (and so through the handover for `claimed` ones). `opened` and `assigned` documents stay. Take-back is never itself a start trigger: it happens because a run started.

**Its wake.** Take-back does not call `requestWake` (§4.3 step 5): the turn delivery for the run is still being set up. If any taken-back document has items waiting, take-back sets the run's owed wake synchronously (`wakeOwedAcrossSpawns`), which a resumed spawn honours and a fresh spawn's bootstrap turn already covers.

A run started by a chat while Off follows the 2026-10-13 behaviour (the mode becomes on-click; `tests/server/launcher/supervisor-turn-delivery.test.ts:1978`) and is a run start like any other.

### 8.3 Start rules (R2.4, decision 10)

**Rule.** A present Tandem's Claude that is not running starts, whether or not another AI is on, for:
- on a document it holds: a user chat message, a new user comment (`annotation:created` of a user comment, with or without a suggestion), or any user thread reply;
- a doc-less or closed-document chat message it owns.

An event on a document held by another **attached** record starts nothing. Everything else is today's rule: `isStartWorthy` (`src/shared/events/wake-scope.ts:57`) and "not if another AI is on", including for a document whose holder is in its grace; such a start takes back that document if it is `claimed`.

**Leaving Solo.** The Solo→Tandem release wake carries no document. When it fires, the supervisor asks the ownership module whether any document Tandem's Claude holds has items waiting, and if so starts it as above.

**Mechanism.** The standby watch callback (`supervisor.ts:1410`) asks the ownership module `startWorthyFor(event)` → `{start, ignoreOtherAi}`. Because a burst of events is coalesced into one queued start (`messageStartQueued`, `:1414`), `ignoreOtherAi` is **accumulated** (OR-ed) into supervisor state by each event the watch accepts, and `startForMessage`'s re-check under the lock (`:1432`) reads and clears it. The watch subscribes through `wasForwardedExternally` (`supervisor.ts:321`), so the Solo hold, `hideFromAI` and the licence refusal run before it sees an event (R3.1). `startsOnMessage`, which the chat panel reads to promise "resuming", applies the same rule.

### 8.4 Starting for a returning document

**Rule.** When a document reaches a present, not-running Tandem's Claude with items **waiting** — by Assign, Release, or a lapsed holder — it starts, whether or not another AI is on. Off→On moves nothing and starts nothing.

**Waiting** is computed by the inbox's own document collector with no cursor, after every privacy gate (the Solo hold, `hideFromAI`, the ADR-027 and withheld predicates; R3.1), counting unhandled answerable items and unanswered chat. A Solo-held item is never waiting.

**Mechanism.** `setDocOwner` step 5 calls `startOrWake(cause)`, a fire-and-forget supervisor seam. It records the owed wake and the "ignore other AI" bit synchronously, sets the queued-start flag so the status reads Starting, and then queues the same locked start `startForMessage` uses.

### 8.5 Waking a running owner (R2.7)

**Rule.** When a document reaches a running owner with items waiting (a lapsed holder's documents, Assign, Release), that owner is woken. Holding with nothing waiting wakes nobody (R4.4).

**Mechanism.**
- **Tandem's Claude:** `requestWake()`, exposed by the current run's turn delivery, writes the wake prompt through the same coalescing as `onTandemEvent` (`supervisor.ts:2246`). It passes `aiRefusal()` first (R3.2).
- **Other records:** a payload-free `ownership` frame on `/api/wake`, and a payload-free `ownership-changed` event on a mapped push stream (§9.1). Before Phase 3 a wake socket is unscoped, so every armed session gets the frame, polls, and finds nothing unless it is the new owner.
- **Licence.** Neither frame enters `pushEvent`, so neither inherits its licence revocation. Each writer calls `aiRefusal()` before writing and, on a refusal, ends the socket (4403) or the stream exactly as the revocation does. `tests/docs/ai-surface-inventory-claims.test.ts` gains derivations over these two writers and over every caller of the child's turn writer (`sendTurn`), so a new path that skips the check fails the test (R3.2).
- Pull is the backstop: the change is in the next poll's `ownership.changed`.

### 8.6 A run that never binds (R2.5)

A child that never presents its handle runs as an ordinary `http` record. Its documents stay with the `tandem` record, so the inbox hands them to nobody, and their items stay waiting after it exits; the next start answers them. If every run fails to bind, the badge's stale hint shows that Tandem's Claude has not polled since items arrived, and Bryan can Assign (§10.2, §15).

## 9. Push paths and the shim's identity

### 9.1 Narrowing the event stream (R3.4, decision 9)

**Problem.** The shim and the plugin monitor read `/api/events` with full content for every document. Both already send `X-Claude-Session-Id` (`authFetch` → `withClaudeSessionHeader`, `src/shared/cli-runtime.ts:157-160`, `:178`).

**Rule.** For each event, at the moment of writing it (live and on `Last-Event-ID` replay, `src/server/events/sse.ts:72-84`, `:97-108`), the stream's header is mapped:
- a live `claude:<id>` record → that record;
- the current Tandem's Claude run's session id → the `tandem` record, for the stream only (§9.2);
- anything else, or no header → **unmapped**, which gets exactly today's stream.

A mapped stream gets an event when its document is held by the record or unowned; a chat event when the message's owner (§7.1) is the record or the message is claimable; and every event with no document that is not chat (the Solo release wake, for example). Narrowing runs after the existing Solo filter and licence refusal, never before (R3.1). Mapping per event means a shim that connected before its bridge initialized becomes mapped once the record exists. When a mapped stream writes an accept or dismiss notice, it registers and acknowledges the item's entry (§6.5).

`ownership-changed` (§8.5) is written as its own SSE event name, outside the `TandemEvent` union, with **no `id:` line**, so it never moves a consumer's `Last-Event-ID` (an id missing from the buffer would make `replaySince` replay the whole buffer). PR 4 checks that a consumer on an older plugin ref skips an unknown event name harmlessly, and pins it.

**Monitor terminals (probe 2).** A plugin monitor saw `CLAUDE_CODE_SESSION_ID` equal to its session's id, so its stream is mapped exactly when its terminal has a `claude:<id>` record (the plugin's bridge entry). *If a later build differs:* such monitors are unmapped and keep today's stream.

**Tracking is unchanged.** `pushEvent` marks an event pushed (`alreadyPushed`, the delivery round) before any stream's narrowing, so an event every mapped stream drops still reads as pushed. That is today's over-report, kept until Phase 3's reach-first ordering (§15).

### 9.2 `/api/channel-reply` (R1.3, R3.3)

**Rule.** After the body checks (`src/server/mcp/channel-routes.ts:124-133`) and before the greeting classifier and the append (`:137-145`), the route maps the header as in §9.1 and applies §7.3's acceptance and §5.5's answered-once check as the mapped record:
- a `claude:<id>` record → accepted or refused as that record;
- the Tandem's Claude run's id → never accepted as Tandem's Claude, because the header is never enough to act as it (R3.3). Today's code expects the child's shim might send the greeting this way (`channel-routes.ts:158-160`); under the flag that reply is refused with `unlinked`, whose remedy leads to the `tandem` server's `tandem_reply`, where the bound child is accepted;
- unmapped → if the target message's owner is Tandem's Claude, refused with `chat` (the right answer either way, and one refusal instead of two); otherwise `unlinked`.

A refusal is HTTP 409 with the `NOT_DOC_OWNER` body; the shim relays a failed reply's status and body to the model as the tool result.

### 9.3 A direct-HTTP terminal's shim (R4.8, settled)

**Problem.** A `tandem setup` terminal's MCP entry is direct-HTTP (`apply.ts:514`). Its shim sends `X-Claude-Session-Id`; its MCP transport does not (probe 3), so no record carries that id.

**Settled: such a shim is never linked.** It keeps today's full stream (R3.4), and its replies are refused with `unlinked` (or `chat`, §9.2); the remedy sends the model to the `tandem` server's `tandem_reply`, checked as the terminal's `http` record. The ways to link it were each ruled out:
- **Expanding `${CLAUDE_CODE_SESSION_ID}` in the entry's headers** — measured (probe 4): Claude Code expands header variables from its own process environment, which does not contain its own session id. The header arrived as the fallback value, or, for a `claude` started from inside another Claude Code session, as the **parent's** id. It cannot link, and setup must never write it.
- **A pairing id written by setup** names the install, not the session: two terminals sharing one `.mcp.json` would each answer as the other.
- **A value the model carries between the two servers** depends on every model and every older skill doing it, and fails silently when they don't. The refusal and its remedy reach the same end with no new protocol.

The cost is a single-session change for the flip's CHANGELOG (§14): a direct-HTTP terminal using the opt-in shim has its first shim reply refused, then replies through the `tandem` server. Plugin terminals, whose bridge and shim send the same header, are linked and unaffected.

### 9.4 What stays unscoped until Phase 3

`/api/wake` sockets and the supervisor's stdin wake stay unscoped: an armed session, or Tandem's Claude's child, is still woken for every wake-worthy event, finds nothing for documents it does not hold, and ends its turn. That costs a turn per event and produces no answer. An unmapped shim or monitor still receives full content; the refusal copy (§5.3) is what keeps a pushed item from becoming a take.

## 10. Controls

### 10.1 Routes (R3.5)

One new registrar, `src/server/mcp/routes/ownership.ts`, wired through `api-routes.ts`.

- **`POST /api/ownership`** `{documentId, action: "release" | "assign", ownerLabel?}`. It calls `assertLoopbackForMutation` and `assertOriginAllowlisted` at handler top, so CLAUDE.md's enumeration of routes that call neither (pinned by `tests/docs/loopback-gate-claims.test.ts`) is unchanged; and it requires a parsed JSON body, so a `text/plain` simple request cannot reach it. The native menu's Release and Assign leaves are emitted to the webview as `ctx:tab:*` actions (`src-tauri/src/context_menu.rs`; ids in `src/client/tabs/tab-context-menu.ts:15-26`), so every request comes from the webview with its origin. It runs through the document's queue with v4.1's 10-second wait, `409 busy`, no-op answers (`200 {changed: false}`), `404 unknown-owner` and `409 owner-detached`.
- **`GET /api/ownership/owners`** returns `[{label, displayKind, holds: [documentName], attachedSince, canTake}]` for attached records and for Tandem's Claude while present. GET is outside the path-wide loopback invariant, so the handler checks `req.socket.remoteAddress` itself and answers 403 otherwise.
- Critical Rule 9: both get `open` rows in `tests/server/license-gate-api-coverage.test.ts`, because they change coordination state only, never document content or the annotation store.

### 10.2 The badge and the composer (R4.7)

`data-testid="tab-owner-badge"` shows the holder's display kind and label and the document's kind. It is **shown only when it says something**: when more than one AI record is attached, when the holder is not Tandem's Claude, or when a hint below is active. A lone Tandem's Claude, or no AI at all, shows no badge. All fields ride on the `Y_MAP_OPEN_DOCUMENTS` entries through `toDocListEntry` (`registry.ts:127`), so there is no new Y.Map key.

- **Stale owner** (a boolean): the holder is in its grace, or the document's oldest waiting item is more than 5 minutes old and the holder has not polled since it arrived. It is suppressed while a start is pending. A 60-second server tick recomputes it and republishes only on a change. `lastPollAt` itself stays server-side.
- **"waiting — Start to answer"**: items are waiting, no start is pending, and either the holder is Tandem's Claude and it is not running, or the document is unowned and Tandem's Claude is present or startable. It carries a Start button that calls the existing Start control.
- **Release** is hidden where it would change nothing: on an unowned document, and on a `default` document while Tandem's Claude is present.
- **Assign** lists only records that can take a document (`canTake`): attached records, and Tandem's Claude only while present. Each row shows the display kind, label, what it holds and since when, so two terminals can be told apart.
- **The chat composer** names who will answer a message sent now: "→ Tandem's Claude", "→ Tandem's Claude (will start)", or "→ terminal owner-k7qx", from the active document's entry (or the doc-less rule with no tab).

The Tauri menu gains a Release leaf and an Assign leaf that opens the popover (v4.1 §3.11), each enabled only when the entry carries owner fields, so a dark build shows neither. The testid snapshot gains the new selectors, add-only.

### 10.3 What the badge and refusals may say (R3.6)

- The display kind is the server's choice from a closed list: `Tandem's Claude` for `recordKind: "tandem"` only; `Claude Desktop` when `clientInfo.name` equals `CLAUDE_DESKTOP_CLIENT_NAME` (`transport-registry.ts:235`); `terminal` for a `claude` record or an `http` record whose client name is Claude Code's; `other app` otherwise. A client can choose which of the last three it appears as, never `Tandem's Claude`, and never free text. `clientInfo.name` is never displayed.
- **No names.** v4.1's session rename is not built: a nickname set through a route any local process can call would put chosen text on the badge. The Assign list's held-document names (§10.1) do the job rename did — telling two terminals apart — with server-derived text only.

## 11. Security posture

### 11.1 The header (R3.3)

`X-Claude-Session-Id` **selects** among identities and is not proof. Any local process can send any value, and session ids are easy to find (transcript file names, child process arguments). Within D4 — ownership coordinates Claude sessions and is not a security boundary; every local process already holds every write, since loopback callers bypass bearer auth — a forged id gets everything the named `claude:` record has: its narrowed event stream; its reply rights on `/api/channel-reply`; and, on an MCP transport, its documents, its answerer rights, and acknowledgement of its inbox items. It never gets Tandem's Claude's rights: binding to the `tandem` record needs the live handle (§3.3), the current child's id never names a shared record (§3.1), and the channel route never maps a header to Tandem's Claude for writing (§9.2). A forged child id on `/api/events` gets the `tandem` record's narrowed stream, which is never more than today's unmapped stream. PR 4 records this in `docs/security.md`.

### 11.2 The handle is a bearer secret

It is minted per child run, written only to that run's stdin, never to `launcher-session.json`, and dies at teardown. The child's own transcript under the user's Claude config may hold it, and any local process can read that, including a terminal acting on text planted in a document. A process holding the live handle can bind as Tandem's Claude; the one-headerless-transport cap (§3.3) means it then locks out the real child's direct-HTTP bind for that run, which shows as a bind failure rather than silently, and the next run gets a new handle. That residual is recorded in `docs/security.md` in PR 3a as the handle's exposure, within D4. Hygiene: an invalid handle has no side effects and is never echoed; `log-sanitize.ts` gains a redaction for `th_[A-Za-z0-9_-]{32}`; and every string argument of every tool other than `ownerHandle` itself is checked at argument parsing for a live handle and refused with `INVALID_ARGUMENT`, comparing against the live set (no oracle for a stale one).

### 11.3 Exposures filed for Bryan (R3.5)

PR 5 adds two entries to `docs/security.md`, both confirmed by Bryan on 2026-11-04 (the plan's last section):
- **The owners list is readable by local pages.** Any page served from an allowlisted `127.0.0.1` origin can read the labels, display kinds and held document names of attached sessions.
- **Any local process can Assign itself a document**, including a Claude session using curl, bypassing the `opened` and `assigned` refusals. This is coordination, not security (D4).

### 11.4 What a non-loopback bind would add

ADR-056 ships the non-loopback bind dark. If it is re-enabled, LAN MCP peers become records that can hold and take documents and read labels, through the #1906 path. PR 1a's ADR-054 records this so the re-enable checklist gains an item; this PR does not edit ADR-056.

### 11.5 `#1952` and `peerIsLoopback`

PR 1a sets `McpRequestContext.peerIsLoopback` from `req.socket.remoteAddress` through `isLoopback`, inside the request context that wraps the whole awaited `handleRequest`, and nothing reads it. PR 1b, which would make `wakeUrlField()` (`src/server/mcp/wake-url.ts:57`) omit the field for a non-loopback peer, is **conditional**: #1952 is closed as not planned, `docs/security.md` records it as accepted by Bryan and bounded by ADR-056's `LAN_BIND_ENABLED = false` (`docs/security.md:673`), and ADR-056's re-enable checklist schedules the fix (item 3). Whether PR 1b lands now (reopening #1952 and amending ADR-056 and the register) or at the LAN re-enable is Bryan's call (§14). Nothing else here depends on it.

### 11.6 Unchanged

No new `NON_LOOPBACK_ALLOWED` entry. `/api/wake` keeps its own origin and address checks. The rest of `/api` stays ungated by ownership: a session refused `NOT_DOC_OWNER` that holds Bash can still curl `/api/save` and the other mutating routes, which no refusal copy names.

## 12. Shipping dark

**Flag.** `OWNERSHIP_ENABLED`, a literal `const false` in `src/shared/constants.ts`, injected by tsup as `__OWNERSHIP_ENABLED__` into both the server and cli bundles (the cli inlines server code). `src/server/ownership-flag.ts` reads it per call, like `src/server/file-io/docx-flag.ts`; with no define (tsx, vitest), `TANDEM_OWNERSHIP=1` turns it on.

| Requirement | How |
|---|---|
| Release builds never carry the flag | A test pins the literal `false`, in the style of `tests/docs/license-flip-consts.test.ts` |
| A shell export can't make a half-on build | `tsup.config.ts` derives the define from the literal and reads no environment variable for it (pinned by a test). A seam test pins that every bundle reaching `ownership-flag.ts` carries the define (as `tests/server/license-module-seam.test.ts` does for the licence), so no built bundle reads the environment. The client needs no flag: the badge, composer line and menu leaves appear only when document entries carry owner fields, which a dark server never writes |
| Ownership code is under a blocking test | Each ownership test file turns the flag on for itself with `vi.stubEnv("TANDEM_OWNERSHIP", "1")`, as the `.docx` suites do, so it runs in `check`. `TANDEM_OWNERSHIP` is **not** in the root `test.env`, which beats the shell |
| Each PR is green flag-off **and** flag-on | A rule for PRs 1a–5. A test that pins dark behaviour stubs the variable to `""` for itself; each PR lists such tests under "changed tests" (§17) |
| A positive anchor | A flag-on anchor test (`it.runIf(ownershipEnabled())`) runs only in the flag-on job; the job's runner refuses unless it reports at least one pass. Ownership E2E specs gate on a **runtime** signal from the server (its `tools/list` carries `ownerHandle`), not on the literal, and the runner refuses unless at least one ownership E2E spec passed |
| Nothing visible while dark | `tools/list` is built per `McpServer` from the flag: no `ownerHandle`, no `ownership` output field, no `NOT_DOC_OWNER` text, no new codes in descriptions. The op queue, scope exclusion, acknowledgement scoping, handover, handled filter, start-rule change, `startOrWake` and both new frames are bypassed. Nothing is stamped: no owner fields on document entries, no handle in prompts (the builders return today's constants) |
| An advisory flag-on job | `ownership-flag-on` in `.github/workflows/ci.yml`: `scripts/ci/build-ownership-on.mjs` runs tsup programmatically on the imported config array with the define patched in both blocks (no CLI `--define`, which would replace each block's whole define map), then `typecheck`, `npm test` and the E2E suite with `TANDEM_OWNERSHIP=1`. About 17–19 runner-minutes per push, in parallel. A wiring test inside `check` pins the job, its env, its runner and both anchors (ADR-051; PR 1a adds the instances-table row). A full flag-on E2E run is a precondition of PR 6 |
| The bound-launcher path without `claude` | The launcher tests' mocked child (`tests/server/launcher/supervisor-turn-delivery.test.ts` builds one) reads the `th_` handle from its stdin turn, and an in-test MCP client presents it to the real HTTP server, or withholds it (R2.5) |

## 13. Probes (R5 and R4.8) — measured

Measured on Claude Code 2.1.318, Windows 11, 2026-11-04.

| # | Question | Measured | Used in | If a later build differs |
|---|---|---|---|---|
| 1 | Does a resumed child keep `CLAUDE_CODE_SESSION_ID`? | `claude -p --session-id U`, then `claude -p --resume U`: a tool subprocess saw `U` both times | The bind check's header half (§3.3); the child-id stream mapping (§9.1) | Accept any header on a handle bind; a child's streams become unmapped and keep today's stream |
| 2 | Does a plugin monitor carry a session id? | A monitor (`experimental.monitors`, `when: always`) in an interactive session started with `--session-id U` saw `U` in its environment | Monitor streams map like the shim's (§9.1) | Such monitors are unmapped and keep today's stream |
| 3 | Does Claude Code hold a `GET /mcp` stream? | A direct-HTTP server under `claude -p` saw `server/discover`, `initialize`, `notifications/initialized`, then `GET /mcp` (accept `text/event-stream`) held until the process exited; no `X-Claude-Session-Id` was sent. Interactive mode was not measured; the same transport code is likely, unverified | The 2-minute return (§3.4); the direct-HTTP shim (§9.3); the stateless-era note (§3.5) | A dead terminal's documents return by the reaper bound, about 37 minutes |
| 4 | Can a direct-HTTP entry's headers carry the session id by `${CLAUDE_CODE_SESSION_ID}` expansion? | An `http` entry with `"X-Claude-Session-Id": "${CLAUDE_CODE_SESSION_ID:-unset}"`, under `claude -p --session-id V --strict-mcp-config`: every request (`server/discover`, `initialize`, `GET /mcp`) carried `unset`. Run from inside another Claude Code session, it carried that **parent** session's id instead of `V` | Rules out linking a direct-HTTP terminal by header (§3.1, §9.3) | If a later build sets the variable in its own process to its own id, setup could write the header and direct-HTTP terminals would become `claude` records; until then, never |

## 14. Conflicts, and what is open for Bryan

| Conflict | Where | What changes |
|---|---|---|
| ADR-011: `documentId` defaults to the active document | `docs/decisions.md` | Narrowed, not superseded: reads and range-keyed writes keep it (writes refuse rather than retarget); replies follow §7.3. ADR-054 records this |
| ADR-049 Decision 1: the inbox arbitrates between sessions | `docs/decisions.md` | Ownership arbitrates; the cursor registry stays the delivery record. Amended in ADR-054 |
| #2196: no start "if another AI is on" | `supervisor.ts:1410`, `:1432` | Overridden for documents Tandem's Claude holds and the chat it owns (decision 10); unchanged elsewhere |
| #2330's inbox identity pin | `tests/server/inbox-cursor.test.ts:1060-1078` | Amended per §6.8 |
| `NOT_OWNED` (#2360) | annotation lifecycle | `NOT_DOC_OWNER` is answered first |
| v4.1 D5, §5.5-A, session rename, `issueHandle`, `ownerLabel` | v4.1 | Dropped or reversed (§0) |
| Critical Rule 9 tables | `license-gate-api-coverage.test.ts`, `ai-surface-inventory-claims.test.ts` | Two route rows (§10.1); the new turn and frame writers join the inventory (§8.5) |
| CLAUDE.md's enumeration of routes that call neither gate | CLAUDE.md, `tests/docs/loopback-gate-claims.test.ts` | Unchanged: `POST /api/ownership` calls both |
| `SKILL.md`, `SERVER_INSTRUCTIONS` | `skills/tandem/SKILL.md` | Changed only at the flip (PR 6): pass the handle first in Tandem-launched sessions; follow a refusal's remedy; `tandem_open` a held document only when the user asked in your own conversation; reply with `replyTo` |

**What changes for a single session**, for the flip's CHANGELOG — the plan's two, and three more v5 adds:
1. Another AI client next to a present-but-idle Tandem's Claude is refused on Bryan's documents, with a remedy; Claude starts for them. (Plan.)
2. Tandem's Claude alone and idle-stopped is started by a new comment or a user thread reply on its documents, not only by chat. (Plan.)
3. A direct-HTTP terminal's opt-in shim has its replies refused with a remedy (§9.3).
4. A post (`tandem_reply` without `replyTo`) from a terminal is refused on a document Tandem's Claude holds while present (§7.3).
5. Tandem's Claude depends on its model passing the handle; an unbound run answers nothing until it does (§3.3, §8.6).

**Open for Bryan.**
1. **PR 1b.** Land it now (reopen #1952, amend ADR-056 and the register), or defer it to the LAN re-enable, where ADR-056 already schedules it (§11.5).
2. **Two Tandem toolsets in one terminal** (§3.1). A plugin user who also ran `tandem setup` has both the plugin's bridge entry and setup's direct-HTTP entry, and each terminal is then two records that nothing can link (probe 4). Options: accept it and promote the doctor's duplicate-toolset warning to a flip prerequisite; or have setup stop writing the direct-HTTP entry for Claude Code when the plugin is installed (which touches the launcher's "configured" check). The plan's manual check (a terminal "with the plugin and the channel shim") runs in exactly this configuration when setup has also been run.
3. **Session rename** (v4.1 §5.12, decided 2026-09-17) is not built (§10.3). Held-document names in the Assign list replace it. Reinstating it needs a route curl cannot reach, or a third filed exposure.

## 15. Known limitations

- **Restart forgets** ownership, answerers, loss records and change notices (decision 8). The handled filter still keeps answered items out of every inbox.
- **A client that never holds a `GET /mcp` stream** keeps its documents up to about 37 minutes after it dies (§3.4). An `http` record evicted by the session cap becomes a new record and loses its documents after the grace.
- **A direct-HTTP terminal's shim** is never linked (§9.3), and a terminal with two Tandem toolsets is two records (§3.1, §14).
- **A post is not an answer.** A reply without `replyTo` is checked by ownership only, so a session that holds a document can post a second, unlinked answer to an item another record answered. The refusal copy and the skill require `replyTo`.
- **Wasted turns until Phase 3:** unscoped wake sockets, the supervisor's stdin wake and unmapped shims and monitors still wake sessions that have nothing to do; `alreadyPushed` and delivery rounds still count an event as pushed before narrowing. A chat on a document Claude Desktop holds can start Tandem's Claude, which finds nothing (the plan's call; Desktop is not counted by `otherAiAttached`, `transport-registry.ts:284`).
- **A run that never binds**, repeatedly, leaves Tandem's Claude's documents waiting until Bryan sees the stale hint and Assigns (§8.6).
- **Separately spawned helpers** (a remote subagent, a second `claude` process) are separate sessions, refused on documents their orchestrator holds as `opened` or `assigned`. v4.1's `issueHandle` hand-off is not built.
- **Chat labels.** A Claude chat message does not record which session sent it.
- **The local-model collaborator** (dark, `BYO_MODELS_ENABLED`) writes in-process as the `internal` caller, bypassing ownership; its rows carry `agentIdentity` and settle nothing (§3.1). Revisit when it flips.
- **Stateless clients** (MCP `2026-07-28`) hold nothing until the stateless branch gives them a record (§3.5).

## 16. Requirements, tests and the PR that lands each

| Req | Section | Acceptance test (the plan's) | PR |
|---|---|---|---|
| R1.1 | §6.2 | The #2358 repro with cursor polls and with legacy polls; two terminals, Tandem's Claude Off, one comment | 2 |
| R1.2 | §6.3, §6.4 | Take-back after a push-answered comment; after a `claimed` owner's answer; handover both ways with old and fresh cursors | 2 (take-back case in 3b) |
| R1.3 | §5, §9.2 | Refusals per tool (1c) and on the channel path (4) | 1c, 4 |
| R1.4 | §7.1 | Two terminals, Tandem's Claude Off, one doc-less chat: one answer | 2 |
| R1.5 | §5.5 | Tandem's Claude answers; a pushed terminal takes the document and replies; refused | 1c (comments), 2 (chat) |
| R2.1 | §6.3 | Acknowledged, then Off, then the terminal is handed it | 3b |
| R2.2 | §5.2, §7.3 | Doc-less answer with no tabs; greeting; id-keyed reply on a non-active held document | 2, 3a (greeting) |
| R2.3 | §7.2 | The owner dies, then the chat is answered | 2 |
| R2.4 | §8.3, §8.4 | The decision-10 cases; Assign and Release with items waiting; single-session change 2; today's matrix otherwise | 3b (Assign/Release via the seam; end to end in 5) |
| R2.5 | §8.6 | A child that never presents its handle | 3a |
| R2.6 | §6.5 | A handover does not hand over the old owner's notices | 2 |
| R2.7 | §8.5 | Assign to a running terminal, take-back while running, a lapse while running, each answered with no new event | 3b, 5 |
| R3.1 | §6.2, §8.3, §8.4, §9.1 | Solo-held items never claim, start or wake | 2, 3b, 4 |
| R3.2 | §8.5 | AI-surface inventory derivations and licence seam pins | 3b, 4 |
| R3.3 | §3.1, §3.3, §9.2, §11.1 | A forged child id cannot bind, join the child's record or reply as Tandem's Claude | 1a, 3a, 4 |
| R3.4 | §9.1 | Unmapped and no-header streams equal today's, live and on replay | 4 |
| R3.5 | §10.1, §11.3 | Route gate tests; the two register entries | 5 |
| R3.6 | §5.3, §10.3 | No session text and no forged "Tandem's Claude" in any refusal, badge or greeting | 1c, 3a, 5 |
| R3.7 | §6.8 | The amended pin; identical cursors across records with the same holdings | 2 |
| R4.1 | §5.2 | Reads default to the active tab; writes refuse rather than retarget | 1c |
| R4.2 | §5.3 | One test per `reason`, and the precedence | 1c, 2, 4 |
| R4.3 | §8.1 | One announcement per transition; none from `status()` | 3b |
| R4.4 | §4.3 | Opening and default holding wake nobody | 2, 3b |
| R4.5 | §6.3 | Handover of a quiet background document | 2 |
| R4.6 | §6.2 | More than 256 pending foreign items; 300 open foreign documents | 2 |
| R4.7 | §10.2 | Badge E2E | 5 |
| R4.8 | §9.3 | A direct-HTTP shim's reply is refused with the remedy; its stream equals today's | 4 |
| R5 | §13 | Measured | 0 |

**Flag-on state between PRs.** After 1a, records exist and nothing is enforced. After 1c, writes are checked, but Tandem's Claude is never present (no presence until 3b), so every document is unowned or held by a terminal. After 2, the inbox is scoped. After 3a the child binds; after 3b Tandem's Claude holds documents and the plan's behaviour is complete for MCP. After 4, push narrows; after 5, Bryan has the controls.

## 17. PR sizing

Rough sizes include tests. "Changed tests" lists existing tests whose assertions change flag-on or flag-off.

| PR | Files touched | Scope | Changed tests |
|---|---|---|---|
| **1a. Identity and flag** | New `src/server/sessions/ownership.ts` (records, labels, kinds, `ownerByDoc`, `setDocOwner` with no enforcement, the presence seam); new `src/server/ownership-flag.ts`; `src/server/sessions/context.ts`; `src/server/mcp/server.ts` (records at initialize, `internal` caller, stdio record); `src/server/mcp/transport-registry.ts`; `src/cli/mcp-stdio.ts` and `src/shared/cli-runtime.ts` (`X-Tandem-Client-Id`); `src/shared/constants.ts`; `tsup.config.ts`; `scripts/ci/build-ownership-on.mjs`; `.github/workflows/ci.yml`; the default rule at Bryan's opens (`src/server/documents/open.ts`, `src/server/mcp/routes/{open,upload,scratchpad}.ts`, startup restore and `welcome.md` in `src/server/index.ts`); the close point in `src/server/mcp/document-service.ts`; `docs/decisions.md` (ADR-054, ADR-051 instances row); `CLAUDE.md` (ships-dark entry) | Medium-large: about 16 files, 1,100–1,500 lines | None flag-off; flag seam and wiring tests are new |
| **1b. #1952** *(conditional)* | `src/server/mcp/wake-url.ts`; `docs/security.md`; `CLAUDE.md`; `docs/decisions.md` (ADR-056 amendment) | Small: under 200 lines | `tests/docs/security-findings-claims.test.ts` |
| **1c. Enforcement** | New `src/server/sessions/doc-op-queue.ts`; `src/server/mcp/{document.ts, annotations.ts, list-edit.ts, docx-apply.ts, convert.ts, navigation.ts, response.ts, output-schemas.ts}`; the annotation lifecycle's reply path (answered-once for threads); `src/shared/types.ts` (`NOT_DOC_OWNER`); the refusal copy module; `docs/mcp-tools.md`. May split into queue-and-placement, then copy-and-answered-once, if review wants | Large: about 14 files, 1,800–2,500 lines | `tests/docs/tool-error-codes-claims.test.ts`; `mcp-output-schemas.test.ts`; #2360's refusal-order tests; tool-description snapshots flag-on |
| **2. Inbox and replies** | `src/server/mcp/awareness.ts` (scope, scoped acknowledgement, handled filter on both paths, scoped batch expansion, claims staged to commit, reply and post acceptance, greeting classification on the MCP path, `ownership` field); `src/server/sessions/ownership.ts` (handover, chat successors); `src/server/events/delivery-state.ts` (per-document rounds); `src/server/mcp/annotations.ts` (labels); `src/shared/types.ts`; `docs/mcp-tools.md` | Large: about 7 files, 1,500–2,000 lines | `tests/server/inbox-cursor.test.ts` (the pin); delivery-state tests; `checkInbox` output-shape tests; multi-session inbox tests that expect both sessions to be handed an item (flag-on) |
| **3a. Handle and bind** | `src/shared/launcher/contract.ts` (three prompt builders); `src/server/launcher/supervisor.ts` (mint per spawn, teardown); `src/server/sessions/ownership.ts` (bind check, absorb, cap); `src/shared/types.ts` (`INVALID_OWNER_HANDLE`, `OWNER_HANDLE_CONFLICT`); `src/server/log-sanitize.ts`; the argument-level handle scrub; `docs/mcp-tools.md`; `docs/security.md` (the handle) | Medium: about 8 files, 800–1,100 lines | Launcher prompt tests move from constants to builders (`supervisor`, `stream-json-protocol`, `supervisor-turn-delivery`) |
| **3b. Presence, take-back, starts, wakes** | `src/server/launcher/supervisor.ts` (the presence setter and announcer, run-start at the first envelope, take-back hook, start predicate and its accumulated bit at `:1410`/`:1432`, `startsOnMessage`, Solo-release check, `startOrWake`, `requestWake`); `src/server/sessions/ownership.ts` (presence consumer, waiting); `src/server/events/wake-socket.ts` (the `ownership` frame and its licence check) | Large: about 4 source files, 1,200–1,600 lines, concurrency-heavy | The #2196 start matrix (flag-on); `tests/docs/ai-surface-inventory-claims.test.ts`; licence seam pins |
| **4. Push and shim identity** | `src/server/events/sse.ts`; `src/server/mcp/channel-routes.ts`; `src/shared/sse-consumer.ts` (unknown event names); the shim and monitor (`src/channel/`, `src/monitor/`); `docs/security.md` (the header) | Medium: about 7 files, 800–1,200 lines | SSE and channel-route tests that assume every stream gets every event (flag-on) |
| **5. Controls** | New `src/server/mcp/routes/ownership.ts`; `src/server/mcp/api-routes.ts`; `src/shared/api-paths.ts`; new `src/client/tabs/TabOwnerBadge.svelte`; `DocumentTabs.svelte`; `tab-context-menu.ts`; the chat composer line; `src-tauri/src/context_menu.rs`; `src/server/documents/registry.ts` (`toDocListEntry` fields, the stale tick); testid snapshot and manifest; `docs/security.md` (two exposures) | Large: about 13 files, 1,300–1,800 lines incl. E2E | `license-gate-api-coverage.test.ts` (two rows); `testid-set.snap.txt` (add-only) |
| **6. Flip** | `src/shared/constants.ts`; `skills/tandem/SKILL.md` (version bump); `SERVER_INSTRUCTIONS`; docs; `CHANGELOG.md` (§14's five changes); the release-smoke checklist | Small in code, large in docs | Dark pins removed; skill contract hash and version |
