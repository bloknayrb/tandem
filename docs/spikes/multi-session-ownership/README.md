# Multi-Session Document Ownership — Design v5

> **Not implemented.** Design v5 is PR 0 of the approved plan, [`docs/plans/2358-ownership.md`](../../plans/2358-ownership.md) (rev 7, issue #2358). It replaces v4.1 (Bryan, 2026-09-17) and meets the plan's requirements R1–R5. Bryan's eleven decisions of 2026-11-04 and the items he confirmed are settled and are restated, not reopened. ADR-054 stays reserved for this design and is written in PR 1a.
>
> - Every `file:line` here was verified against master `4fb053a5` on 2026-11-04.
> - [stories.md](./stories.md) and [reviews/](./reviews/annotation-model.md) are the v4.1 story pass and review set. They are kept as history and are **not** re-statused for v5; v5's acceptance tests are the plan's, listed per requirement in §16.
> - v4.1's text is in git history. Where v5 keeps a v4.1 mechanism unchanged it says so in one line rather than repeating it.

## 0. What changed from v4.1

| Area | v4.1 | v5 | Why |
|---|---|---|---|
| Who answers by default | The first session handed the work claims an unowned document | **Tandem's Claude holds every document no other session opened**, while it is present (§4) | Decisions 1, 2, 11 |
| Ownership kinds | One kind | Four: `default`, `claimed`, `opened`, `assigned`; the kind decides what can move the document (§4) | The plan's kind table |
| Taking a document | No MCP transfer at all | Another session's `tandem_open` takes a `default` or `claimed` document; `opened` and `assigned` refuse (§5.4) | Decision 3 |
| Inbox bookkeeping | A per-item delivered-to ledger replacing `surfacedIds` | The ledger is gone. #2330's cursor registry stays; ownership is **scope exclusion** plus a **handover** that retires unhandled entries (§6) | `inbox-cursor.ts` replaced the ledgers v4.1 was written against |
| Answered-once | Not specified for comments | One answerer per item, recorded in memory; a handled-item filter in the inbox (§5.5, §6.4) | R1.5, R1.2, decision 6 |
| Doc-less chat | D5: disable send on an empty tab | D5 dropped. Doc-less chat belongs to Tandem's Claude while present, else per message to the first session handed it or whose answer is accepted (§7) | Plan; Bryan's 2026-10-12 decision |
| Channel shim | §5.5-A: unscoped, no identity | §5.5-B: the shim's `X-Claude-Session-Id` selects a record; its stream narrows and its replies are checked (§9) | Decision 9 |
| Direct-HTTP terminal's shim | n/a | **Never linked.** Keeps today's stream; its replies are refused with the "use the `tandem` server's `tandem_reply`" remedy (§9.3) | R4.8, probe 3 |
| Launcher | Handle per run; the child's record is released on exit | Handle per run binds the child to the one **Tandem's Claude** record, which outlives runs; presence, take-back, widened start rules, waking (§8) | Decisions 2, 7, 10, 11 |
| Dead terminal | ~32 min (idle reaper) | 2-minute grace after its `GET /mcp` stream closes, for clients that hold one (§3.4) | Probe 3 |
| `#1952` | Fixed per request in Phase 1 | `peerIsLoopback` is set in PR 1a and consumed by nothing until PR 1b, which is **conditional** on Bryan (§11.4) | #1952 is accepted and bounded by ADR-056 |
| Error code | `NOT_OWNER` | `NOT_DOC_OWNER`, distinct from `NOT_OWNED`; one code with a `reason` (§5.3) | R4.2 |
| Session names | Nickname set by Bryan or by the session; client name shown | Only server-derived kinds and Bryan's own rename are shown; a session cannot name itself and `clientInfo.name` is never displayed (§10.3) | R3.6 |
| Handles for subagents | `issueHandle` hand-off to remote subagents | Dropped. A handle exists only for Tandem's Claude's child (§3.3, §15) | Smaller surface; no requirement needs it |
| Wake socket scoping (`?watch=`, socket pin) | Phase 3 | Out of v5's scope: Phase 3 comes after the flip, and its design starts from v4.1's text | Plan |
| Shipping | Phases 1–4 | One dark flag, PRs 1a–6, a flag-on CI job (§12, §17) | Plan |

## 1. Summary

- Every open document has **at most one owner**. Only the owner is handed its items (inbox and push), and only the owner's answers and writes are accepted. Reads stay open to everyone. The server enforces this in the MCP tool layer and on `/api/channel-reply`; the rest of `/api` is Bryan's own surface and is not checked (D4).
- **Tandem's Claude** is one owner record across all its child runs. While it is **present**, it holds every document no other session opened. A terminal answers only documents it opened (or took with `tandem_open`), documents Bryan assigned to it, or documents it was handed while Tandem's Claude was not present.
- **Kinds** record how a document got its owner, and decide what can move it: a later Tandem's Claude run takes back `claimed` documents; another session's `tandem_open` takes `default` and `claimed` ones; `opened` and `assigned` documents move only by Bryan's Release or Assign, or when their owner goes away.
- **The inbox stays on #2330's cursors.** A document held by someone else is simply not in the caller's scope. When ownership changes, the registry entries the old owner was handed but did not answer are retired, so the next owner is owed them with any cursor; answered items are filtered out for everyone.
- **One answer per item.** The first record whose answer is accepted is the item's answerer; nobody else's answer is accepted after it.
- **Starting and waking.** A present Tandem's Claude that is not running is started for asks on its own documents, even with a terminal attached, and for documents that come back to it with items waiting. A running owner that receives a document with items waiting is woken.
- **It ships dark** behind one build-time flag, with an advisory flag-on CI job.

## 2. Terms

| Term | Meaning |
|---|---|
| **Owner record** | Server memory: `{ownerId, recordKind, label, transports, lastPollAt, lapsed}`. Lost on restart (decision 8). |
| **Record kind** | `tandem` (Tandem's Claude, one per server run), `claude` (a transport carrying `X-Claude-Session-Id`), `bridge` (the stdio bridge without one, e.g. Claude Desktop), `http` (a direct-HTTP transport with neither), `stdio` (stdio transport mode). Server-derived; never client text. |
| **Display kind** | What the badge and refusals show: `Tandem's Claude` (only for `recordKind: "tandem"`), `terminal`, `Claude Desktop`, `other app`. Chosen by the server from a closed list (§10.3). |
| **Label** | A random per-run id such as `owner-k7qx`, published on document entries and in refusals. Never derived from a session id or a handle. |
| **Ownership entry** | `ownerByDoc: Map<documentId, {ownerId, kind, since}>`. No entry means **unowned**. |
| **Kind** | `default`, `claimed`, `opened` or `assigned` (§4.1). |
| **Present** | Tandem's Claude may hold documents (§8.1). |
| **Default rule** | Where a document goes when nobody in particular should have it: Tandem's Claude as `default` if present, otherwise unowned. |
| **Handed** | Returned to a reader by `tandem_checkInbox`, or written to a consumer's push stream. |
| **Handled** | Answered, judged from state the answer leaves behind (§5.5). Notices are handled once handed (§6.5). |
| **Waiting** | An item on a document that is not handled and that passes the Solo hold, `hideFromAI` and the ADR-027 and withheld predicates (§8.4). |
| **Lapsed** | A record whose documents were returned to the default rule because its client went away (§3.4). The record itself may persist while its transport does. |
| **Handle** | `th_` plus 32 base64url characters, minted per Tandem's Claude child run and named in that run's supervisor prompts (§3.3). |

## 3. Identity

### 3.1 Records from transports

**Problem.** Ownership needs to know who is calling. Direct-HTTP Claude Code sends no per-session header (probe 3, §13), the stdio bridge forwards one (`src/cli/mcp-stdio.ts:438`), Claude Desktop sends neither, and stdio mode has no transport registry.

**Rule.** Each caller resolves to exactly one record, decided once at `initialize` and fixed for the transport's life:

1. `X-Claude-Session-Id` present → record `claude:<id>`, kind `claude`. Several transports may share it (a bridge reconnect, a respawned bridge).
2. Else `X-Tandem-Client-Id` present → `bridge:<id>`, kind `bridge`. A new header, minted once per bridge process and reused by its reconnects (PR 1a).
3. Else → `http:<Mcp-Session-Id>`, kind `http`.
4. Stdio transport mode → one process-wide `stdio` record (v4.1 §3.2 rule 4, unchanged).

A transport that presents Tandem's Claude's handle is then **bound** to the `tandem` record (§3.3). The header alone never binds to it (R3.3).

**Mechanism.** The registry entry already stores `claudeSessionId` and `clientName` (`McpSessionEntry`, `src/server/mcp/transport-registry.ts:54-84`), filled in at `onsessioninitialized` (`src/server/mcp/server.ts:550`). PR 1a adds `ownerId` to the entry and `ownerId` to `McpRequestContext` (`src/server/sessions/context.ts:37-59`), set in `dispatchToSession` (`server.ts:858`) and on the initialize path (`server.ts:930`). Handlers call `getCurrentOwner()`. `McpRequestContext` also gains `peerIsLoopback`, from `req.socket.remoteAddress` only; nothing reads it unless PR 1b lands (§11.4).

### 3.2 The Tandem's Claude record

**Problem.** Tandem's Claude is a sequence of child processes (spawn, idle-stop, resume, crash-resume, relaunch), each with its own MCP transport. Decisions 2, 7 and 11 need one identity that outlives them.

**Rule.** The ownership module creates one record `tandem` at boot. It owns documents only while present (§8.1). Its transports are whichever transports have bound with the current run's handle. Its label is fixed for the server run, and its display kind is always `Tandem's Claude`.

### 3.3 Binding a child run

**Problem.** The child's MCP entry is direct-HTTP (`src/server/integrations/apply.ts:514`), so its transport carries no header (probe 3). What reaches the child on every turn is the supervisor's stdin prompt.

**Rule.**
- Each spawn mints a handle. Both prompt builders (replacing `SUPERVISOR_INITIAL_PROMPT` and `SUPERVISOR_WAKE_PROMPT`, `src/shared/launcher/contract.ts:741`, `:819`) name it first: *"Your Tandem owner handle for this run is `th_…`. Pass it as `ownerHandle` on your first Tandem call, whichever tool that is."* The no-unasked-work clause stays.
- `ownerHandle` is an optional argument on four entry tools: `tandem_status`, `tandem_open`, `tandem_scratchpad`, `tandem_checkInbox`.
- **Bind check.** The handle must belong to the current run, **and** the presenting transport must carry either no `X-Claude-Session-Id` or one in `ownChildSessionIds` (`src/server/launcher/supervisor.ts:1220`, filled at `:1992`). Probe 1 shows a resumed child keeps its id, so a legitimate child always passes; a transport that names some other Claude session is refused even with a leaked handle.
- On success the transport is re-pointed to `tandem`. If the transport's previous record is a never-bound, single-transport record that already holds documents (the child opened something before binding), those documents move to `tandem` as `default` (v4.1's absorb, §5.10 there, kept). Any other prior record that holds documents → `OWNER_HANDLE_CONFLICT`, with no side effects. A transport with a document operation in flight → `OWNER_HANDLE_CONFLICT`.
- An unknown, stale or malformed handle → `INVALID_OWNER_HANDLE`, with no side effects. The copy says to use the handle from the most recent turn.
- **Teardown.** When the run ends (exit, error, stop, relaunch; `teardownTurnDelivery`, `supervisor.ts:2275`), the handle dies and every transport bound with it is re-pointed to a fresh empty `http` record. The `tandem` record and its documents are untouched: presence, not the run, decides what it holds.

**If a later Claude Code build differs (probe 1).** If a resumed child got a new `CLAUDE_CODE_SESSION_ID`, the header half of the bind check would refuse legitimate resumed children. The fallback is to drop that half and bind on the handle alone, which R3.3 already permits. Only a bridge-entry child is affected; a direct-HTTP child sends no header either way.

### 3.4 When a client goes away

**Problem.** A dead terminal's documents should come back without waiting half an hour, but a live client must not lose documents to a blip.

**Rule.** A non-`tandem` record is **attached** while at least one of its transports is registered and, if any of its transports has ever held a `GET /mcp` stream, at least one such stream is open. When it stops being attached, a 2-minute grace starts (v4.1 §5.8). A reopened stream, a new transport for the same record, or any request on one of its transports ends the grace. At expiry the record **lapses**: each of its documents goes to the default rule through `setDocOwner` (§4.3), and its per-message chat (§7) follows.

**Mechanism.** The registry already counts open streams per entry (`openStreams`, `transport-registry.ts:83`) and fires `onEvicted` on `lru | idle | explicit` closes (`:100`). The ownership module listens to both. A lapsed record whose transport is still registered keeps its label; its next call is a session that holds nothing.

**Bounds** (probe 3, §13): a Claude Code terminal that exits or crashes closes its stream with the process, so its documents return about 2 minutes later. A client that never holds a stream is noticed only by the idle reaper: up to 30 minutes of idleness (`transport-registry.ts:290`) plus the 5-minute reap interval plus the grace, about 37 minutes. The stale-owner hint (§10.2) shows the gap and Assign closes it.

**If a later build differs (probe 3).** If Claude Code stopped holding the stream, its terminals fall into the reaper bound above. Nothing else changes.

### 3.5 Stateless clients (MCP `2026-07-28`)

In probe 3, Claude Code sent `server/discover` before `initialize`: it already speaks the stateless era first and falls back. Tandem serves only the legacy branch today (ADR-045 amendment), so every caller still gets a transport and a record. CLAUDE.md forbids keying new per-client state on `Mcp-Session-Id` beyond that legacy branch: ownership keys on the **record**, and only rule 3 of §3.1 derives a record from the session id. When Tandem adds the stateless branch, a stateless caller has no record. That work must give it one (for example a server-minted id returned from discovery), or such callers hold nothing and are refused on held documents. This is recorded in §15, not designed here.

## 4. Ownership

### 4.1 Kinds

| Kind | Holder | How it arises | Taken back when a Tandem's Claude run starts | Another session's `tandem_open` |
|---|---|---|---|---|
| `default` | Tandem's Claude only | The default rule while present: Bryan's opens, restores, `welcome.md`, user scratchpads; documents Tandem's Claude opens or writes itself; documents it takes back; documents returning to it | (already its own) | takes it → `opened` |
| `claimed` | A non-`tandem` record | It was handed the document's work, or wrote to it, while the document was unowned | yes → `default` | takes it → `opened` (its own holder too) |
| `opened` | A non-`tandem` record | Its `tandem_open` of a closed file, or its take of a `default`, `claimed` or unowned document | no | refused |
| `assigned` | Any record | Bryan's Assign | no | refused |

### 4.2 Transitions

| Event | Result |
|---|---|
| Bryan opens a document (`POST /api/open`, file association, startup restore, `welcome.md`, a scratchpad he creates) | Default rule: `default` if Tandem's Claude is present, else unowned |
| Tandem's Claude's `tandem_open` / `tandem_scratchpad` | `default`; on an `opened` or `assigned` document held by another record, refused |
| Another session's `tandem_open` of a closed file, or `tandem_scratchpad` | `opened` by it |
| Another session's `tandem_open` of an open document | unowned, `default` or `claimed` (anyone's) → `opened` by it; `opened` or `assigned` held by someone else → refused; its own `opened` or `assigned` → no change |
| A write, or an inbox poll that hands items, on an unowned document | The caller claims it: `default` for Tandem's Claude, `claimed` for anyone else |
| A Tandem's Claude run **starts** (§8.2) | Every unowned and every `claimed` document → `default` |
| Tandem's Claude becomes present without a start (Off→On, Configure) | Nothing moves |
| Tandem's Claude stops being present | Every document it holds (`default` or `assigned`) → unowned |
| A record lapses (§3.4) | Each of its documents → default rule |
| Release | Default rule |
| Assign to record R | `assigned` to R |
| Bryan closes the tab | The entry is removed; unhandled chat on it keeps that owner (§7.2) |
| Server restart | Every entry and record is forgotten; Tandem's Claude is not present until its first start this run (decision 11), so restored documents start unowned |

Nothing ever claims on a read, on `tandem_switchDocument`, on list-mode `tandem_restoreBackup` or on `tandem_exportAnnotations` (v4.1 §3.7, kept).

### 4.3 One composite for every change

Every change goes through `setDocOwner(documentId, next | null, kind, reason)`, run at its turn in the document's operation queue (§5.1), or synchronously at the close point for a tab close. In order it:

1. updates `ownerByDoc`;
2. if the previous owner was a different record, runs the **handover** (§6.3);
3. queues a pull-visible change notice for both records (§6.6);
4. publishes through `broadcastOpenDocs` (`src/server/documents/registry.ts:162`), never an ad-hoc broadcast;
5. if the new owner has **waiting** items on the document, starts or wakes it (§8.4, §8.5). Holding with nothing waiting wakes nobody (R4.4).

## 5. Enforcement

### 5.1 The operation queue and refusal placement

v4.1 §3.4a is kept unchanged in substance: every MCP mutation and every ownership change on a document runs through a per-document serial queue; the ownership check is the first thing inside the operation. Refusals decided by the arguments or by facts fixed at open (`LICENSE_REQUIRED`, `NO_DOCUMENT`, `DOCUMENT_REQUIRED`, `INVALID_ARGUMENT`, `INVALID_PATH`, `READ_ONLY`, extension-decided `FORMAT_ERROR`, handle errors) run before the queue and never claim. Refusals decided by live content, the disk or the save lock (`INVALID_RANGE`, `RANGE_MOVED`, `SAVE_IN_PROGRESS`, `EXTERNAL_CONFLICT`, serializer `FORMAT_ERROR`, I/O) run inside and keep the claim. Browser edits and the reload family stay outside the queue. v4.1's lock-composition table holds; its line numbers are stale and PR 1c re-derives them.

**Ordering against #2360.** On a document held by someone else, `NOT_DOC_OWNER` is answered before any lifecycle refusal, including `NOT_OWNED` (the plan's pinned order).

### 5.2 Which document a call means (R4.1)

**Problem.** Retiring the active-tab default everywhere would break single-document scripts, and retargeting a range-keyed write to a different document than the one just read would apply its offsets to the wrong text.

**Rule.**
- **Reads** keep today's active-tab default (`getCurrentDoc`, `registry.ts:348`).
- **Range-keyed writes** without `documentId` target the active document, as today. If the caller does not hold it and cannot claim it, the answer is `NOT_DOC_OWNER` with the copy below. They never retarget silently.
- **Answers** without `documentId` (`tandem_reply` with no `replyTo`; §7.3) target the caller's single held document, else the active document if the caller holds or can claim it, else doc-less (§7.3). Where none of those resolves, `DOCUMENT_REQUIRED`, carrying the caller's held document ids and the remedy "pass `documentId`".
- **The four id-keyed annotation tools** resolve the document by annotation id first (#2187), then check ownership on it (R2.2).

### 5.3 Refusal copy (R4.2, R3.6)

One error code, `NOT_DOC_OWNER`, with `details: {reason, documentId, holder: {label, displayKind}}`. The holder's display is rendered by the server from the record kind (§10.3). Each message carries its remedy, because older skills stay in use after the flip:

| `reason` | When | Message (shape) |
|---|---|---|
| `default` | The document is held by Tandem's Claude as `default` | "Tandem's Claude is answering this document. If the user asked you to work on it, call `tandem_open` on it to take it over; otherwise leave it." |
| `lost` | The caller held it earlier this run and no longer does | "You no longer hold this document; it moved to {holder} ({cause: Bryan reassigned it / you were away / Tandem's Claude took it back}). Read it freely; to write, ask Bryan to assign it to you." |
| `held` | `opened` or `assigned` by another record | "{holder} is working on this document. Only Bryan can reassign it, from the owner badge on its tab. Do not retry." |
| `chat` | A doc-less or closed-document chat message owned by someone else | "This message belongs to {holder}, which will answer it. Do not reply to it." |
| `answered` | The item was already answered by another record (§5.5) | "{holder} already answered this. Do not answer it again." |
| `unlinked` | `/api/channel-reply` from a shim with no record (§9.3) | "This reply could not be matched to your Tandem session. Send it with the `tandem` server's `tandem_reply` tool instead." |

`reason: "lost"` needs no cursor state: the record keeps the last few documents it lost, with the cause, until it next polls (§6.6). No refusal ever mentions `/api`.

### 5.4 The `tandem_open` take rule (decision 3)

Inside the operation, per §4.2. A take of a `default` document whose holder is mid-operation waits its turn in the queue, then takes it; the operation behind it from Tandem's Claude then meets `NOT_DOC_OWNER` with `reason: "lost"`. A re-open of a document the caller already holds is a no-op and does not activate the tab (v4.1 §3.4). A take does not activate the tab either; only a fresh open does.

### 5.5 One answer per item (R1.5)

**Problem.** Decision 3 lets a session that was pushed an item take the document after the item was answered, and then answer again. Ownership alone cannot stop that, because the new owner is the owner.

**Rule.** The first record whose answer to an item is accepted is that item's **answerer**. A later answer to the same item is accepted only from the answerer. The answerer's own follow-ups (an `inProgress` acknowledgement, then the result) are allowed.

**Mechanism.** An in-memory `answerer: Map<itemKey, ownerId>`:
- **Comments and thread replies.** The item is the thread's latest user entry (the comment at its current `editedAt`, or the latest user reply). A Claude reply on the thread (`tandem_annotationReply`, or the thread reply #2360 adds) by record X sets `answerer` for that item to X if unset. A reply by Y ≠ X while the thread's latest user entry is answered by X → `NOT_DOC_OWNER`, `reason: "answered"`. A new user reply, or an edit of the comment, makes a new latest item, which the current owner may answer.
- **Chat.** The item is the message named by `replyTo`. The same rule, checked against `answerer` and against `answeredChatIds` (`src/server/mcp/awareness.ts:1586`). A reply with no `replyTo` answers nothing and is checked only by ownership.
- After a server restart the map is empty: an item already answered in persisted state (a Claude reply on the thread, or a `replyTo` reply) has no recorded answerer, and an answer from its current owner is accepted. This is decision 8's limitation; the inbox filter (§6.4) still keeps such items out of every inbox, so nobody is handed it.

### 5.6 `tandem_switchDocument`

Owner-only, checked at handler entry outside the queue, and never a claim (v4.1 §3.3 item 4, kept). On a document held by another record → `NOT_DOC_OWNER`; on an unowned one → `NOT_DOC_OWNER` with `holder: null` and "open or write it first".

### 5.7 Reads and labels

Reads are open. `tandem_getAnnotations` and `tandem_listDocuments` label each document with `owner: {label, displayKind, kind, you}` (or `null`). `tandem_status` returns the caller's own label, display kind and held document ids.

## 6. The inbox under cursors

### 6.1 What the inbox is today

`tandem_checkInbox` keeps no per-reader state. One process-wide registry gives every returned item version a sequence number the first time any poll returns it (`src/server/mcp/inbox-cursor.ts:10-12`); each reader's position is a mark per scope inside the opaque cursor it passes back (`inbox-cursor.ts:22-31`). A fresh reader counts as seen whatever **some** reader acknowledged (`seenBy`, `inbox-cursor.ts:107-110`). Default polls read every open document (`collectInboxDocuments`, `awareness.ts:1152`), skipping quiet background documents (`awareness.ts:1227-1237`). Chat is one scope read on every poll; a message answered by a `replyTo` reply is skipped for every reader (`awareness.ts:1605-1607`).

Ownership changes three things: which documents and messages a poll reads (scope), what happens when ownership changes (handover), and which items are ever handed (the handled filter).

### 6.2 Scope (R1.1, R4.6)

**Rule.** A poll by record X reads:
- documents X holds;
- unowned documents, claiming each one that yields items (claim on delivery, v4.1 §3.5 step 4: the claim succeeds only if the document is still unowned and its queue is idle; otherwise its items are dropped from this pass unmarked);
- chat messages whose owner (§7.1) is X, or which are claimable by X.

A document or message held by anyone else is **not read**: it is left out of `collectInboxDocuments`'s `order` and out of the chat pass. This is exclusion, not an `admit` refusal: nothing is logged as dropped and no "malformed" text appears. A named poll of a document held by someone else returns no items for it and lists it in `ownership.notYours`.

**Why the cursor needs nothing new.** An excluded document is an **unread** document to `nextCursor` (`awareness.ts:1343`): it keeps the reader's old position while anything above it exists. So the excluded reader never moves its mark over another owner's entries, and `acknowledgeCursor` (`awareness.ts:1674`) never acknowledges them for the fresh-reader floor.

**Chat acknowledgement.** Chat is the exception: the chat mark moves to the counter on every poll (`nextCursor`), so `acknowledgeCursor` would stamp another owner's messages `read`. Under the flag, a reader's acknowledgement applies only to messages in its scope at the time of the poll. The handler reads the caller's record to decide that; nothing is written into the cursor (R3.7).

**Cost (R4.6).** An excluded document costs no collection. The reader's cursor lists at most one entry per excluded document with activity, so it is bounded by the open documents; past `MAX_CURSOR_ENTRIES` (256, `inbox-cursor.ts:393`) the existing fold applies, which yields duplicates, never loss. Foreign items never enter a reader's held lists, so 300 pending items on another owner's documents add nothing to its cursor.

### 6.3 Handover (R1.2, R2.1, R2.3, R4.5)

**Problem.** Once the old owner acknowledged items, a fresh new owner counts them as seen, and a new owner whose mark already passed them is never owed them. Both lose the item.

**Rule.** When `setDocOwner` moves document D away from record X (to anyone, or to unowned), every item on D that X may have been handed and that is **not handled** is owed again to every reader; handled items stay settled.

**Mechanism**, in one synchronous step inside `setDocOwner`:
1. **Retire** every live registry entry in D's scope whose item is not handled (§6.4) and is answerable (`inbox-cursor.ts:308`, `retire`). A retired item that qualifies again gets a new seq above every mark, so the next owner is owed it with any cursor.
2. **Notices** (accept, dismiss) are handled: their entries in D are marked acknowledged (`markAcked`) and stay (§6.5).
3. **Chat** on D (including closed-document chat that X owned, §7.2) that is not answered: retire its chat entry, and set `read: false` and `delivered: false` on the message, in one `withInternal` transaction on `Y_MAP_CHAT` (Critical Rule 2; the chat observer emits `chat:message` only for browser-origin writes, so no event fires). Retiring alone is not enough for chat: a message with no entry is owed only while unread (`awareness.ts:1622-1627`).
4. **Bump the quiet epoch** of D (`quietDocState`, `awareness.ts:809`), so no reader's quiet-skip record survives the change (R4.5).

The new owner's own scope then reads D on its next poll. X no longer reads it.

### 6.4 The handled filter

**Rule.** Under the flag, an item that is handled is never handed to anyone: a user comment at a given `editedAt` with a later Claude reply on its thread, a user thread reply with a later Claude reply on the thread, or a chat message answered by a `replyTo` reply (today's `answeredChatIds`). This judges from persisted state, so it covers an answer given from a **push** before any poll registered the item (R1.2), and it holds across a restart.

For a single session nothing visible changes: a reader that was handed an item already has it, and an edit or a new user reply makes a new, unhandled item.

### 6.5 Notices (R2.6)

Accept and dismiss notices need no answer. They count as handled once their owner was handed them: by a poll (their registry entry exists and is acknowledged at handover, step 2 above) or by a mapped push stream (§9.1 registers and acknowledges the entry when it writes the event). A notice nobody was ever handed has no entry and goes to the next owner.

### 6.6 What the response says about ownership

`tandem_checkInbox` gains `ownership: {holding: [documentId], notYours: [documentId], changed: [{documentId, change: "gained" | "lost", cause}]}`. `holding` is computed per poll. `changed` drains the caller's record-level change notices (§4.3 step 3). Nothing here is read from or written into the cursor.

### 6.7 Delivery rounds

`pendingSince` (`src/server/events/delivery-state.ts:86`) is one global round, closed by any poll. Under ownership a terminal's poll would close a round that Tandem's Claude has not seen. Under the flag it becomes per document (doc-less chat under one `"*"` key), and a poll closes only the rounds of the documents it read. `/health` reports the oldest open round. v4.1 §3.5 had the same change.

### 6.8 The cursor pin (R3.7)

`tests/server/inbox-cursor.test.ts:1060-1078` pins that the cursor module and the inbox handler import no transport or session identity. It is amended to: `inbox-cursor.ts` imports nothing from the ownership module; the handler may import `getCurrentOwner` and the scope predicate from it, and nothing else; and a new test shows two different records at the same position receive byte-identical cursors.

## 7. Chat ownership and replies

### 7.1 Who owns a message (R1.4)

| Message | Owner |
|---|---|
| On an open document D | D's owner. Unowned D: claimable with D (§6.2). |
| On a closed document | The snapshot taken when the tab closed (§7.2) |
| Doc-less, or on a closed document with no snapshot | Its per-message owner if set; else Tandem's Claude while present; else claimable |

A claimable message gets a per-message owner when a poll hands it to a record, or when a record's answer to it is accepted, whichever is first. Exactly one record can then answer it, or none is set yet and the first accepted answer sets it.

A per-message owner keeps its message when Tandem's Claude becomes present (the plan's call).

### 7.2 Closed documents and successors (R2.3)

When Bryan closes D, every unanswered chat message on D gets D's owner at that moment as its per-message owner. When a per-message owner lapses, or is Tandem's Claude and stops being present, each of its unanswered messages goes to the default rule like doc-less chat, with the chat half of the handover (§6.3 step 3).

### 7.3 Reply acceptance (R2.2)

`tandem_reply({text, replyTo?, documentId?})`:
1. **`replyTo` given.** The message's own scope decides: on an open document, ownership of that document; otherwise its message owner (§7.1). A claimable message is claimed by the accepted reply. Then the answered-once check (§5.5). An explicit `documentId` that contradicts the message's → `INVALID_ARGUMENT`, as v4.1.
2. **No `replyTo`.** `documentId` if given, checked by ownership. Otherwise §5.2's answer default. A message that resolves to no document is a doc-less **post**, not an answer: it is accepted from Tandem's Claude while present, and from any record while Tandem's Claude is not present. Anything else → `NOT_DOC_OWNER`, `reason: "chat"`.

**The first-run greeting** (#2193) is Tandem's Claude's doc-less post, so it lands under rule 2. Nothing else about the greeting changes.

`appendClaudeChatMessage` (`awareness.ts:284`) stamps the accepted reply with the sender's label (an optional `ChatMessage.ownerLabel`), for the chat label the badge work may render later.

## 8. Tandem's Claude: presence, take-back, starting, waking

### 8.1 Presence (R4.3, decision 11)

**Rule.** Tandem's Claude is present when all of these hold:
- a child has been spawned at least once this server run (the post-spawn point, `supervisor.ts:1985-1992`);
- it is configured;
- the saved mode is not Off;
- it is not staying down. Staying down is: the breaker is tripped, or `lastError` is set with no restart pending. Today's `lastError` values are `needs-login`, `unlicensed`, `cli-unusable`, `binary-not-found`, `spawn-failed`, `stop-failed`, `circuit-open` and `wake-delivery-failed`. A new value is staying-down unless listed otherwise; an exhaustive-switch test makes adding one a decision.

While present it keeps its documents through idle-stop, resume, crash-resume and relaunch (decision 7), because none of those sets a staying-down state with no restart pending.

**Announcer.** The supervisor recomputes presence at the end of each transition it already runs under its operation lock (spawn, stop, mode change, the error and breaker writes), and calls `onPresenceChange(present)` only when the value differs from the last one announced. `status()` never announces. Its `cli-unusable` lapse (`supervisor.ts:3412-3418`) clears an error on a read, so presence becomes true again at the next spawn rather than at that read; until then the documents stay where the not-present state put them.

### 8.2 Take-back (decision 2)

**Rule.** When a Tandem's Claude run starts (the spawn reaches the post-spawn point), every unowned and every `claimed` document becomes `default`, each through `setDocOwner` and so through the handover (§6.3) when it was `claimed`. `opened` and `assigned` documents stay. Take-back is never itself a start trigger; it happens because a run started.

A run started by a chat while Off follows the 2026-10-13 behaviour (the mode becomes on-click, `tests/server/launcher/supervisor-turn-delivery.test.ts:1978`); it is a run start like any other.

### 8.3 Start rules (R2.4, decision 10)

**Rule.** For an event on a document Tandem's Claude holds, or a doc-less or closed-document chat it owns, a present Tandem's Claude that is not running starts for:
- a user chat message;
- a new user comment (`annotation:created` of a user comment, with or without a suggestion);
- any user thread reply.

Here "another AI is on" does not stop the start. Everything else is today's rule: `isStartWorthy` (`src/shared/events/wake-scope.ts:57`) and "not if another AI is on" for events on documents Tandem's Claude does not hold, and Apply's `other-ai` refusal.

An event on a document held by another **attached** record starts nothing. On a document whose holder is in its grace, today's rule applies, and a start takes back any `claimed` document.

**Mechanism.** The standby watch callback (`supervisor.ts:1410`) and `startForMessage`'s re-check under the lock (`:1432`) take a `startWorthyFor(event)` predicate from the ownership module that returns `{start, ignoreOtherAi}`. The watch subscribes through `wasForwardedExternally` (`supervisor.ts:321`), so the Solo hold, `hideFromAI` and the licence refusal have already run before it sees an event (R3.1).

### 8.4 Starting for a returning document

**Rule.** When a document reaches a present, not-running Tandem's Claude with items **waiting**, by Assign, Release, or a lapsed holder, it starts, ignoring "another AI is on". Off→On moves nothing and so starts nothing.

**Waiting** is computed by the same document collector the inbox uses, with no cursor and after every privacy gate (Solo hold, `hideFromAI`, ADR-027 and withheld predicates; R3.1), counting only unhandled answerable items and unanswered chat. A Solo-held item is never waiting.

**Mechanism.** `setDocOwner` step 5 calls a supervisor seam, `startOrWake(reason)`. It runs under the operation lock with the same re-checks as `startForMessage` minus the other-AI condition, and records the owed wake synchronously first, as the standby watch does. PR 5's Assign and Release reach it through `setDocOwner`.

### 8.5 Waking a running owner (R2.7)

**Rule.** When a document reaches a running owner with items waiting (take-back, a lapsed holder's documents, Assign, Release), that owner is woken. Holding with nothing waiting wakes nobody (R4.4).

**Mechanism.**
- **Tandem's Claude:** `requestWake()`, a new supervisor method that writes the wake prompt through the same coalescing as `onTandemEvent` (`supervisor.ts:2246`). It passes `aiRefusal()` first; the AI-surface inventory test and the licence-module seam pin are updated to see it (R3.2).
- **Other records:** a payload-free `ownership` frame on `/api/wake` and, for a mapped push stream (§9.1), a payload-free `ownership:changed` SSE event. Before Phase 3 a wake socket is unscoped, so every armed session gets the frame, polls, and finds nothing unless it is the new owner. Neither frame enters `pushEvent`, so `isWakeWorthy` and delivery rounds never see it. Pull remains the backstop: the change is in the next poll's `ownership.changed`.

### 8.6 A run that never binds (R2.5)

A child that never presents its handle runs as an ordinary `http` record. The documents stay with the `tandem` record (presence, not the run, holds them), so the inbox never hands them to the unbound child or to anyone else, and their items stay waiting when it exits. The next start answers them. If every run fails to bind (a broken config), the stale-owner hint shows that Tandem's Claude has not polled, and Bryan can Assign (§15).

## 9. Push paths and the shim's identity

### 9.1 Narrowing the event stream (R3.4, decision 9)

**Problem.** The shim and the plugin monitor read `/api/events` with full content for every document. Both already send `X-Claude-Session-Id` on that request (`authFetch` → `withClaudeSessionHeader`, `src/shared/cli-runtime.ts:157-160`, `:178`).

**Rule.** Per event, at the moment of writing it (live and on `Last-Event-ID` replay, `src/server/events/sse.ts:72-84`, `:97-108`), the server maps the stream's header to a record:
- a live `claude:<id>` record → that record;
- an id in `ownChildSessionIds` for the current run → the `tandem` record, for reading only (§9.2);
- anything else, or no header → **unmapped**, which gets exactly today's stream.

A mapped stream gets an event when its document is held by the record or unowned; a doc-less or closed-document chat event when the message's owner (§7.1) is the record or the message is claimable; and every event with no document that is not chat (the Solo release wake, for example). Narrowing is applied after the existing Solo filter and licence refusal, never before (R3.1). Mapping per event means a shim that connected before its bridge initialized becomes mapped as soon as the record exists.

When a mapped stream writes an accept or dismiss notice, it registers and acknowledges the item's entry, which is what makes the push count as reaching the owner (§6.5).

**Monitor terminals (probe 2).** A plugin monitor started under `--session-id U` saw `CLAUDE_CODE_SESSION_ID = U`, so its stream carries the header and is mapped exactly when its terminal has a `claude:U` record (the bridge entry). *If a later build differs:* a monitor without the variable is unmapped and keeps today's stream.

### 9.2 `/api/channel-reply` (R1.3, R3.3)

**Rule.** After the body checks (`src/server/mcp/channel-routes.ts:124-133`) and before the greeting classifier and the append (`:137-145`), the route maps the header as in §9.1 and applies §7.3's acceptance and §5.5's answered-once check as the mapped record:
- a `claude:<id>` record → accepted or refused as that record;
- a Tandem's Claude child id → **not** accepted as Tandem's Claude: the header is never sufficient to bind to it (R3.3). Refused with `reason: "unlinked"`. Tandem's Claude's child is woken through stdin and answers through its bound `tandem` server, so nothing it needs goes through this route;
- unmapped → refused, `reason: "unlinked"`.

A refusal is HTTP 409 with the `NOT_DOC_OWNER` body; the shim already relays a failed reply's status and body to the model as the tool result.

### 9.3 A direct-HTTP terminal's shim (R4.8, settled)

**Problem.** A `tandem setup` terminal's MCP entry is direct-HTTP (`apply.ts:514`): Claude Code sends it no per-session header (probe 3), and setup writes only static headers. Its shim does send `X-Claude-Session-Id`, but no record carries that id.

**Settled: such a shim is never linked.** It keeps today's full stream (R3.4), and its replies get the `unlinked` refusal, whose remedy sends the model to the `tandem` server's `tandem_reply`, which is ownership-checked as the terminal's own `http` record. The three ways to link it were each rejected:
- **A pairing id written by setup** names the install, not the session: two terminals sharing one `.mcp.json` would collide and each could answer as the other.
- **A value the model carries between the two servers** (a code from `tandem_status` passed into the shim's reply, or the reverse) depends on every model and every older skill doing it, and fails silently when they don't. The refusal plus its remedy reaches the same end with no new protocol.
- **Expanding `${CLAUDE_CODE_SESSION_ID}` in the entry's headers** depends on whether Claude Code expands that variable in its own process, which is unmeasured. If a probe shows it does, setup can write that header and these terminals become `claude` records, linked like the bridge entry, with no change to this design. That probe is not on PR 4's path.

The cost is a third single-session change for the flip's CHANGELOG: a direct-HTTP terminal using the opt-in shim has its first chat reply through the shim refused, then replies through the `tandem` server. Bridge-entry terminals are linked by header equality on both sides and are not affected.

### 9.4 What stays unscoped until Phase 3

`/api/wake` sockets and the supervisor's stdin wake stay unscoped: an armed session, or Tandem's Claude's child, is still woken for every wake-worthy event, finds nothing in its inbox for documents it does not hold, and ends its turn. That costs a turn per event and produces no answer. An unmapped shim or monitor still receives full content; its writes are refused on documents the terminal does not hold, and its replies are always refused (§9.3).

## 10. Controls

### 10.1 Routes (R3.5)

One new registrar, `src/server/mcp/routes/ownership.ts`, wired through `api-routes.ts` like the others.

- **`POST /api/ownership`** `{documentId, action: "release" | "assign", ownerLabel?}` and `{action: "rename", ownerLabel, nickname}`. Non-GET, so loopback-only by the path-wide invariant. It requires a parsed JSON body (no `text/plain` simple request reaches it) and calls `assertOriginAllowlisted`: the native menu's Release and Assign leaves dispatch to the webview as `ctx:tab:*` actions (`src/client/tabs/tab-context-menu.ts:15-26`), so every request comes from the webview with its origin. It runs through the document's queue with v4.1's 10-second wait, `409 busy`, no-op answers (`200 {changed: false}`), `404 unknown-owner` and `409 owner-detached`.
- **`GET /api/ownership/owners`** returns `[{label, displayKind, nickname?, holdsCount, canTake}]` for attached records and for Tandem's Claude while present. GET is outside the path-wide loopback invariant, so the handler checks `req.socket.remoteAddress` itself and answers 403 otherwise.
- Critical Rule 9: both get rows in `tests/server/license-gate-api-coverage.test.ts`, `open`, because they change coordination state and never document content or the annotation store.

### 10.2 The badge (R4.7)

Each tab shows `data-testid="tab-owner-badge"`: the holder (Bryan's nickname for it if any, else its display kind and label), its kind, and three hints, all carried on the `Y_MAP_OPEN_DOCUMENTS` entries through `toDocListEntry` (`registry.ts:127`), so no new Y.Map key:
- **stale owner**: a coarse boolean, true when the holder has not polled for 5 minutes and items are waiting. The record's `lastPollAt` stays server-side; only the boolean is published.
- **"waiting — Start to answer"**: the holder is Tandem's Claude, it is not running, no start is pending, and items are waiting. It carries a Start button that calls the existing Start control.
- **Release** is hidden where it would change nothing: on an unowned document, and on a `default` document while Tandem's Claude is present.
- **Assign** lists only records that can take a document (`canTake`): attached records, and Tandem's Claude only while present.

The popover is reachable on both runtimes; the Tauri menu gains a Release leaf and an Assign leaf that opens the popover (v4.1 §3.11). The testid snapshot gains the new selectors, add-only.

### 10.3 What the badge and refusals may say (R3.6)

- The display kind is the server's choice from a closed list: `Tandem's Claude` for `recordKind: "tandem"` only; `Claude Desktop` when `clientInfo.name` equals `CLAUDE_DESKTOP_CLIENT_NAME` (`transport-registry.ts:235`); `terminal` for a `claude` record or an `http` record whose client name is Claude Code's; `other app` otherwise. A client can choose which of the last three it appears as, never `Tandem's Claude`, and never free text.
- `clientInfo.name` is used only to pick from that list and is never displayed.
- A nickname is set only by Bryan (`POST /api/ownership {action: "rename"}`), sanitized as v4.1 §3.11 described. v4.1's `tandem_status({nickname})` is dropped: it put text a session chose on the badge. A nickname matching the label pattern or naming `Tandem's Claude` is refused.

## 11. Security posture

### 11.1 The header (R3.3)

`X-Claude-Session-Id` **selects** among identities and is not proof. Any local process can send any value. Within D4 (ownership is coordination between Claude sessions, not a security boundary; every local process already holds every write, because loopback callers bypass bearer auth), a forged id gets that session's narrowed events and its reply rights on `/api/channel-reply`. It never gets Tandem's Claude's reply or write rights: binding to the `tandem` record needs the live handle (§3.3), and the channel route never maps a header to it for writing (§9.2). A forged child id gets the `tandem` record's narrowed **stream**, which is never more than today's unmapped stream. PR 4 records this in `docs/security.md`.

### 11.2 Handles

Minted per child run, named only in that run's stdin prompts, dead at teardown, never written to `launcher-session.json`, redacted by `log-sanitize.ts`, and checked against the transport's header (§3.3). An invalid handle has no side effects. A handle is accepted only on the four entry tools, never as text: a reply, comment, edit or scratchpad body containing a live handle is refused with `INVALID_ARGUMENT` (v4.1 §6's scrub, reduced to handles since there are no watch ids).

### 11.3 Exposures filed for Bryan (R3.5)

PR 5 adds two entries to `docs/security.md`:
- **The owners list is readable by local pages.** Any page served from an allowlisted `127.0.0.1` origin can read the labels, display kinds and held counts of attached sessions. It cannot read documents through this route.
- **Any local process can Assign itself a document**, including a Claude session using curl, bypassing the `opened` and `assigned` refusals. This is coordination, not security (D4).

Bryan confirmed both on 2026-11-04 (the plan's last section).

### 11.4 `#1952` and `peerIsLoopback`

PR 1a sets `McpRequestContext.peerIsLoopback` from `req.socket.remoteAddress`, ungated, and nothing reads it. PR 1b, which would make `wakeUrlField()` (`src/server/mcp/wake-url.ts:57`) suppress the field for a non-loopback peer, is **conditional**: #1952 is closed as not planned, `docs/security.md` records it as accepted by Bryan and bounded by ADR-056's `LAN_BIND_ENABLED = false` (`docs/security.md:673`), and ADR-056's re-enable checklist schedules the fix (item 3). Whether to land PR 1b now (reopening #1952 and amending ADR-056 and the register) or at the LAN re-enable is Bryan's call (§14). Nothing else in this design depends on it.

### 11.5 Unchanged

No new `NON_LOOPBACK_ALLOWED` entry. `/api/wake` keeps its own origin and address checks. The rest of `/api` stays ungated by ownership; a session refused `NOT_DOC_OWNER` that holds Bash can still curl `/api/save` and the other mutating routes, which the refusal copy never names.

## 12. Shipping dark

**Flag.** `OWNERSHIP_ENABLED`, a literal `const false` in `src/shared/constants.ts`, injected by tsup as `__OWNERSHIP_ENABLED__` into every bundle that imports the flag module (`src/server/ownership-flag.ts`, read per call like `src/server/file-io/docx-flag.ts`). With no define (tsx, vitest), `TANDEM_OWNERSHIP=1` turns it on.

| Requirement | How |
|---|---|
| Release builds never carry the flag | A test pins the literal `false`, in the style of `tests/docs/license-flip-consts.test.ts` |
| A shell export can't make a half-on build | The env fallback applies only where the define is absent. A seam test pins that every bundle reaching `ownership-flag.ts` carries the define (as `license-module-seam.test.ts` does for the licence), so no built bundle ever reads the environment. The client needs no flag: the badge renders only when document entries carry owner fields, which a dark server never writes |
| Tests can run flag-on, proven | `TANDEM_OWNERSHIP` is **not** in the root `test.env` (which beats the shell). The flag-on job exports it; a positive-anchor test `it.runIf(ownershipEnabled())` runs only there, and the job's runner refuses unless that test reports at least one pass |
| Nothing visible while dark | `tools/list` is built per `McpServer` from the flag: no `ownerHandle`, no `ownership` output field, no `NOT_DOC_OWNER` text, no new codes in descriptions. The op queue, scope exclusion, handover, handled filter, start-rule change and `startOrWake` are bypassed. Nothing is stamped: no owner fields on document entries, no `ownerLabel` on chat, no handle in prompts (the prompt builders return today's constants) |
| An advisory flag-on job | `ownership-flag-on` in `ci.yml`: build with the define forced on through `scripts/ci/build-ownership-on.mjs` (the only caller of the override, pinned by a grep test against the release workflows), then `typecheck`, `npm test` and the ownership E2E specs, with `TANDEM_OWNERSHIP=1`. About 17–19 runner-minutes per push, in parallel. A wiring test inside `check` pins the job, its env, its runner and the anchor (ADR-051) |
| Existing tests that change | Listed per PR in §17 |
| The bound-launcher path | A stub child (a node script speaking stream-json) that presents or withholds its handle, because CI has no `claude` |

## 13. Probes (R5) — measured

Measured on Claude Code 2.1.318, Windows 11, 2026-11-04.

| # | Question | Measured | Used in | If a later build differs |
|---|---|---|---|---|
| 1 | Does a resumed child keep `CLAUDE_CODE_SESSION_ID`? | `claude -p --session-id U`, then `claude -p --resume U`: a tool subprocess saw `U` both times | The bind check's header half (§3.3); child-id stream mapping (§9.1) | Drop the header half and bind on the handle alone; a child's streams become unmapped and keep today's stream |
| 2 | Does a plugin monitor carry a session id? | A monitor (`experimental.monitors`, `when: always`) in an interactive session started with `--session-id U` saw `U` in its environment | Monitor streams map like the shim's (§9.1) | Such monitors are unmapped and keep today's stream |
| 3 | Does Claude Code hold a `GET /mcp` stream? | A direct-HTTP server under `claude -p` saw `server/discover`, then `initialize`, `notifications/initialized`, then `GET /mcp` (accept `text/event-stream`) held until the process exited; no `X-Claude-Session-Id` was sent. Interactive mode was not measured separately; the same transport code is likely but unverified | The 2-minute return after a terminal dies (§3.4); the direct-HTTP shim settlement (§9.3); the stateless-era note (§3.5) | Without a held stream, a dead terminal's documents return by the reaper bound, about 37 minutes |

## 14. Conflicts with existing decisions and code

| Conflict | Where | What changes |
|---|---|---|
| ADR-011: `documentId` defaults to the active document | `docs/decisions.md` | Narrowed, not superseded: reads keep it; writes keep it but refuse rather than retarget; answers use §5.2. ADR-054 records this |
| ADR-049 Decision 1: the inbox arbitrates between sessions | `docs/decisions.md` | Ownership arbitrates; the cursor registry stays the delivery record. Amended in ADR-054 |
| #2196: no start "if another AI is on" | `supervisor.ts:1410`, `:1432` | Overridden for documents Tandem's Claude holds and the chat it owns (decision 10); unchanged elsewhere |
| #2330's inbox identity pin | `tests/server/inbox-cursor.test.ts:1060-1078` | Amended per §6.8 |
| `NOT_OWNED` (#2360) | annotation lifecycle | `NOT_DOC_OWNER` is answered first |
| v4.1 D5 | v4.1 §3.6 | Dropped |
| v4.1 §5.5-A | v4.1 §5.5 | Reversed to B (decision 9) |
| v4.1 session self-naming | v4.1 §3.11 | Dropped (R3.6) |
| Critical Rule 9 tables | `license-gate-api-coverage.test.ts` | Two rows (§10.1); `requestWake` joins the AI-surface inventory (§8.5) |
| The six-route enumeration in CLAUDE.md's security section | CLAUDE.md, `tests/docs/loopback-gate-claims.test.ts` | Unchanged: `POST /api/ownership` carries both gates |
| `SKILL.md`, `SERVER_INSTRUCTIONS` | `skills/tandem/SKILL.md` | Changed only at the flip (PR 6): handle first in Tandem-launched sessions; follow the refusal's remedy; `tandem_open` a held document only when the user asked |

**Open for Bryan.** PR 1b: land it now (reopen #1952, amend ADR-056 and the register), or defer it to the LAN re-enable where ADR-056 already schedules it (§11.4).

## 15. Known limitations

- **Restart forgets** ownership, answerers and the record-level change notices (decision 8). The handled filter still keeps answered items out of every inbox.
- **A client that never holds a `GET /mcp` stream** keeps its documents up to about 37 minutes after it dies (§3.4). The stale-owner hint and Assign cover it.
- **A direct-HTTP terminal's shim** is never linked (§9.3): one refused reply per conversation, then the `tandem` server's tool.
- **Wasted turns until Phase 3**: unscoped wake sockets, the supervisor's stdin wake, and unmapped shims and monitors still wake sessions that have nothing to do (§9.4). A chat on a document Claude Desktop holds can start Tandem's Claude, which finds nothing (the plan's call; Desktop is not counted by `otherAiAttached`, `transport-registry.ts:284`).
- **A run that never binds**, repeatedly, leaves Tandem's Claude's documents waiting until Bryan sees the stale hint and Assigns (§8.6).
- **Separately spawned helpers** (a remote subagent, a second `claude` process) are separate sessions. They are refused on documents their orchestrator holds as `opened` or `assigned`; the orchestrator writes itself or Bryan assigns. v4.1's `issueHandle` hand-off is not built.
- **Stateless clients** (MCP `2026-07-28`) have no record until the stateless branch gives them one (§3.5).

## 16. Requirements to sections and tests

| Req | Section | Acceptance test (from the plan) |
|---|---|---|
| R1.1 | §6.2 | The #2358 repro with cursor polls and with legacy polls; two terminals, Tandem's Claude Off, one comment |
| R1.2 | §6.3, §6.4 | Take-back after a push-answered comment; after a `claimed` owner's answer; handover both ways with old and fresh cursors |
| R1.3 | §5, §9.2 | Refusals per tool and per path |
| R1.4 | §7.1 | Two terminals, Tandem's Claude Off, one doc-less chat: one answer |
| R1.5 | §5.5 | Tandem's Claude answers; a pushed terminal takes the document and replies; refused |
| R2.1 | §6.3 | Acknowledged, then Off, then the terminal is handed it |
| R2.2 | §5.2, §7.3 | Doc-less answer with no tabs; greeting; id-keyed reply on a non-active held document |
| R2.3 | §7.2 | The owner dies, then the chat is answered |
| R2.4 | §8.3, §8.4 | The decision-10 cases; Assign and Release with items waiting; single-session change 2; today's matrix otherwise |
| R2.5 | §8.6 | A stub child that never presents its handle |
| R2.6 | §6.5 | A handover does not hand over the old owner's notices |
| R2.7 | §8.5 | Assign to a running terminal, take-back while running, a lapse while running, each answered with no new event |
| R3.1 | §6.2, §8.3, §8.4, §9.1 | Solo-held items never claim, start or wake |
| R3.2 | §8.5 | AI-surface inventory and licence seam pins |
| R3.3 | §3.3, §9.2, §11.1 | A forged child id is refused on the channel route and cannot bind |
| R3.4 | §9.1 | Unmapped and no-header streams equal today's, live and on replay |
| R3.5 | §10.1, §11.3 | Route gate tests; the two register entries |
| R3.6 | §10.3, §5.3 | No session text and no forged "Tandem's Claude" in any refusal or badge |
| R3.7 | §6.8 | The amended pin; identical cursors across records |
| R4.1 | §5.2 | Reads default to the active tab; writes refuse rather than retarget |
| R4.2 | §5.3 | One test per `reason` |
| R4.3 | §8.1 | One announcement per transition; none from `status()` |
| R4.4 | §4.3 | Opening and default holding wake nobody |
| R4.5 | §6.3 | Handover of a quiet background document |
| R4.6 | §6.2 | More than 256 pending foreign items |
| R4.7 | §10.2 | Badge E2E |
| R4.8 | §9.3 | A direct-HTTP shim's reply is refused with the remedy; its stream equals today's |
| R5 | §13 | Measured |

## 17. PR sizing

Rough sizes include tests. "Changed tests" lists existing tests whose assertions change.

| PR | Files touched | Scope | Changed tests |
|---|---|---|---|
| **1a. Identity** | New `src/server/sessions/ownership.ts` (records, labels, kinds, `ownerByDoc`, `setDocOwner` with no enforcement, presence seam); new `src/server/ownership-flag.ts`; `src/server/sessions/context.ts`; `src/server/mcp/server.ts`; `src/server/mcp/transport-registry.ts`; `src/cli/mcp-stdio.ts`; `src/shared/cli-runtime.ts`; `src/shared/constants.ts`; `tsup.config.ts`; `scripts/ci/build-ownership-on.mjs`; `.github/workflows/ci.yml`; `docs/decisions.md` (ADR-054); `CLAUDE.md` (ships-dark entry) | Medium: about 10 source files, 900–1,300 lines | The licence-module seam pattern gains an ownership twin; nothing existing changes behaviour |
| **1b. #1952** *(conditional)* | `src/server/mcp/wake-url.ts`; `docs/security.md`; `CLAUDE.md`; `docs/decisions.md` (ADR-056 amendment) | Small: under 200 lines | `tests/docs/security-findings-claims.test.ts` |
| **1c. Enforcement** | New `src/server/sessions/doc-op-queue.ts`; `src/server/mcp/{document.ts, annotations.ts, list-edit.ts, docx-apply.ts, convert.ts, response.ts, output-schemas.ts}`; the lifecycle reply path (answered-once); `docs/mcp-tools.md` | Large: about 12 files, 1,800–2,500 lines, mostly queue wrapping and refusal tests | `tests/docs/tool-error-codes-claims.test.ts`; `mcp-output-schemas.test.ts`; the `NOT_OWNED` order tests from #2360 |
| **2. Inbox and replies** | `src/server/mcp/awareness.ts` (scope, chat acknowledgement, handled filter, reply acceptance, `ownership` field); `src/server/sessions/ownership.ts` (handover); `src/server/events/delivery-state.ts` (per-document rounds); `src/server/mcp/annotations.ts` (labels) | Large: about 6 files, 1,500–2,000 lines | `tests/server/inbox-cursor.test.ts` (the pin); delivery-state tests; `checkInbox` output-shape tests |
| **3. Launcher** | `src/server/launcher/supervisor.ts` (handle, bind check, presence announcer, take-back hook, start predicate at `:1410`/`:1432`, `startOrWake`, `requestWake`); `src/shared/launcher/contract.ts` (prompt builders); `src/server/sessions/ownership.ts` (presence consumer); stub child under `tests/` | Large: about 5 source files, 1,500–2,000 lines | Launcher prompt tests move from constants to builders (`supervisor`, `stream-json-protocol`, `supervisor-turn-delivery`); `tests/docs/ai-surface-inventory-claims.test.ts`; licence seam pins |
| **4. Push and shim identity** | `src/server/events/sse.ts`; `src/server/mcp/channel-routes.ts`; `src/shared/events/types.ts` (`ownership:changed`); shim and monitor parsers; `docs/security.md` (the header) | Medium: about 7 files, 800–1,200 lines | SSE and channel-route tests that assumed every stream gets every event (flag-on only) |
| **5. Controls** | New `src/server/mcp/routes/ownership.ts`; `src/server/mcp/api-routes.ts`; `src/shared/api-paths.ts`; new `src/client/tabs/TabOwnerBadge.svelte`; `DocumentTabs.svelte`; `tab-context-menu.ts`; `src-tauri/src/context_menu.rs`; testid snapshot and manifest; `docs/security.md` (two exposures) | Large: about 12 files, 1,300–1,800 lines incl. E2E | `license-gate-api-coverage.test.ts` (two rows); `testid-set.snap.txt` (add-only) |
| **6. Flip** | `src/shared/constants.ts`; `skills/tandem/SKILL.md` (version bump); `SERVER_INSTRUCTIONS`; docs; `CHANGELOG.md`; the release-smoke checklist | Small in code, large in docs | Dark pins removed; skill contract hash and version |
