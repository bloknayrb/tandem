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
| Inbox bookkeeping | A per-item delivered-to ledger replacing `surfacedIds` | Gone. #2330's cursor registry stays. Each document's registry scope carries a **tenure** that every ownership change advances, so the next owner is owed everything unhandled by construction (§6) | `inbox-cursor.ts` replaced what v4.1 was written against |
| Answered-once | Not specified for comments | One answerer per item; handled items are never handed to anyone (§5.5, §6.4) | R1.5, R1.2, decision 6 |
| Doc-less chat | D5: disable send on an empty tab | D5 dropped. Doc-less chat belongs to Tandem's Claude while present, else per message (§7) | Plan |
| Channel shim | §5.5-A: no identity | §5.5-B: its `X-Claude-Session-Id` selects a record; its stream narrows and its replies are checked (§9) | Decision 9 |
| Direct-HTTP terminal's shim | n/a | **Never linked**, measured (probe 4); keeps today's stream, replies refused with a remedy (§9.3) | R4.8 |
| Launcher | Handle per run; the child's record dies with it | The handle binds each run to the one **Tandem's Claude** record, which outlives runs; presence, take-back at spawn, widened starts, waking (§8) | Decisions 2, 7, 10, 11 |
| Dead terminal | ~32 min (idle reaper) | 2-minute grace after its `GET /mcp` stream closes (§3.4) | Probe 3 |
| `#1952` | Fixed per request | `peerIsLoopback` set in PR 1a and read by nothing; PR 1b is conditional on Bryan (§11.6) | #1952 is accepted and bounded by ADR-056 |
| Error code | `NOT_OWNER` | `NOT_DOC_OWNER` with a `reason` (§5.3) | R4.2 |
| Names on the badge | Nicknames (set by Bryan or the session), client name | Server-derived display kind, label and held-document names only; rename is not built (§10.3) | R3.6 |
| `tandem_open` activation | Re-open and claim do not activate | Today's behaviour: every `tandem_open` activates (§5.4) | No unlisted single-session change |
| Subagent hand-off (`issueHandle`), `ChatMessage.ownerLabel` | Built | Not built (§15) | No requirement needs them |
| Wake socket scoping (`?watch=`, socket pin) | Phase 3 | After the flip; Phase 3 starts from v4.1's text | Plan |

## 1. Summary

- Every open document has **at most one owner**. Only the owner is handed its items (inbox and push), and only the owner's answers and writes are accepted. Reads stay open. The server enforces this in the MCP tool layer and on `/api/channel-reply`; the rest of `/api` is Bryan's own surface (D4).
- **Tandem's Claude** is one owner record across all its child runs. While **present**, it holds every document no other session opened. A terminal answers only documents it opened or took with `tandem_open`, documents Bryan assigned to it, and documents it was handed while Tandem's Claude was not present.
- **Kinds** say what can move a document: a starting Tandem's Claude run takes back `claimed` documents; another session's `tandem_open` takes `default` and `claimed` ones; `opened` and `assigned` move only by Bryan's Release or Assign, or when their owner goes away.
- **The inbox stays on #2330's cursors.** A document held by someone else is not in the caller's scope. Every ownership change starts a new **tenure** of the document's inbox scope, so the next owner is owed every item that is not handled; answered items and delivered notices are never handed to anyone.
- **One answer per item.** The first record whose final answer is accepted is the item's answerer.
- **Starting and waking.** A present Tandem's Claude that is not running starts for asks on its own documents, even with a terminal attached, and for documents that come back to it with items waiting. A running owner that receives a document with items waiting is woken.
- **It ships dark** behind one build-time flag. Its tests run in the blocking `check` job; an advisory job runs everything else flag-on.

## 2. Terms

| Term | Meaning |
|---|---|
| **Owner record** | Server memory: `{ownerId, recordKind, label, transports, lastPollAt, losses}`. Lost on restart (decision 8). |
| **Record kind** | `tandem` (one per server run), `claude` (a transport carrying `X-Claude-Session-Id`), `bridge` (the stdio bridge without one), `http` (a direct-HTTP transport with neither), `stdio` (stdio transport mode). Server-derived. |
| **Display kind** | `Tandem's Claude` (only for `recordKind: "tandem"`), `terminal`, `Claude Desktop`, `other app`. Chosen by the server from a closed list (§10.3). |
| **Label** | A random per-run id such as `owner-k7qx`. Never derived from a session id or a handle. |
| **Ownership entry** | `ownerByDoc: Map<documentId, {ownerId, kind, since}>`. No entry means **unowned**. |
| **Kind** | `default`, `claimed`, `opened` or `assigned` (§4.1). |
| **Tenure** | A per-document counter advanced by every ownership change, including a close (§6.2). |
| **Present** | Tandem's Claude may hold documents (§8.1). |
| **Default rule** | Where a document goes when nobody in particular should have it: Tandem's Claude as `default` if present, otherwise unowned. |
| **Handed** | Returned to a reader by `tandem_checkInbox`, or written to a consumer's push stream. |
| **Handled** | Answered by a final (not `inProgress`) reply, judged from persisted state; for notices, handed to their owner (§6.4). |
| **Waiting** | An item on a document that is not handled and that passes the Solo hold, `hideFromAI` and the ADR-027 and withheld predicates (§8.5). |
| **Lapsed** | A record whose documents went back to the default rule because its client went away (§3.4). |
| **Handle** | `th_` plus 32 base64url characters, minted per Tandem's Claude child spawn, named in that run's supervisor prompts (§3.3). |

## 3. Identity

### 3.1 Records from transports

**Problem.** Ownership needs to know who is calling. Direct-HTTP Claude Code sends no per-session header (probes 3 and 4, §13), the stdio bridge forwards one (`src/cli/mcp-stdio.ts:438`), Claude Desktop sends neither, and stdio mode has no transport registry.

**Rule.** Each transport resolves to one record at `initialize`:

1. `X-Claude-Session-Id` present → `claude:<id>`. Several transports may share it (bridge reconnects and respawns). **Exception:** an id equal to Tandem's Claude's saved session id gets a private record per transport, never shared; and at each spawn, any shared `claude:` record already holding that id is demoted (its transports re-pointed to private records, its documents to the default rule). So nothing can pre-create or join the child's record.
2. Else `X-Tandem-Client-Id` present → `bridge:<id>`. A new header, minted once per bridge process and reused by its reconnects. The bridge sends it unconditionally: `src/cli/mcp-stdio.ts` is in the define-less stdio-bridge bundle and never reads the flag; a dark server ignores the header.
3. Else → `http:<Mcp-Session-Id>`.
4. Stdio transport mode → one process-wide `stdio` record.

**The caller is explicit.** Handlers resolve the caller once at entry, from the request context (`runWithMcpContext` at `src/server/mcp/server.ts:875` and `:930`), and pass its `ownerId` explicitly into everything after: the operation queue (§5.1), `setDocOwner`, answered-once, the greeting classifier. Nothing reads the ambient context inside a queued body. In stdio mode a missing context means the `stdio` record. In HTTP mode a missing context is a **deny-all** caller that holds nothing and can claim nothing. Server-internal work that must bypass ownership (the reload family, startup restore, the local-model collaborator's in-process writes) runs inside an explicit `runAsInternal()` wrapper. `/api/channel-reply` has no MCP context: it maps its own caller (§9.2) and passes it explicitly.

**Mechanism.** The registry entry already stores `claudeSessionId` and `clientName` (`McpSessionEntry`, `src/server/mcp/transport-registry.ts:54-84`), filled in at `onsessioninitialized` (`server.ts:550`). PR 1a adds `ownerId` to the entry and to `McpRequestContext` (`src/server/sessions/context.ts:37-59`), set in `dispatchToSession` (`server.ts:858`) and on the initialize path (`server.ts:930`). It also adds `peerIsLoopback`, from `req.socket.remoteAddress` through `isLoopback`; nothing reads it unless PR 1b lands (§11.6).

**Two Tandem toolsets in one Claude Code session.** The plugin bundles a bridge `tandem` entry and the shim (`.claude-plugin/plugin.json`), and `tandem setup` writes a user-level direct-HTTP entry (`src/server/integrations/apply.ts:514`). A terminal with both loads the toolset twice (the doctor already warns, `src/cli/doctor.ts:2136-2138`) and is **two records**, `claude:<id>` and `http:<sid>`, which nothing can link (probe 4). The consequence is concrete: if the model opens a document through one toolset and replies through the other, it is refused as if the document were another session's, and the plugin's shim and monitor, mapped to `claude:<id>`, are not pushed the `http:` record's documents. This is open for Bryan (§14).

### 3.2 The Tandem's Claude record

**Problem.** Tandem's Claude is a sequence of child processes (spawn, idle-stop, resume, crash-resume, relaunch), each with its own transports. Decisions 2, 7 and 11 need one identity that outlives them.

**Rule.** The ownership module creates one record `tandem` at boot. It holds documents only while present (§8.1); while not present it holds nothing, and its calls on unowned documents neither claim nor are handed items (§4.2). Its transports are those bound with the current spawn's handle. Its label is fixed for the server run, and its display kind is always `Tandem's Claude`.

### 3.3 Binding a child run

**Problem.** The child's setup entry is direct-HTTP, so its transport carries no header (probe 3). What reaches the child on every turn is the supervisor's stdin prompt.

**Rule.**
- Each spawn mints a handle. Three builders **wrap** `SUPERVISOR_INITIAL_PROMPT`, `SUPERVISOR_GREETING_PROMPT` and `SUPERVISOR_WAKE_PROMPT` (`src/shared/launcher/contract.ts:741`, `:760`, `:819`; the constants stay, and are what the builders return while dark), prefixing: *"Your Tandem owner handle for this run is `th_…`. Pass it as `ownerHandle` on your first Tandem call in this turn, on each Tandem server you use."* The no-unasked-work clause stays.
- `ownerHandle` is an optional argument on four entry tools: `tandem_status`, `tandem_open`, `tandem_scratchpad`, `tandem_checkInbox`.
- **Bind check.** The handle is the current spawn's, and the presenting transport carries no `X-Claude-Session-Id` or carries the current run's id (`currentSessionId`, `src/server/launcher/supervisor.ts:1998`; probe 1 shows a resumed child keeps it). Any number of such transports may bind: a child with two toolsets binds each.
- **Outcomes.** The current handle on a transport already bound to it: a no-op success (every turn repeats the handle). A fresh transport: re-pointed to `tandem`; if its prior record is a never-bound single-transport record that already holds documents (the child opened something before binding), those move to `tandem` (v4.1 §5.10's absorb) — as `default` if present, else to the default rule. A prior record that holds documents and is anything else, or a transport with a document operation in flight → `OWNER_HANDLE_CONFLICT`, no side effects. An unknown, stale or malformed handle → `INVALID_OWNER_HANDLE`, no side effects; the message never echoes the value.
- **Every bind is logged** with the transport's kind and whether it carried a header, and Settings shows how many transports are bound to Tandem's Claude.
- **Teardown.** When the run ends (`teardownTurnDelivery`, `supervisor.ts:2275`), the handle dies and every transport bound with it is re-pointed to a fresh empty `http` record. The `tandem` record keeps its documents: presence, not the run, decides what it holds.
- **An unbound child.** Every refusal whose holder is Tandem's Claude ends with: *"If you are Tandem's Claude, call `tandem_checkInbox` with your `ownerHandle` through this same server and retry."*

**If a later Claude Code build differs (probe 1).** If a resumed child got a new `CLAUDE_CODE_SESSION_ID`, the header half of the bind check would refuse a resumed bridge-entry child. The fallback is to accept any header on a handle bind.

### 3.4 When a client goes away

**Problem.** A dead terminal's documents should come back promptly, but a live client must not lose them to a blip.

**Rule.** A non-`tandem` record is **attached** while one of its transports is registered and, if any of its transports has ever held a `GET /mcp` stream, one such stream is open. When it stops being attached a 2-minute grace starts (v4.1 §5.8). A reopened stream, a new transport for the record, or any request on one of its transports ends the grace. At expiry the record **lapses**: each of its documents goes to the default rule through `setDocOwner` (§4.3), and its chat follows (§7.2). A lapsed record whose transport is still registered keeps its label and holds nothing; it may claim again like anyone (a lapse records no blocking loss, §5.3).

**Mechanism.** The registry counts open streams per entry (`openStreams`, `transport-registry.ts:83`) and fires `onEvicted` on `lru | idle | explicit` closes (`:100`). The ownership module listens to both.

**Bounds** (probe 3): a Claude Code terminal that exits or crashes closes its stream with the process, so its documents return about 2 minutes later. A client that never holds a stream is noticed only by the idle reaper: 30 minutes of idleness (`transport-registry.ts:290`), the 5-minute reap interval, then the grace — about 37 minutes. The stale-owner hint (§10.2) shows the gap and Assign closes it. An `http` record is its `Mcp-Session-Id`: a direct-HTTP terminal evicted by the 16-session cap, which any local process can force, re-initializes as a new record and its old one lapses (§15).

**If a later build differs (probe 3).** Without a held stream, Claude Code terminals fall into the reaper bound. Nothing else changes.

### 3.5 Stateless clients (MCP `2026-07-28`)

In probes 3 and 4, Claude Code sent `server/discover` (protocol `2026-07-28`) before `initialize`: it tries the stateless era first and falls back. Tandem serves only the legacy branch (ADR-045 amendment), so every caller still gets a transport. Ownership keys on the **record**; only rule 3 derives one from `Mcp-Session-Id`, as CLAUDE.md permits on the legacy branch. When Tandem adds the stateless branch, that work must give a stateless caller a record, or it holds nothing (§15).

## 4. Ownership

### 4.1 Kinds

| Kind | Holder | How it arises | A starting Tandem's Claude run | Another session's `tandem_open` |
|---|---|---|---|---|
| `default` | Tandem's Claude only | The default rule while present: Bryan's opens, restores, `welcome.md`, his scratchpads; documents Tandem's Claude opens or writes while present; take-back; documents returning to it | (its own) | takes it → `opened` |
| `claimed` | A non-`tandem` record | It was handed the document's work, or wrote to it, while the document was unowned | takes it back → `default` | takes it → `opened` (its holder too) |
| `opened` | A non-`tandem` record | Its `tandem_open` of a closed file, or its take of an unowned, `default` or `claimed` document | not taken | refused |
| `assigned` | Any record | Bryan's Assign | not taken | refused |

### 4.2 Transitions

| Event | Result |
|---|---|
| Bryan opens a document (`POST /api/open`, upload, file association, startup restore, `welcome.md`, a scratchpad he creates) | Default rule |
| Tandem's Claude's `tandem_open` or `tandem_scratchpad` | While present: `default`, refused on an `opened` or `assigned` document held by another record. While not present: default rule (unowned) |
| Another session's `tandem_open` of a closed file, or `tandem_scratchpad` | `opened` by it |
| Another session's `tandem_open` of an open document | Unowned, `default` or `claimed` → `opened` by it; `opened` or `assigned` held by someone else → refused; its own `opened` or `assigned` → unchanged |
| A write, or an inbox poll that hands items, on an unowned document | Claimed: `default` for a present Tandem's Claude, `claimed` for anyone else. Nobody claims while it holds a blocking loss record for that document (§5.3), and a Tandem's Claude that is not present never claims: its writes there are refused (`NOT_DOC_OWNER`, `reason: "not-present"`) and its polls read nothing |
| A Tandem's Claude run **starts** (§8.2) | Every unowned and every `claimed` document → `default` |
| Tandem's Claude becomes present without a start (Off→On, Configure) | Nothing moves |
| Tandem's Claude stops being present | Every document it holds (`default` or `assigned`) → unowned, and its doc-less chat follows (§7.2) |
| A record lapses (§3.4) | Each of its documents → default rule |
| Release | Default rule |
| Assign to record R | `assigned` to R |
| Bryan closes the tab | The entry is removed and the tenure advances; unanswered chat on it keeps that owner (§7.2) |
| Server restart | Everything is forgotten; Tandem's Claude is not present until its first start this run (decision 11), so restored documents start unowned |

A read, list-mode `tandem_restoreBackup` and `tandem_exportAnnotations` never claim (v4.1 §3.7).

### 4.3 One composite for every change

Every change goes through `setDocOwner(documentId, next | null, kind, cause, caller)`, run at its turn in the document's operation queue (§5.1), or synchronously at the close point. In order:

1. update `ownerByDoc` and **advance the document's tenure** (§6.2);
2. if the previous owner was a different record, run the chat half of the handover (§6.3) and record the loss on that record (§5.3);
3. queue a change notice for both records, drained by their next poll (§6.6);
4. publish through `broadcastOpenDocs` (`src/server/documents/registry.ts:162`), never an ad-hoc broadcast;
5. **wake or start.** If the new owner has waiting items on the document, call the supervisor's `startOrWake` seam (§8.4) for Tandem's Claude, or send the `ownership` frames (§8.6) for any other record — **except** when `caller` is the new owner (its own poll, write or take) or the cause is take-back (§8.2). If the document became unowned with items waiting, send the unscoped `ownership` frame so an attached terminal can pick it up. Holding with nothing waiting wakes nobody (R4.4). Until PR 3b, `startOrWake` is a no-op stub.

**Lock order.** `setDocOwner` never awaits the supervisor's operation lock: `startOrWake` is fire-and-forget (§8.4). The supervisor never awaits a document queue: take-back and the presence-loss sweep enqueue their `setDocOwner` calls and return. So the two locks have no wait cycle.

## 5. Enforcement

### 5.1 The operation queue and refusal placement

v4.1 §3.4a is kept: every MCP mutation and every ownership change on a document runs through a per-document serial queue, and the ownership check is the first thing inside the operation. The caller's `ownerId` is resolved before the operation is enqueued and passed in (§3.1); a test interleaves two records' operations on one document to pin it. Refusals decided by the arguments or by facts fixed at open (`LICENSE_REQUIRED`, `NO_DOCUMENT`, `DOCUMENT_REQUIRED`, `INVALID_ARGUMENT`, `INVALID_PATH`, `READ_ONLY`, extension-decided `FORMAT_ERROR`, handle errors) run before the queue and never claim. Refusals decided by live content, the disk or the save lock (`INVALID_RANGE`, `RANGE_MOVED`, `SAVE_IN_PROGRESS`, `EXTERNAL_CONFLICT`, serializer `FORMAT_ERROR`, I/O) run inside and keep the claim. Browser edits and the reload family stay outside the queue. PR 1c re-derives v4.1's line numbers, which are stale.

On a document held by someone else, `NOT_DOC_OWNER` is answered before any lifecycle refusal, including #2360's `NOT_OWNED`. Whichever of PR 1c and #2360's lifecycle change lands second rebases through the lifecycle's refusal order.

### 5.2 Which document a call means (R4.1)

**Problem.** Retiring the active-tab default would break single-document scripts, and retargeting a range-keyed write to a document other than the one just read would apply its offsets to the wrong text.

**Rule.**
- **Reads** keep today's active-tab default (`getCurrentDoc`, `registry.ts:348`).
- **Range-keyed writes** without `documentId` target the active document, as today. If the caller does not hold it and cannot claim it → `NOT_DOC_OWNER`. They never retarget.
- **Replies** follow §7.3: a `replyTo` reply goes to the message's own scope; a reply without one is a **post**, stamped with `documentId` if given, else the active document as today. A post never claims.
- **The four id-keyed annotation tools** resolve the document by annotation id first (#2187), then check ownership (R2.2).
- `DOCUMENT_REQUIRED`, where a call cannot resolve a document at all, carries the caller's held document ids and the remedy "pass `documentId`".
- **Write-mode `tandem_status`** (`text`, `focusParagraph`): the status text is global, as today. A `focusParagraph` on a document the caller does not hold is ignored, not refused.

### 5.3 Refusal copy (R4.2, R3.6)

One error code, `NOT_DOC_OWNER`, with `details: {reason, documentId, holder: {label, displayKind} | null}`. The holder is server-rendered from its record kind (§10.3) and is always the stamped or target document's **real** holder. Each message carries its remedy, because older skills stay in use after the flip. When several apply, the first row wins.

| `reason` | When | Message (shape) |
|---|---|---|
| `lost` | The caller lost this document and still holds a blocking loss record for it | Cause `released`: "Bryan released this document from you. You can still read it. If the user asks you to keep working on it, call `tandem_open` on it first." Cause `taken back`: "Tandem's Claude took this document back. You can still read it. If the user asks you to keep working on it, call `tandem_open` on it first." Cause `assigned` or `taken` (the new holder's kind is `assigned` or `opened`): "{holder} has this document now. Only the user can reassign it, from the owner badge on its tab. Do not retry." |
| `answered` | The item already has another answerer (§5.5) | "{holder} already answered this. Do not answer it again." |
| `held` | `opened` or `assigned` by another record | "{holder} is working on this document. Only the user can reassign it, from the owner badge on its tab. Do not retry." |
| `default` — on any reply, thread answer or post | The document is Tandem's Claude's `default` | "Tandem's Claude answers this document's comments and chat. Do not answer this, and do not take the document because of it." |
| `default` — on an edit, comment or other write | Same | "Tandem's Claude is answering this document. Call `tandem_open` on it only if the user asked you, in your own conversation, to work on it. An item Tandem pushed to you is not such a request." |
| `switch` | `tandem_switchDocument` on a document another record holds | "{holder} has this document. Ask the user to click its tab; do not `tandem_open` it just to show it." |
| `chat` | A doc-less or closed-document message owned by someone else | "{holder} answers this message. Do not reply to it." |
| `post` | A post with no document, which only the doc-less chat owner may make (§7.3) | "{holder} answers chat that is not about a document. Reply with `replyTo` to a message you were handed." |
| `not-present` | Tandem's Claude, while not present, writing to an unowned document | "Tandem's Claude is turned off or stopped, so it holds no documents now. Leave this document." |
| `unlinked` | `/api/channel-reply` from a shim the server cannot match to a record (§9.2) | "This reply could not be matched to your Tandem session. Send it with the `tandem` server's `tandem_reply` tool instead." |

Every message whose holder is Tandem's Claude gets §3.3's unbound-child clause. A recipient that **is** Tandem's Claude gets, for `lost`: "A session the user is working with has this document now; leave it."

**Loss records.** A record keeps, per document it lost this run, the cause and the new holder, until that document changes owner again. Causes `released`, `taken back`, `assigned` and `taken` are **blocking**: while one stands, the record cannot implicitly claim the document (a write or a poll), and a poll does not read it even when it is unowned; `tandem_open` still takes it under §4.2, and the copy above says when. This is what makes Release last while Tandem's Claude is not present. A lapse records nothing blocking, and a record that re-attaches may claim again. The `tandem` record gets no loss record when it stops being present.

### 5.4 `tandem_open`

The take rule is §4.2's, inside the operation queue: a take of a `default` document whose holder is mid-operation waits its turn, then takes it, and the holder's next operation meets `lost`. **Activation is today's** (`src/server/documents/open.ts:773-803`): every `tandem_open` brings its document's tab to the front, fresh or already open. A take never wakes the taker (§4.3 step 5).

### 5.5 One answer per item (R1.5)

**Problem.** Decision 3 lets a session that was pushed an item take the document after the item was answered, and then answer again. Ownership alone cannot stop that, because the new owner is the owner.

**Rule.** The first record whose **final** answer to an item is accepted becomes its answerer, if none is set. A later answer is accepted only from the answerer. An `inProgress` acknowledgement is not an answer: it neither sets the answerer nor makes the item handled, and the same record's final reply that follows is accepted.

**Mechanism.** An in-memory `answerer: Map<itemKey, ownerId>` in the ownership module, written only if unset:
- **Comments and thread replies.** The item is the thread's latest user entry (the comment at its current `editedAt`, or the latest user reply). A final Claude reply on the thread (`tandem_annotationReply`, or #2360's thread reply) by X sets the answerer to X. A reply by Y ≠ X while the latest user entry is answered by X → `NOT_DOC_OWNER`, `reason: "answered"`. A new user reply or an edit makes a new item.
- **Chat.** The item is the message named by `replyTo`. Today's batch rule (`answeredBy`, `src/server/mcp/awareness.ts:1554`) also settles earlier messages some model received. Under the flag the server computes that expansion **once, when the reply is accepted**, over messages in the replier's scope only, and writes the settled ids onto the reply row (`settles: [messageId]`, server-stamped with `withMcp`). Each settled message takes the replier as answerer if unset. The handled filter reads `replyTo` plus `settles` from persisted rows (§6.4), so it never re-derives scope from state it cannot see. A message settled in persisted state with no recorded answerer exists only after a restart; its current owner's reply is then accepted (decision 8).
- **A post** (no `replyTo`) answers nothing, so this rule cannot see it (§15).

### 5.6 `tandem_switchDocument`

It brings a document's tab to the front and never claims. Under the flag it is owner-only where an owner exists: refused on a document another record holds, with the `switch` copy, which tells the model to ask the user rather than take the document. On an unowned document, and on the caller's own, it works as today.

### 5.7 Reads and labels

Reads are open. `tandem_getAnnotations` and `tandem_listDocuments` label each document with `owner: {label, displayKind, kind, you}` (or `null`). `tandem_status` returns the caller's own label, display kind and held document ids, so Bryan can ask a session which one it is.

## 6. The inbox under cursors

### 6.1 What the inbox is today

`tandem_checkInbox` keeps no per-reader state. One process-wide registry gives every returned item version a sequence number the first time any poll returns it (`src/server/mcp/inbox-cursor.ts:10-12`); each reader's position is a mark per scope inside the opaque cursor it passes back (`inbox-cursor.ts:22-31`). A fresh reader counts as seen whatever some reader acknowledged (`seenBy`, `inbox-cursor.ts:107-110`). Default polls read every open document (`collectInboxDocuments`, `awareness.ts:1152`) and skip quiet background documents (`awareness.ts:1227-1237`). Chat is one scope read on every poll, and a message answered by a `replyTo` reply is skipped for every reader (`awareness.ts:1621`). Cursor-less (legacy) polls keep the process-wide `surfacedIds` / `replySurfacedIds` ledgers (`legacyLedgers`, `awareness.ts:861`).

### 6.2 Tenures: why every change re-owes

**Problem.** A reader's mark, and the fresh-reader floor, both say "seen" about items that a later owner was never handed: the old owner acknowledged them, or the new owner's mark passed them while the document was someone else's. Re-owing them item by item at each handover has to cover every way an item can be passed over, including items that stop and start qualifying (a resolve and its Undo).

**Rule.** Under the flag a document's inbox scope is `documentId` plus its **tenure**, a counter that every ownership change advances, and so does a close. Registry entries, cursor positions, the quiet-skip record and the legacy ledgers' keys are all per tenure. A new tenure is a scope no reader has a position in and no entry exists for: every item that qualifies in it gets a fresh sequence number above every mark and is unacknowledged, so the next owner is owed it with any cursor, fresh or old. Nothing has to be retired item by item. Two filters then decide what is actually handed (§6.4): handled items are never handed, and notices already handed to an owner are never handed again.

**Mechanism.**
- The scope string becomes `documentId` plus a separator and the tenure. It is never `CTRL_ROOM` and never the chat scope, so the cursor decoder's checks (`inbox-cursor.ts:466`) hold. A tenure number is not owner data (R3.7).
- The quiet-skip state (`quietDocState`, `awareness.ts:809`) is keyed per tenure, so no reader skips a document on a record from an earlier tenure (R4.5).
- The legacy ledgers key on the tenure scope, so a cursor-less next owner is owed what it was not handed.
- Old tenures' entries are never read again. They are dropped when their document closes, so the registry still grows only as today's does.

### 6.3 Scope, acknowledgement and claims (R1.1, R4.6)

**Rule.** A poll by record X reads:
- documents X holds;
- unowned documents, claiming each one that yields items, unless X holds a blocking loss record for it (§5.3) or X is a Tandem's Claude that is not present;
- chat messages whose owner (§7.1) is X, or which are claimable by X.

Anything else is **not read**: it is left out of `collectInboxDocuments`'s order and out of the chat pass. This is exclusion, not an `admit` refusal, so nothing is logged as dropped and no "malformed" text appears. A named poll of such a document returns no items and lists it in `ownership.notYours`.

**The cursor treats an excluded document as read with nothing handed:** its mark moves to the counter with no held seqs, so excluded documents are never listed in the cursor (R4.6). Tenures make this safe: whatever the mark passed belongs to a tenure the reader can only meet again after a change of owner, which starts a new one.

**Acknowledgement is scoped.** `acknowledgeCursor` (`awareness.ts:1674`) acknowledges entries for the fresh-reader floor and stamps chat `read`. Under the flag it does both only for documents and messages in the caller's scope at that poll, so a reader's mark passing another owner's entries never hides them from a fresh reader of the same tenure, and never stamps another owner's chat read. The handler reads the caller's record to choose scope; nothing is written into the cursor (R3.7).

**Claims are decided during collection.** The handler is synchronous from acknowledgement to commit (`awareness.ts:1852-1866`). For an unowned document, or an unowned document's chat message, that would yield items, the pass decides the claim before registering anything: it computes the next tenure and registers the items under it. The claim itself (`setDocOwner`) is applied at commit, after the response validates, in the same synchronous tick; if validation fails, nothing is claimed and the entries registered under the unused tenure are never read. A chat message on an unowned open document claims its document the same way.

**Cost (R4.6).** An excluded document costs no collection and no cursor space, and foreign items never enter a reader's held lists. 300 pending items, or 300 open documents, held by another owner add nothing to a reader's cursor and nothing to its work beyond enumerating open documents.

### 6.4 The handled filter

**Rule.** Under the flag, on cursor and legacy polls alike, these are never handed to anyone (the legacy chat path, `collectUnreadChat` at `awareness.ts:1471`, gains the check it lacks today):
- a user comment at a given `editedAt` with a later **final** Claude reply on its thread;
- a user thread reply with a later final Claude reply on the thread;
- a chat message named by a final reply's `replyTo` or listed in its `settles` (§5.5); `inProgress` rows and `superseded` rows (§6.5) count for nothing;
- an accept or dismiss notice already handed to its document's owner (below).

The first three judge from persisted state, so they cover an answer given from a **push** before any poll registered the item (R1.2), and they hold across a restart.

**Notices (R2.6).** Accept and dismiss notices need no answer, so they count as handled once handed to the owner of their document: by that owner's poll, or written to a stream mapped to that owner's `claude:` record (§9.1). An in-memory set records each handed notice version. A notice no owner was ever handed goes to whoever owns its document next. After a restart the set is empty, so an old notice can be handed once more (decision 8).

For a single session nothing visible changes: a reader that was handed an item already has it, and an edit or a new user reply makes a new item.

### 6.5 The chat half of a handover

**Problem.** Chat is one global scope, so tenures do not cover it, and a message with no registry entry is owed only while unread (`awareness.ts:1622-1627`).

**Rule.** When a message's owner changes (its document changes owner, or its per-message owner lapses or stops being present, §7.2) and the message is not handled:
1. retire its chat entry (`retire`, `inbox-cursor.ts:308`);
2. set `read: false` and `delivered: false` on it, and set `superseded: true` on the old owner's `inProgress` row for it if one exists — all in one `withInternal` transaction on `Y_MAP_CHAT` (Critical Rule 2; the chat observer emits `chat:message` only for browser-origin writes, so no event fires).

`superseded` is a new field. The handled filter ignores a superseded row, and the editor's pickup row (`src/client` chat pickup) reads it as "no longer working". Clearing `delivered` is honest — the new owner has not picked the message up — at a known cost: the pickup clock counts from the message's own timestamp, so the stall banner can show at once for an old message, until the new owner, which §4.3 step 5 has just started or woken, picks it up.

### 6.6 What the response says about ownership

`tandem_checkInbox` gains `ownership: {holding: [documentId], notYours: [documentId], changed: [{documentId, change: "gained" | "lost", cause}]}`. `holding` is computed per poll; `changed` drains the record's change notices (§4.3 step 3). Loss records (§5.3) are separate and outlive the drain. Nothing here is read from or written into the cursor.

### 6.7 Delivery rounds

`pendingSince` (`src/server/events/delivery-state.ts:86`) is one global round, closed by any poll; under ownership a terminal's poll would close a round Tandem's Claude has not seen. Under the flag rounds are keyed by document for document items and by message for chat. A poll closes the rounds of the documents it read and of the messages it handed out or that are now handled. `/health` keeps reporting one aggregate (the oldest open round's age), never a document id or a per-document breakdown, so it reveals nothing beyond today.

### 6.8 The cursor pin (R3.7)

`tests/server/inbox-cursor.test.ts:1060-1078` pins that the cursor module and the inbox handler import no transport or session identity. It is amended to: `inbox-cursor.ts` imports nothing from the ownership module; the inbox handler may import the caller resolution and the scope predicate from it and nothing else; and a new test shows that two records with the same position and the same holdings receive byte-identical cursors.

## 7. Chat ownership and replies

### 7.1 Who owns a message (R1.4)

| Message | Owner |
|---|---|
| Has a per-message owner (§7.2) | That owner, even if its document is open again |
| On an open document D, no per-message owner | D's owner; if D is unowned, claimable with D (§6.3) |
| Doc-less, or on a closed document, no per-message owner | Tandem's Claude while present; else claimable |

A claimable message gets an owner when a poll hands it (its document's claim if it has an open one, else a per-message owner, applied at commit) or when a record's answer to it is accepted, whichever comes first. So at any moment exactly one record may answer it, or none is set and the first accepted answer sets it. A per-message owner keeps its message when Tandem's Claude becomes present (the plan's call).

### 7.2 Successors (R2.3)

- When Bryan closes D, each unanswered chat message on D takes D's owner at that moment as its per-message owner (nothing, if D was unowned). Its chat entries are untouched: its owner is the same.
- When a per-message owner lapses, each of its unanswered messages loses that owner and follows the table again, with the chat half of the handover (§6.5).
- When Tandem's Claude stops being present, every unanswered doc-less or closed-document message it owned — by a per-message owner or by being present — follows the table again, with §6.5.

A document's change of owner moves only the chat that follows that document, never the old owner's doc-less chat.

### 7.3 Reply acceptance (R2.2)

`tandem_reply({text, replyTo?, documentId?, inProgress?})`:
1. **With `replyTo`.** The message's owner decides (§7.1). A claimable message is claimed by the accepted reply. Then §5.5's answered-once check. An explicit `documentId` that contradicts the message's → `INVALID_ARGUMENT`.
2. **Without `replyTo`, a post.** Stamped with `documentId`, else the active document, as today. On a stamped document, accepted when the caller holds it, or when it is unowned and the caller may claim it (a post still never claims); otherwise refused with the document holder's `default` or `held` copy. With no document, accepted from the doc-less chat owner (Tandem's Claude while present; any record while it is not present); otherwise `post`.

**The first-run greeting** (#2193) is Tandem's Claude's post, accepted under rule 2. The greeting classifier (`isGreetingReply`, and the supervisor's own-child checks at `supervisor.ts:1270` and `:1310`) keys today on the reply's session header and treats a reply with no header as possibly the child's. Under the flag it keys on the caller's record kind being `tandem`, on the MCP path only; a `/api/channel-reply` reply is never the greeting. This moves in PR 3a with the bind, so the classification and the bind land together.

## 8. Tandem's Claude: presence, take-back, starting, waking

### 8.1 Presence (R4.3, decision 11)

**Rule.** Tandem's Claude is present when all of these hold, read from the supervisor's own fields:
- `startedThisRun`: a spawn has reached the post-spawn point this server run (`supervisor.ts:1985-1998`);
- `configured === true` (a tri-state today);
- its in-memory `standby` is not `"off"` (`supervisor.ts:1069`) — the supervisor's live state, not the saved `lastGoodSettings.startMode`, which can disagree when saving Off fails;
- `breakerTripped` is false;
- `lastError` is unset, or a restart is underway: `restartTimer` is set or `launching > 0`. Today's `lastError` values are `needs-login`, `unlicensed`, `cli-unusable`, `binary-not-found`, `spawn-failed`, `stop-failed`, `circuit-open` and `wake-delivery-failed`; any of them with no restart underway is staying down. A new value counts as staying down; an exhaustive-switch test makes adding one a decision.

It keeps its documents through idle-stop, resume, crash-resume and relaunch (decision 7).

**Announcer.** These fields are written in about thirty places, some outside the operation lock (the exit handler, the stream parser's sign-in trip, restart scheduling), and several transitions write two of them in sequence (an error, then `scheduleRestart`). PR 3b routes every write through setters that mark presence dirty; presence is recomputed once, after the current synchronous run of writes (a queued microtask). A change to **present** is announced at once. A change to **not present** is announced only if it still holds 5 seconds later, so a crash-resume that briefly reads as down never sweeps documents away. The ownership module reads only the last announced value. `status()` is not a transition: its `cli-unusable` lapse (`supervisor.ts:3412-3418`) clears the error without recomputing, and presence follows at the next transition.

### 8.2 Take-back (decision 2)

**Rule.** A run **starts** at the post-spawn point — where `startedThisRun` is set — **before** the spawn decides which turn to write (`supervisor.ts:2365-2400`). Take-back runs there: every unowned and every `claimed` document becomes `default`, each through `setDocOwner`. `opened` and `assigned` documents stay. Take-back is never itself a start trigger: it happens because a run started. A spawn that dies on arrival has started a run all the same; the next spawn's take-back finds nothing left to take.

**Its wake.** Take-back computes waiting synchronously, before it enqueues its `setDocOwner` calls. If any taken-back document has items waiting it sets `wakeOwedAcrossSpawns`, which the **same** spawn then consumes when it decides its turn: a fresh spawn's bootstrap turn covers it (`:2386`), and a resumed spawn sends its wake (`:2395-2399`). Take-back never calls `requestWake`.

**Sign-in loops.** A child that is not signed in still reaches the post-spawn point, so each Check again starts a run that takes back `claimed` documents, then trips `needs-login`, and 5 seconds later the presence-loss sweep returns them to unowned. That churn is bounded by Bryan's clicks (§15).

A run started by a chat while Off follows the 2026-10-13 behaviour (the mode becomes on-click; `tests/server/launcher/supervisor-turn-delivery.test.ts:1978`) and is a run start like any other.

### 8.3 Start rules (R2.4, decision 10)

**Rule.** A present Tandem's Claude that is not running starts, whether or not another AI is on, for:
- on a document it holds: a user chat message, a new user comment (`annotation:created` of a user comment, with or without a suggestion), or any user thread reply;
- a doc-less or closed-document chat message it owns.

An event on a document held by another attached record starts nothing. Everything else is today's rule: `isStartWorthy` (`src/shared/events/wake-scope.ts:57`) and "not if another AI is on", including for a document whose holder is in its grace; such a start takes back that document if it is `claimed`.

**Leaving Solo.** The Solo→Tandem release wake carries no document. When it fires, the supervisor asks the ownership module whether any document Tandem's Claude holds has items waiting, and if so starts it as above.

**Mechanism.** The standby watch callback (`supervisor.ts:1410`) asks the ownership module `startWorthyFor(event)` → `{start, ignoreOtherAi}`. A burst of events coalesces into one queued start (`messageStartQueued`, `:1414`), so `ignoreOtherAi` is OR-ed into supervisor state by each event the watch accepts; `startForMessage`'s re-check under the lock (`:1432`) reads it and clears it on every path, and its `finally` re-queues a start if the bit was set again meanwhile. The watch subscribes through `wasForwardedExternally` (`supervisor.ts:321`), so the Solo hold, `hideFromAI` and the licence refusal run before it sees an event (R3.1). `startsOnMessage` in `status()` keeps today's document-free value; the composer line (§10.2) is what promises a start for a specific document.

### 8.4 Starting or waking for a returning document

**Rule.** When a document reaches Tandem's Claude with items **waiting** — by Assign, Release, or a lapsed holder — it is woken if running, and otherwise started if present, whether or not another AI is on. Off→On moves nothing and starts nothing.

**Mechanism.** `setDocOwner` step 5 calls `startOrWake(cause)`, a fire-and-forget seam. It records the "ignore other AI" bit and the owed wake synchronously, sets the queued-start flag so the status reads Starting, and queues one locked step. Under the lock that step decides: a running child with turn delivery → `requestWake()` (§8.6); otherwise the same start `startForMessage` makes. Deciding under the lock means a start already launching cannot miss the document: the step runs after it and wakes the new child.

### 8.5 Waiting

**Waiting** is computed by the inbox's own document collector with no cursor, after every privacy gate (the Solo hold, `hideFromAI`, the ADR-027 and withheld predicates; R3.1), counting items that pass the handled filter (§6.4) and unanswered chat the record owns. A Solo-held item is never waiting.

### 8.6 Waking a running owner (R2.7)

**Rule.** When a document reaches a running owner with items waiting (a lapsed holder's documents, Assign, Release), that owner is woken. Holding with nothing waiting wakes nobody (R4.4).

**Mechanism.**
- **Tandem's Claude:** `requestWake()`, exposed by the current spawn's turn delivery, writes the wake prompt through the same coalescing as `onTandemEvent` (`supervisor.ts:2246`). It passes `aiRefusal()` first (R3.2).
- **Other records:** a payload-free `ownership` frame on `/api/wake`, and a payload-free `ownership-changed` event on a mapped push stream (§9.1). Before Phase 3 a wake socket is unscoped, so every armed session gets the frame, polls, and finds nothing unless it is the new owner.
- **Licence.** Neither frame enters `pushEvent`, so neither inherits its revocation. Each writer calls `aiRefusal()` before writing and, on a refusal, ends the socket (4403) or the stream exactly as the revocation does.
- **The inventory.** `tests/docs/ai-surface-inventory-claims.test.ts` gains derivations over these two writers and over every `sendTurn` caller, so a new path that skips the check fails the test (R3.2).
- Pull is the backstop: the change is in the next poll's `ownership.changed`.

### 8.7 A run that never binds (R2.5)

A child that never presents its handle runs as an ordinary `http` record. Its documents stay with the `tandem` record, so the inbox hands them to nobody, and their items stay waiting after it exits; the next start answers them. If every run fails to bind, the stale hint shows that Tandem's Claude has not polled since items arrived, and Bryan can Assign another session (§10.2, §15).

## 9. Push paths and the shim's identity

### 9.1 Narrowing the event stream (R3.4, decision 9)

**Problem.** The shim and the plugin monitor read `/api/events` with full content for every document. Both already send `X-Claude-Session-Id` (`authFetch` → `withClaudeSessionHeader`, `src/shared/cli-runtime.ts:157-160`, `:178`).

**Rule.** For each event, at the moment of writing it (live and on `Last-Event-ID` replay, `src/server/events/sse.ts:72-84`, `:97-108`), the stream's header is mapped, in this order:
1. the current Tandem's Claude run's session id → the `tandem` record, for reading only (it never marks notices handled and never maps a reply, §9.2);
2. a live `claude:<id>` record → that record;
3. anything else, or no header → **unmapped**, which gets exactly today's stream.

A mapped stream gets an event when its document is held by the record or unowned; a chat event when the message's owner (§7.1) is the record or the message is claimable; and every event with no document that is not chat (the Solo release wake, for example). Narrowing runs after the existing Solo filter and licence refusal, never before (R3.1). Mapping per event means a shim that connected before its bridge initialized becomes mapped once the record exists. A stream mapped to a `claude:` record that writes an accept or dismiss notice records it as handed (§6.4).

`ownership-changed` (§8.6) is written as its own SSE event name, outside the `TandemEvent` union, with **no `id:` line and an empty `data: {}`**: an id missing from the buffer would make `replaySince` replay the whole buffer, and today's consumer parses `data` as an event, fails validation and logs one line per frame (`src/shared/sse-consumer.ts`), which PR 4 pins as the expected outcome for an older shim or monitor.

**Monitor terminals (probe 2).** A plugin monitor saw `CLAUDE_CODE_SESSION_ID` equal to its session's id, so its stream is mapped exactly when its terminal has a `claude:<id>` record (the plugin's bridge entry). *If a later build differs:* such monitors are unmapped and keep today's stream.

**Tracking is unchanged.** `pushEvent` marks an event pushed (`alreadyPushed`, the delivery round) before any stream's narrowing, so an event every mapped stream drops still reads as pushed. That is today's over-report, kept until Phase 3's reach-first ordering (§15).

### 9.2 `/api/channel-reply` (R1.3, R3.3)

**Rule.** After the body checks (`src/server/mcp/channel-routes.ts:124-133`) and before the greeting classifier and the append (`:137-145`), the route maps the header in §9.1's order and applies §7.3's acceptance and §5.5's answered-once check, passing the mapped record explicitly:
- the current Tandem's Claude run's id → never accepted as Tandem's Claude, because the header is never enough to act as it (R3.3). Today's code expects the child's shim might send the greeting this way (`channel-routes.ts:158-160`); under the flag that reply is refused with `unlinked`, whose remedy leads to the `tandem` server's `tandem_reply`, where the bound child is accepted;
- a `claude:<id>` record → accepted or refused as that record;
- unmapped → if the target message's owner is Tandem's Claude, refused with `chat` (one refusal instead of two); otherwise `unlinked`.

A refusal is HTTP 409 with the `NOT_DOC_OWNER` body; the shim relays a failed reply's status and body to the model as the tool result.

### 9.3 A direct-HTTP terminal's shim (R4.8, settled)

**Problem.** A `tandem setup` terminal's MCP entry is direct-HTTP (`apply.ts:514`). Its shim sends `X-Claude-Session-Id`; its MCP transport does not (probe 3), so no record carries that id.

**Settled: such a shim is never linked.** It keeps today's full stream (R3.4), and its replies are refused with `unlinked` (or `chat`, §9.2); the remedy sends the model to the `tandem` server's `tandem_reply`, checked as the terminal's `http` record. The ways to link it were each ruled out:
- **Expanding `${CLAUDE_CODE_SESSION_ID}` in the entry's headers** — measured (probe 4): Claude Code expands header variables from its own process environment, which does not hold its own session id. The header arrived as the fallback value, or, for a `claude` started inside another Claude Code session, as the **parent's** id. It cannot link, and setup must never write it.
- **A pairing id written by setup** names the install, not the session: two terminals sharing one `.mcp.json` would each answer as the other.
- **A value the model carries between the two servers** depends on every model and every older skill doing it, and fails silently when they don't. The refusal and its remedy reach the same end with no new protocol.

The cost is a single-session change for the flip's CHANGELOG (§14). Plugin terminals, whose bridge and shim send the same header, are linked and unaffected.

### 9.4 What stays unscoped until Phase 3

`/api/wake` sockets and the supervisor's stdin wake stay unscoped: an armed session, or Tandem's Claude's child, is still woken for every wake-worthy event, finds nothing for documents it does not hold, and ends its turn. That costs a turn per event and produces no answer. An unmapped shim or monitor still receives full content; the refusal copy (§5.3) is what keeps a pushed item from becoming a take.

## 10. Controls

### 10.1 Routes (R3.5)

One new registrar, `src/server/mcp/routes/ownership.ts`, mounted through `api-routes.ts` behind `apiMiddleware`, whose Host check covers DNS rebinding.

- **`POST /api/ownership`** `{documentId, action: "release" | "assign", ownerLabel?}`. It calls `assertLoopbackForMutation` and `assertOriginAllowlisted` at handler top, so CLAUDE.md's enumeration of routes that call neither (pinned by `tests/docs/loopback-gate-claims.test.ts`) is unchanged, and it requires a parsed JSON body, so a `text/plain` simple request cannot reach it. The native menu's Release and Assign leaves are emitted to the webview as `ctx:tab:*` actions (`src-tauri/src/context_menu.rs`; ids in `src/client/tabs/tab-context-menu.ts:15-26`, where the new ids join), so every request comes from the webview with its origin. It runs through the document's queue with v4.1's 10-second wait, `409 busy`, no-op answers (`200 {changed: false}`), `404 unknown-owner` and `409 owner-detached`.
- **`GET /api/ownership/owners`** returns `[{label, displayKind, holds: [documentBasename], canTake}]` for attached records and for Tandem's Claude while present. GET is outside the path-wide loopback invariant, so the handler checks `req.socket.remoteAddress` itself and answers 403 otherwise.
- **Critical Rule 9.** Both get `open` rows in `tests/server/license-gate-api-coverage.test.ts`. The POST's reason says that Release and Assign must work keyless, and that their AI effect (`startOrWake`, the wake frames) is refused downstream, in the supervisor's start and in each frame writer; `tests/server/launcher/license-refusal.test.ts` gains an unlicensed Assign case.

### 10.2 The badge and the composer (R4.7)

`data-testid="tab-owner-badge"` shows the holder's display kind and label and the document's kind. It is **shown only when it says something**: when more than one AI record is attached, when the document is held by a record other than Tandem's Claude, or when a hint below is active. A lone Tandem's Claude, or no AI at all, shows no badge unless a hint is active. All fields ride on the `Y_MAP_OPEN_DOCUMENTS` entries through `toDocListEntry` (`registry.ts:127`), so there is no new Y.Map key.

- **Stale owner** (a boolean): the holder is in its grace, or the document's oldest waiting item is more than 5 minutes old and the holder has not polled since it arrived. Suppressed while a start is pending. A 60-second server tick recomputes it and republishes only on a change; `lastPollAt` itself stays server-side.
- **Waiting, with a Start button**, when items are waiting, no start is pending, and either the holder is Tandem's Claude and it is not running, or the document is unowned, no attached record could claim it, and the oldest waiting item is more than 5 minutes old. The button calls the existing Start control; on an unowned document its copy says that starting Tandem's Claude also takes back documents terminals hold as `claimed`. It appears only where Start can help: Tandem's Claude is configured, and not needing sign-in, unlicensed or missing its CLI. A tripped breaker counts, since Start resets it. Off counts too: Start from Off is the 2026-10-13 behaviour.
- **Release** is hidden where it would change nothing: on an unowned document, and on a `default` document while Tandem's Claude is present.
- **Assign** lists only records that can take a document (`canTake`): attached records, and Tandem's Claude only while present. Each row shows the display kind, label and the basenames of what it holds, so two terminals can be told apart.
- **The chat composer** names who will answer a message sent now, from the active document's entry, or the doc-less rule with no tab: "→ Tandem's Claude", "→ Tandem's Claude (will start)", "→ terminal owner-k7qx", "→ terminal owner-k7qx (disconnected)" for a holder in its grace, "→ the first session to check in" for an unowned document, and "No AI will answer" when nobody is attached and Tandem's Claude cannot start. "(will start)" is a best effort: a mapped terminal can claim an unowned document first during Tandem's Claude's first start.

The Tauri menu gains a Release leaf and an Assign leaf that opens the popover (v4.1 §3.11), each enabled only when the entry carries owner fields, so a dark build shows neither. The testid snapshot gains the new selectors, add-only.

### 10.3 What the badge and refusals may say (R3.6)

- The display kind is the server's choice from a closed list: `Tandem's Claude` for `recordKind: "tandem"` only; `Claude Desktop` when `clientInfo.name` equals `CLAUDE_DESKTOP_CLIENT_NAME` (`transport-registry.ts:235`); `terminal` for a `claude` record or an `http` record whose client name is Claude Code's; `other app` otherwise. A client can choose which of the last three it appears as, never `Tandem's Claude`, and never free text. `clientInfo.name` is never displayed.
- **No names.** v4.1's session rename is not built: a nickname set through a route any local process can call would put chosen text on the badge. The Assign list's held-document basenames do what rename did — tell two terminals apart — with server-derived text only.

## 11. Security posture

### 11.1 The headers (R3.3)

`X-Claude-Session-Id` and `X-Tandem-Client-Id` **select** among identities and are not proof. Any local process can send any value, and session ids are easy to find (transcript file names, child process arguments, `launcher-session.json`). Neither header is, or may be, in `Access-Control-Allow-Headers` (`api-routes.ts:174` allows only `Content-Type`), which is what keeps a local web page from sending them.

Within D4 — ownership coordinates Claude sessions and is not a security boundary; every local process already holds every write, since loopback callers bypass bearer auth — a forged id gets everything the named record has: its narrowed event stream, and the notices that stream marks handled; its reply rights on `/api/channel-reply`; and, on an MCP transport, its documents, its answerer rights, and acknowledgement of its inbox items.

It never gets Tandem's Claude's rights: binding to the `tandem` record needs the live handle (§3.3); the child's id never names a shared record (§3.1); and the channel route never maps a header to Tandem's Claude (§9.2). A forged child id on `/api/events` gets the `tandem` record's narrowed stream, never more than today's unmapped stream, and marks nothing handled. PR 4 records this in `docs/security.md`.

### 11.2 The handle is a bearer secret

It is minted per spawn, written only to that run's stdin, never to `launcher-session.json`, and dies at teardown. The child's own transcript under the user's Claude config may hold it, and any local process can read that, including a terminal acting on text planted in a document. A process holding the live handle can bind as Tandem's Claude for that run, and then acts with its rights: posts, take-back authority it does not need, the greeting classification. Every bind is logged and counted in Settings (§3.3), so a bind Bryan did not expect is visible, and the next spawn's handle is new. This exposure is **open for Bryan** (§14): it is not one of the two he accepted.

Hygiene: an invalid handle has no side effects and is never echoed. A redaction for `th_[A-Za-z0-9_-]{32}` is applied where the child's own output reaches `tandem.log` (its stderr, `supervisor.ts:2562`, and its non-JSON stdout, `:2434`), not only in `sanitizeForLog`. Every string argument of every tool other than `ownerHandle`, recursing into nested arrays and objects, is checked at argument parsing for a live handle and refused with `INVALID_ARGUMENT`, comparing against the live set (no oracle for a stale one). This stops accidental echo into documents, chat and annotations; it does not stop exfiltration, for example a handle written to a file by another tool and then opened.

### 11.3 Exposures filed for Bryan (R3.5)

PR 5 adds two entries to `docs/security.md`, both confirmed by Bryan on 2026-11-04 (the plan's last section):
- **The owners list is readable by local pages.** Any page served from an allowlisted `127.0.0.1` origin can read, from `GET /api/ownership/owners` and from the owner fields on `Y_MAP_OPEN_DOCUMENTS` that every editor client syncs, the labels, display kinds and held document basenames of attached sessions.
- **Any local process can Assign itself a document**, including a Claude session using curl, bypassing the `opened` and `assigned` refusals. This is coordination, not security (D4).

### 11.4 What a non-loopback bind would add

ADR-056 ships the non-loopback bind dark. If it were re-enabled, LAN MCP peers would become records that can hold and take documents and read labels, through the #1906 path. PR 1a records this in ADR-054 and amends ADR-056's re-enable checklist with a new item, and updates its item 5, which un-suspends v4.1 stories that v5 does not re-status. This PR does not edit ADR-056.

### 11.5 Licence

Every new path that writes to the child (`requestWake`, take-back's owed wake) or to an AI's push channel (the two `ownership` frames) refuses through `aiRefusal()` (§8.6). The routes stay keyless (§10.1).

### 11.6 `#1952` and `peerIsLoopback`

PR 1a sets `McpRequestContext.peerIsLoopback` from `req.socket.remoteAddress` through `isLoopback`, inside the request context that wraps the whole awaited `handleRequest`, and nothing reads it. PR 1b, which would make `wakeUrlField()` (`src/server/mcp/wake-url.ts:57`) omit the field for a non-loopback peer, is **conditional**: #1952 is closed as not planned, `docs/security.md` records it as accepted by Bryan and bounded by ADR-056's `LAN_BIND_ENABLED = false` (`docs/security.md:673`), and ADR-056's re-enable checklist schedules the fix (item 3). Whether PR 1b lands now (reopening #1952 and amending ADR-056 and the register) or at the LAN re-enable is Bryan's call (§14). Nothing else here depends on it.

### 11.7 Unchanged

No new `NON_LOOPBACK_ALLOWED` entry. `/api/wake` keeps its own origin and address checks. The rest of `/api` stays ungated by ownership: a session refused `NOT_DOC_OWNER` that holds Bash can still curl `/api/save` and the other mutating routes, which no refusal copy names.

## 12. Shipping dark

**Flag.** `OWNERSHIP_ENABLED`, a literal `const false` in `src/shared/constants.ts`, injected by tsup as `__OWNERSHIP_ENABLED__` into both the server and cli blocks (the cli inlines server code). `src/server/ownership-flag.ts` reads it per call, like `src/server/file-io/docx-flag.ts`, with the same `TANDEM_TAURI_SIDECAR` warning when the define is missing. With no define (tsx, vitest), `TANDEM_OWNERSHIP=1` turns it on. The define-less bundles (the stdio bridge, the shim, the monitor, `src/shared`) never read the flag: what they add (the bridge's client id, PR 4's consumer handling) is unconditional and ignored by a dark server.

| Requirement | How |
|---|---|
| Release builds never carry the flag | A test pins the literal `false`, in the style of `tests/docs/license-flip-consts.test.ts` |
| A shell export can't make a half-on build | `tsup.config.ts` derives the define from the literal and reads no environment variable for it (pinned by a test). A seam test pins that every bundle reaching `ownership-flag.ts` carries the define and every define-less bundle never reaches it (as `tests/server/license-module-seam.test.ts` does for the licence). The client needs no flag: the badge, composer line and menu leaves appear only when document entries carry owner fields, which a dark server never writes |
| Ownership code is under a blocking test | Each ownership test file turns the flag on for itself with `vi.stubEnv("TANDEM_OWNERSHIP", "1")`, as the `.docx` suites do, so it runs in `check`. `TANDEM_OWNERSHIP` is **not** in the root `test.env`, which beats the shell |
| A positive anchor | One anchor test, in a file of its own that never stubs the variable, runs only when the flag is on (`it.runIf(ownershipEnabled())`); the flag-on job's runner refuses unless it reports at least one pass. From PR 5, which lands the first ownership E2E spec, the runner also refuses unless at least one ownership E2E spec passed; those specs gate on a **runtime** signal (`tools/list` carries `ownerHandle`), not on the literal |
| Each PR is green flag-off **and** flag-on | A rule for PRs 1a–5, made an explicit merge precondition in the PR checklist because the flag-on job is advisory. A test that pins dark behaviour stubs the variable to `""` for itself; each PR lists such tests under "changed tests" (§17) |
| Nothing visible while dark | `tools/list` is built per `McpServer` from the flag: no `ownerHandle`, no `ownership` output field, no `NOT_DOC_OWNER` text, no new codes in descriptions. Scope exclusion, tenures, acknowledgement scoping, the handled filter, the chat handover, the op queue's ownership check, the start-rule change, `startOrWake` and both frames are bypassed. Nothing is stamped: no owner fields on document entries, no `settles` or `superseded` on chat rows, no handle in prompts |
| An advisory flag-on job | `ownership-flag-on` in `.github/workflows/ci.yml`. `scripts/ci/build-ownership-on.ts`, run under tsx (`tsup.config.ts` imports a `.ts` module), loads the config array and calls tsup's `build({...block, define: {...block.define, __OWNERSHIP_ENABLED__: "true"}, config: false})` once per block (without `config: false`, tsup would load the config itself and merge the passed options over every block). Then `typecheck`, `npm test` and the E2E suite with `TANDEM_OWNERSHIP=1`, and `scripts/ci/ownership-flag-on-runner.mjs` checks the anchors. About 17–19 runner-minutes per push, in parallel. A wiring test inside `check` pins the job, its env, both scripts and the anchors (ADR-051; PR 1a adds the instances-table row). A full flag-on E2E run is a precondition of PR 6 |
| The bound-launcher path without `claude` | The launcher tests' mocked child (as `tests/server/launcher/supervisor-turn-delivery.test.ts` builds one) reads the `th_` handle from its stdin turn, and an in-test MCP client presents it to the real HTTP server, or withholds it (R2.5) |

## 13. Probes (R5 and R4.8) — measured

Measured on Claude Code 2.1.318, Windows 11, 2026-11-04.

| # | Question | Measured | Used in | If a later build differs |
|---|---|---|---|---|
| 1 | Does a resumed child keep `CLAUDE_CODE_SESSION_ID`? | `claude -p --session-id U`, then `claude -p --resume U`: a tool subprocess saw `U` both times | The bind check's header half (§3.3); the child-id mappings (§3.1, §9.1) | Accept any header on a handle bind; a child's streams become unmapped and keep today's stream |
| 2 | Does a plugin monitor carry a session id? | A monitor (`experimental.monitors`, `when: always`) in an interactive session started with `--session-id U` saw `U` in its environment | Monitor streams map like the shim's (§9.1) | Such monitors are unmapped and keep today's stream |
| 3 | Does Claude Code hold a `GET /mcp` stream? | A direct-HTTP server under `claude -p` saw `server/discover`, `initialize`, `notifications/initialized`, then `GET /mcp` (accept `text/event-stream`) held until the process exited; no `X-Claude-Session-Id` was sent. Interactive mode was not measured; the same transport code is likely, unverified | The 2-minute return (§3.4); the direct-HTTP shim (§9.3); the stateless-era note (§3.5) | A dead terminal's documents return by the reaper bound, about 37 minutes |
| 4 | Can a direct-HTTP entry's headers carry the session id by `${CLAUDE_CODE_SESSION_ID}` expansion? | An `http` entry with `"X-Claude-Session-Id": "${CLAUDE_CODE_SESSION_ID:-unset}"`, under `claude -p --session-id V --strict-mcp-config`: every request (`server/discover`, `initialize`, `GET /mcp`) carried `unset`. Run from inside another Claude Code session, it carried that **parent** session's id instead of `V` | Rules out linking a direct-HTTP terminal by header (§3.1, §9.3) | If a later build sets the variable in its own process to its own id, setup could write the header and direct-HTTP terminals would become `claude` records; until then, never |

Not probed: whether `claude -p` loads plugin MCP servers. If it does, Tandem's Claude's child has two toolsets; §3.3 already binds each and tells an unbound one how to bind.

## 14. Conflicts, single-session changes, and what is open for Bryan

| Conflict | Where | What changes |
|---|---|---|
| ADR-011: `documentId` defaults to the active document | `docs/decisions.md` | Narrowed, not superseded: reads and range-keyed writes keep it (writes refuse rather than retarget); replies follow §7.3. ADR-054 records this |
| ADR-049 Decision 1: the inbox arbitrates between sessions | `docs/decisions.md` | Ownership arbitrates; the cursor registry stays the delivery record. Amended in ADR-054 |
| #2196: no start "if another AI is on" | `supervisor.ts:1410`, `:1432` | Overridden for documents Tandem's Claude holds and the chat it owns (decision 10); unchanged elsewhere |
| #2330's inbox identity pin | `tests/server/inbox-cursor.test.ts:1060-1078` | Amended per §6.8 |
| `NOT_OWNED` (#2360) | annotation lifecycle | `NOT_DOC_OWNER` is answered first |
| v4.1 D5, §5.5-A, session rename, `issueHandle`, `ownerLabel` | v4.1 | Dropped or reversed (§0) |
| The plan's call that a chat on a Claude Desktop document can start Tandem's Claude | plan | Moot: §8.3 starts nothing for a document another attached record holds, Desktop included |
| Critical Rule 9 tables | `license-gate-api-coverage.test.ts`, `ai-surface-inventory-claims.test.ts` | Two route rows (§10.1); the new turn and frame writers join the inventory (§8.6) |
| CLAUDE.md's enumeration of routes that call neither gate | CLAUDE.md, `tests/docs/loopback-gate-claims.test.ts` | Unchanged: `POST /api/ownership` calls both |
| `SKILL.md`, `SERVER_INSTRUCTIONS` | `skills/tandem/SKILL.md` | Changed only at the flip (PR 6): pass the handle first in Tandem-launched sessions; follow a refusal's remedy; `tandem_open` a held document only when the user asked in your own conversation; reply with `replyTo` |

**What changes for a single session**, for the flip's CHANGELOG. The plan's two, worded to v5's copy, then the rest:
1. Another AI client (a terminal or Claude Desktop) next to a present-but-idle Tandem's Claude is refused on Bryan's documents and on doc-less chat, and is no longer handed their items at all. The refusal says when `tandem_open` is appropriate (only when the user asked it directly), and Claude starts for those items. (Plan.)
2. Tandem's Claude alone and idle-stopped is started by a new comment or a user thread reply on its documents, not only by chat. A comment on a document opened while it was Off, and not yet taken back, does not start it. (Plan.)
3. A direct-HTTP terminal's opt-in shim has its replies refused with a remedy (§9.3).
4. A post (`tandem_reply` without `replyTo`) from a terminal is refused on a document Tandem's Claude holds while present, and on doc-less chat (§7.3).
5. `tandem_switchDocument` is refused on a document another session holds (§5.6).
6. `tandem_reply` with a `replyTo` and a contradicting `documentId` is refused with `INVALID_ARGUMENT` (§7.3).
7. Tandem's Claude depends on its model passing the handle; an unbound run answers nothing until it does (§3.3, §8.7).
8. New visible UI: the composer's "who answers" line, and the badge and waiting hint wherever they say something (§10.2).

**Open for Bryan.**
1. **PR 1b.** Land it now (reopen #1952, amend ADR-056 and the register), or defer it to the LAN re-enable, where ADR-056 already schedules it (§11.6).
2. **Two Tandem toolsets in one terminal** (§3.1). A plugin user who also ran `tandem setup` has both the plugin's bridge entry and setup's direct-HTTP entry. Each such terminal is two records that nothing can link (probe 4): if the model opens a document through one toolset and replies through the other, it is told the document is another session's and not to retry, and the plugin's shim is not pushed that document's comments, which then wait for the stale hint and Assign. The plan's manual check ("a terminal with the plugin and the channel shim") runs in exactly this configuration if setup was also run. Options:
   - (a) accept it, and make the doctor's existing duplicate-toolset warning a flip prerequisite;
   - (b) have `tandem setup` stop writing the direct-HTTP entry for Claude Code when the plugin is installed, which touches the launcher's "configured" check;
   - (c) have the doctor offer to remove the duplicate.
3. **The handle's exposure** (§11.2). A local process that can read Tandem's Claude's transcript can bind as it for one run. Accept it as a third filed exposure (D4), or ask for a stronger mechanism.
4. **Session rename** (v4.1 §5.12, decided 2026-09-17) is not built (§10.3); held-document basenames in the Assign list replace it. Reinstating it needs a route curl cannot reach, or a further filed exposure.

## 15. Known limitations

- **Restart forgets** ownership, answerers, loss records, handed notices and change notices (decision 8). The handled filter still keeps answered items out of every inbox; an old notice may be handed once more.
- **A client that never holds a `GET /mcp` stream** keeps its documents up to about 37 minutes after it dies (§3.4). An `http` record evicted by the session cap, which any local process can force, becomes a new record and loses its documents after the grace.
- **A direct-HTTP terminal's shim** is never linked (§9.3), and a terminal with two Tandem toolsets is two records (§3.1, §14).
- **A post is not an answer.** A reply without `replyTo` is checked by ownership only, so a session that holds a document can post a second, unlinked answer to an item another record answered. The refusal copy and the skill require `replyTo`.
- **Wasted turns until Phase 3:** unscoped wake sockets, the supervisor's stdin wake and unmapped shims and monitors still wake sessions that have nothing to do; `alreadyPushed` and delivery rounds still count an event as pushed before narrowing.
- **Sign-in loops** churn take-back and release once per Check again (§8.2).
- **A run that never binds**, repeatedly, leaves Tandem's Claude's documents waiting until Bryan sees the stale hint and Assigns (§8.7).
- **Separately spawned helpers** (a remote subagent, a second `claude` process) are separate sessions, refused on documents their orchestrator holds as `opened` or `assigned`.
- **Chat labels.** A Claude chat message does not record which session sent it.
- **The local-model collaborator** (dark, `BYO_MODELS_ENABLED`) writes in-process under `runAsInternal()`, bypassing ownership; its rows carry `agentIdentity` and settle nothing. Revisit when it flips.
- **Stateless clients** (MCP `2026-07-28`) hold nothing until the stateless branch gives them a record (§3.5).

## 16. Requirements, tests and the PR that lands each

| Req | Section | Acceptance test (the plan's) | PR |
|---|---|---|---|
| R1.1 | §6.3 | The #2358 repro with cursor polls and with legacy polls; two terminals, Tandem's Claude Off, one comment | 2 |
| R1.2 | §6.2, §6.4 | Take-back after a push-answered comment; after a `claimed` owner's answer; handover both ways with old and fresh cursors | 2 (the take-back cases in 3b) |
| R1.3 | §5, §9.2 | Refusals per tool (1c) and on the channel path (4) | 1c, 4 |
| R1.4 | §7.1 | Two terminals, Tandem's Claude Off, one doc-less chat: one answer | 2 |
| R1.5 | §5.5 | Tandem's Claude answers; a pushed terminal takes the document and replies; refused | 1c (comments), 2 (chat) |
| R2.1 | §6.2, §6.5 | Acknowledged, then Off, then the terminal is handed it | 3b |
| R2.2 | §5.2, §7.3 | Doc-less answer with no tabs; greeting; id-keyed reply on a non-active held document | 2, 3a (greeting) |
| R2.3 | §7.2 | The owner dies, then the chat is answered | 2 |
| R2.4 | §8.3, §8.4 | The decision-10 cases; Assign and Release with items waiting; single-session change 2; today's matrix otherwise | 3b (Assign and Release through the seam; end to end in 5) |
| R2.5 | §8.7 | A child that never presents its handle | 3a |
| R2.6 | §6.4 | A handover does not hand over the old owner's notices | 2 |
| R2.7 | §8.6 | Assign to a running terminal, take-back while running, a lapse while running, each answered with no new event | 3b, 5 |
| R3.1 | §6.3, §8.3, §8.5, §9.1 | Solo-held items never claim, start or wake | 2, 3b, 4 |
| R3.2 | §8.6 | AI-surface inventory derivations and licence seam pins | 3b, 4 |
| R3.3 | §3.1, §3.3, §9.2, §11.1 | A forged child id cannot bind, join or pre-create the child's record, or reply as Tandem's Claude | 1a, 3a, 4 |
| R3.4 | §9.1 | Unmapped and no-header streams equal today's, live and on replay | 4 |
| R3.5 | §10.1, §11.3 | Route gate tests; the two register entries | 5 |
| R3.6 | §5.3, §7.3, §10.3 | No session text and no forged "Tandem's Claude" in any refusal, badge or greeting | 1c, 3a, 5 |
| R3.7 | §6.8 | The amended pin; identical cursors across records with the same holdings | 2 |
| R4.1 | §5.2 | Reads default to the active tab; writes refuse rather than retarget | 1c |
| R4.2 | §5.3 | One test per `reason`, and the precedence | 1c, 2, 4 |
| R4.3 | §8.1 | One announcement per transition, none from `status()`, no flap through a crash-resume | 3b |
| R4.4 | §4.3 | Opening and default holding wake nobody | 2, 3b |
| R4.5 | §6.2 | Handover of a quiet background document | 2 |
| R4.6 | §6.3 | More than 256 pending foreign items; 300 open foreign documents | 2 |
| R4.7 | §10.2 | Badge and composer E2E | 5 |
| R4.8 | §9.3 | A direct-HTTP shim's reply is refused with the remedy; its stream equals today's | 4 |
| R5 | §13 | Measured | 0 |

**Flag-on state between PRs.** After 1a, records exist and nothing is enforced. After 1c, writes are checked, but Tandem's Claude is never present (presence arrives in 3b), so every document is unowned or held by a terminal. After 2, the inbox is scoped. After 3a, the child binds, but while not present it holds nothing and its writes to unowned documents are refused (§4.2) — the flag-on suite expects that until 3b. After 3b the plan's MCP behaviour is complete. After 4, push narrows; after 5, Bryan has the controls.

## 17. PR sizing

Rough sizes include tests. "Changed tests" lists existing tests whose assertions change, flag-on or flag-off.

| PR | Files touched | Scope | Changed tests |
|---|---|---|---|
| **1a. Identity and flag** | New `src/server/sessions/ownership.ts` (records, labels, kinds, `ownerByDoc`, tenures, `setDocOwner` with no enforcement and a no-op `startOrWake` stub, the presence seam); new `src/server/ownership-flag.ts`; `src/server/sessions/context.ts`; `src/server/mcp/server.ts` (records at initialize, the explicit caller, `runAsInternal`, the deny-all default, the stdio record); `src/server/mcp/transport-registry.ts`; `src/cli/mcp-stdio.ts` and `src/shared/cli-runtime.ts` (`X-Tandem-Client-Id`, unconditional); `src/shared/constants.ts`; `tsup.config.ts`; `scripts/ci/build-ownership-on.ts`; `scripts/ci/ownership-flag-on-runner.mjs`; `.github/workflows/ci.yml`; the default rule at Bryan's opens (`src/server/documents/open.ts`, `src/server/mcp/routes/{open,upload,scratchpad}.ts`, startup restore and `welcome.md` in `src/server/index.ts`); the close point in `src/server/mcp/document-service.ts`; the internal callers wrapped in `runAsInternal` (the reload family, the local-model tools); `docs/decisions.md` (ADR-054, ADR-051 instances row, ADR-056 checklist items); `CLAUDE.md` (ships-dark entry) | Medium-large: about 20 files, 1,200–1,600 lines | None flag-off; the flag seam, wiring and anchor tests are new |
| **1b. #1952** *(conditional)* | `src/server/mcp/wake-url.ts`; `docs/security.md`; `CLAUDE.md`; `docs/decisions.md` (ADR-056 amendment) | Small: under 200 lines | `tests/docs/security-findings-claims.test.ts` |
| **1c. Enforcement** | New `src/server/sessions/doc-op-queue.ts`; `src/server/mcp/{document.ts, annotations.ts, list-edit.ts, docx-apply.ts, convert.ts, navigation.ts, response.ts, output-schemas.ts}`; the annotation lifecycle's reply path (answered-once for threads); `src/shared/types.ts` (`NOT_DOC_OWNER`); the refusal copy module; `docs/mcp-tools.md`. May split into queue-and-placement, then copy-and-answered-once, if review wants | Large: about 14 files, 1,800–2,500 lines | `tests/docs/tool-error-codes-claims.test.ts`; `mcp-output-schemas.test.ts`; #2360's refusal-order tests; tool-description snapshots flag-on |
| **2. Inbox and replies** | `src/server/mcp/inbox-cursor.ts` (tenure scope strings, dropping a closed document's tenures); `src/server/mcp/awareness.ts` (scope, tenure-keyed quiet state and legacy ledgers, scoped acknowledgement, claims decided in collection, the handled filter on both paths, `settles`, reply and post acceptance, the `ownership` field); `src/server/sessions/ownership.ts` (chat handover, per-message owners, handed notices); `src/server/events/delivery-state.ts` (per-document and per-message rounds); `src/server/mcp/annotations.ts` (labels); `src/shared/types.ts` (`settles`, `superseded`); the client chat pickup (`superseded`); `docs/mcp-tools.md` | Large: about 9 files, 1,600–2,200 lines | `tests/server/inbox-cursor.test.ts` (the pin); delivery-state tests; `checkInbox` output-shape tests; multi-session inbox tests that expect both sessions to be handed an item (flag-on); chat pickup tests |
| **3a. Handle and bind** | `src/shared/launcher/contract.ts` (three builders wrapping the constants); `src/server/launcher/supervisor.ts` (mint per spawn, teardown, the child-id record demotion, bind logging and count); `src/server/sessions/ownership.ts` (bind check, absorb); the four entry tools' schemas and descriptions in `src/server/mcp/{awareness.ts, document.ts}`; `src/shared/types.ts` (`INVALID_OWNER_HANDLE`, `OWNER_HANDLE_CONFLICT`); the argument-level handle scrub (`src/server/mcp/response.ts` or the tool wrapper); the log redaction on the child's output lines; the greeting classification; `docs/mcp-tools.md`; `docs/security.md` (the handle, if Bryan accepts it) | Medium: about 10 files, 900–1,300 lines | Launcher prompt tests, if they assert on the wrapped text (`supervisor`, `stream-json-protocol`, `supervisor-turn-delivery`); greeting tests; the dark `tools/list` pin |
| **3b. Presence, take-back, starts, wakes** | `src/server/launcher/supervisor.ts` (the presence setters, microtask recompute and 5-second loss settle, take-back at the post-spawn point, the start predicate and its accumulated bit at `:1410`/`:1432`, the Solo-release check, `startOrWake`, `requestWake`); `src/server/sessions/ownership.ts` (presence consumer, waiting); `src/server/events/wake-socket.ts` (the `ownership` frame and its licence check); `tests/server/launcher/license-refusal.test.ts` | Large: about 5 source files, 1,200–1,600 lines, concurrency-heavy | The #2196 start matrix (flag-on); `tests/docs/ai-surface-inventory-claims.test.ts`; licence seam pins |
| **4. Push and shim identity** | `src/server/events/sse.ts` (narrowing, the `ownership-changed` frame and its licence check); `src/server/mcp/channel-routes.ts`; `src/shared/sse-consumer.ts`; the shim and monitor (`src/channel/`, `src/monitor/`); `docs/security.md` (the headers) | Medium: about 7 files, 800–1,200 lines | SSE and channel-route tests that assume every stream gets every event (flag-on) |
| **5. Controls** | New `src/server/mcp/routes/ownership.ts`; `src/server/mcp/api-routes.ts`; `src/shared/api-paths.ts`; new `src/client/tabs/TabOwnerBadge.svelte`; `DocumentTabs.svelte`; `tab-context-menu.ts`; the chat composer line; `src-tauri/src/context_menu.rs`; `src/server/documents/registry.ts` (`toDocListEntry` fields, the stale tick); testid snapshot and manifest; the first ownership E2E specs; `docs/security.md` (two exposures) | Large: about 13 files, 1,300–1,800 lines incl. E2E | `license-gate-api-coverage.test.ts` (two rows); `testid-set.snap.txt` (add-only) |
| **6. Flip** | `src/shared/constants.ts`; `skills/tandem/SKILL.md` (version bump); `SERVER_INSTRUCTIONS`; docs; `CHANGELOG.md` (§14's changes); the release-smoke checklist | Small in code, large in docs | Dark pins removed; skill contract hash and version |
