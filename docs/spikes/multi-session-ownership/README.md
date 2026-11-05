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
| Inbox bookkeeping | A per-item delivered-to ledger replacing `surfacedIds` | Gone. #2330's cursor registry stays; ownership is **scope exclusion**, plus a **handover** that re-owes the old owner's unanswered items (§6) | `inbox-cursor.ts` replaced what v4.1 was written against |
| Answered-once | Not specified for comments | One answerer per item; handled items are never handed to anyone (§5.5, §6.4) | R1.5, R1.2, decision 6 |
| Doc-less chat | D5: disable send on an empty tab | D5 dropped. Doc-less chat belongs to Tandem's Claude while present, else per message (§7) | Plan |
| Channel shim | §5.5-A: no identity | §5.5-B: its `X-Claude-Session-Id` selects a record; its stream narrows and its replies are checked (§9) | Decision 9 |
| Direct-HTTP terminal's shim | n/a | **Never linked**, measured (probe 4); keeps today's stream, replies refused with a remedy (§9.3) | R4.8 |
| Launcher | Handle per run; the child's record dies with it | The handle binds each run to the one **Tandem's Claude** record, which outlives runs; presence, take-back at spawn, widened starts, waking (§8) | Decisions 2, 7, 10, 11 |
| Dead terminal | ~32 min (idle reaper) | About 2 minutes after its `GET /mcp` stream closes (§3.4) | Probe 3 |
| `#1952` | Fixed per request | `peerIsLoopback` set in PR 1a and read by nothing; PR 1b is conditional on Bryan (§11.6) | #1952 is accepted and bounded by ADR-056 |
| Error code | `NOT_OWNER` | `NOT_DOC_OWNER` with a `reason` (§5.3) | R4.2 |
| Names on the badge | Nicknames (set by Bryan or the session), client name | Server-derived display kind, label and held-document names only; rename is not built (§10.3) | R3.6 |
| `tandem_open` activation | Re-open and claim do not activate | Today's behaviour: every `tandem_open` activates (§5.4) | No unlisted single-session change |
| Subagent hand-off (`issueHandle`), `ChatMessage.ownerLabel` | Built | Not built (§15) | No requirement needs them |
| Wake socket scoping (`?watch=`, socket pin) | Phase 3 | After the flip; Phase 3 starts from v4.1's text | Plan |

## 1. Summary

- Every open document has **at most one owner**. Only the owner is handed its items (inbox and push), and only the owner's answers and writes are accepted. Reads stay open. The server enforces this in the MCP tool wrapper and on `/api/channel-reply` and nowhere else; the rest of `/api` is Bryan's own surface (D4).
- **Tandem's Claude** is one owner record across all its child runs. While **present**, it holds every document no other session opened. A terminal answers only documents it opened or took with `tandem_open`, documents Bryan assigned to it, and documents it was handed while Tandem's Claude was not present.
- **Kinds** say what can move a document: a starting Tandem's Claude run takes back `claimed` documents; another session's `tandem_open` takes `default` and `claimed` ones; `opened` and `assigned` move only by Bryan's Release or Assign, or when their owner goes away.
- **The inbox stays on #2330's cursors.** A document held by someone else is not in the caller's scope. When ownership moves away from a record, the items it was handed and did not answer are owed again to everyone; answered items are never handed to anyone.
- **One answer per item.** The first record whose final answer is accepted is the item's answerer.
- **Starting and waking.** A present Tandem's Claude that is not running starts for asks on its own documents, even with a terminal attached, and for documents or chat that come back to it with items waiting. A running owner that receives work is woken.
- **It ships dark** behind one build-time flag. Its tests run in the blocking `check` job; an advisory job runs everything else flag-on.

## 2. Terms

| Term | Meaning |
|---|---|
| **Owner record** | Server memory: `{ownerId, recordKind, label, transports, lastPollAt, losses}`. Lost on restart (decision 8). |
| **Record kind** | `tandem` (one per server run), `claude` (a transport carrying `X-Claude-Session-Id`), `bridge` (the stdio bridge without one), `http` (a direct-HTTP transport with neither), `local` (stdio transport mode only; in HTTP mode a call with no caller is refused, §3.1). Server-derived. |
| **Display kind** | `Tandem's Claude` (only for `recordKind: "tandem"`), `terminal`, `Claude Desktop`, `other app`. Chosen by the server from a closed list (§10.3). |
| **Label** | A random per-run id such as `owner-k7qx`. Never derived from a session id or a handle. |
| **Ownership entry** | `ownerByDoc: Map<documentId, {ownerId, kind, since, sinceSeq}>`, where `sinceSeq` is the registry's counter when the entry was made — for a claim made by an inbox poll, the counter read **before** that pass (`counterBefore`), so the claimant's own first items count as handed to it. No entry means **unowned**. `handoverSeq` lives in a separate per-document map (§6.3). |
| **Kind** | `default`, `claimed`, `opened` or `assigned` (§4.1). |
| **Present** | Tandem's Claude may hold documents (§8.1). |
| **Default rule** | Where a document goes when nobody in particular should have it: Tandem's Claude as `default` if present, otherwise unowned. |
| **Handed** | Returned to a reader by `tandem_checkInbox`. A push stream delivers events too, but a push never counts as handed (§9.1). |
| **Handled** | Answered by a final (not `inProgress`) reply, judged from persisted state (§6.4). |
| **Waiting** | An item on a document, or a chat message, that is not handled, has not been handed to its current owner, and passes the Solo hold, `hideFromAI` and the ADR-027 and withheld predicates (§8.5). |
| **Lapsed** | A record whose documents went back to the default rule because its client went away (§3.4). |
| **Handle** | `th_` plus 32 base64url characters, minted per Tandem's Claude child spawn, named in that run's supervisor prompts (§3.3). |

## 3. Identity

### 3.1 Records, callers, and where the check lives

**Problem.** Ownership needs to know who is calling. Direct-HTTP Claude Code sends no per-session header (probes 3 and 4, §13), the stdio bridge forwards one (`src/cli/mcp-stdio.ts:438`), Claude Desktop sends neither, and stdio mode has no transport registry. And the same service code serves MCP tools, Bryan's `/api` routes, autosave and the reload family.

**Rule: records.** Each transport resolves to one record at `initialize`:
1. `X-Claude-Session-Id` present → `claude:<id>`. Several transports may share it (bridge reconnects and respawns). **Exception:** an id equal to Tandem's Claude's saved session id gets a private record per transport, never shared; and at each spawn, any shared `claude:` record holding that id is demoted (its transports re-pointed to private records, its documents to the default rule). So nothing can pre-create or join the child's record.
2. Else `X-Tandem-Client-Id` present → `bridge:<id>`. A new header, minted once per bridge process and reused by its reconnects. The bridge sends it unconditionally: `src/cli/mcp-stdio.ts` is in the define-less stdio-bridge bundle and never reads the flag; a dark server ignores the header.
3. Else → `http:<Mcp-Session-Id>`. This keys per-client state on the legacy session id, which CLAUDE.md's MCP/Server section says not to do for new state; ADR-054 records the exception (it is the only identity a direct-HTTP client has, probe 4) and PR 1a amends that CLAUDE.md line (§14).
4. Stdio transport mode (chosen at boot, `src/server/index.ts`, which tells the ownership module) → one process-wide `local` record, permanently attached, display kind `terminal`. In HTTP mode — and in any process no boot has told, such as a unit test — a tool call with no request context, or a context with no `ownerId`, is **refused** (fail closed): every HTTP MCP request enters a context (`runWithMcpContext`, `src/server/mcp/server.ts:875` and `:930`), which PR 1a pins with a test. Unit tests that call handlers directly flag-on run inside a test helper that supplies a caller; PR 1a adds the helper together with the fail-closed default and lists the files it touches.

**Rule: where the check lives.** The ownership check, claims and answered-once run **only** in two places: the MCP tool wrapper `withErrorBoundary` (`src/server/mcp/response.ts:149`), which wraps every registered tool and resolves the caller once at entry, and `/api/channel-reply`, which maps its own caller (§9.2). The caller's `ownerId` is passed explicitly into the operation queue (§5.1), `setDocOwner`, answered-once and the greeting classifier; nothing reads the ambient context inside a handler body (today's `getCurrentSessionId()` read in `tandem_reply`, `awareness.ts:2060`, moves into the wrapper). A seam test pins that the context getters are imported only by the wrapper and the caller resolver, and that every registered tool goes through the wrapper. Shared service code — `applyChangesCore`, `convertToMarkdown`, the save, open and close paths, the lifecycle — never checks ownership. So Bryan's `/api` routes, autosave, the reload family, startup restore and the local-model collaborator's in-process writes never meet it. A flag-on test drives every mutating `/api` route and an autosave tick with no MCP context and expects today's results.

**Mechanism.** The registry entry already stores `claudeSessionId` and `clientName` (`McpSessionEntry`, `src/server/mcp/transport-registry.ts:54-84`), filled in at `onsessioninitialized` (`server.ts:550`). PR 1a adds `ownerId` to the entry, and to `McpRequestContext` (`src/server/sessions/context.ts:37-59`) as set in `dispatchToSession` (`server.ts:858`); the initialize request itself needs no caller. It also adds `peerIsLoopback`, from `req.socket.remoteAddress` through `isLoopback`; nothing reads it unless PR 1b lands (§11.6).

**Two Tandem toolsets in one Claude Code session — the normal setup.** The plugin bundles a bridge `tandem` entry and the shim (`.claude-plugin/plugin.json`). The launcher spawns Tandem's Claude with no `--mcp-config` (`src/shared/launcher/contract.ts:634-644`), so Tandem's Claude depends on the user-level direct-HTTP entry `tandem setup` writes (`src/server/integrations/apply.ts:514`), and "configured" requires it (`supervisor.ts:409-418`). So every user with a configured Tandem's Claude and the plugin has both toolsets in every terminal (the doctor already warns, `src/cli/doctor.ts:2136-2138`), and each terminal is **two records**, `claude:<id>` and `http:<sid>`, which nothing can link (probe 4). If the model opens a document through one toolset and writes through the other, it is refused as if another session held it; and the plugin's shim and monitor, mapped to `claude:<id>`, are not pushed what the `http:` record holds. v5 adds one mitigation inside the design: the `held`, `claimed`, `switch` and `chat` refusals naming a `terminal` holder end with *"If you have two Tandem toolsets, the holder may be your other one: call `tandem_status` through it, and if its label is {label}, use that toolset."* It is never added to `answered` or `lost`, where it would invite a second answer. The structural choice is Bryan's (§14).

### 3.2 The Tandem's Claude record

**Problem.** Tandem's Claude is a sequence of child processes (spawn, idle-stop, resume, crash-resume, relaunch), each with its own transports. Decisions 2, 7 and 11 need one identity that outlives them.

**Rule.** The ownership module creates one record `tandem` at boot. It holds documents only while present (§8.1); while not present it holds nothing, its writes to unowned documents are refused, and its polls read nothing (§4.2). Its transports are those bound with the current spawn's handle. Its label is fixed for the server run, and its display kind is always `Tandem's Claude`.

### 3.3 Binding a child run

**Problem.** The child's setup entry is direct-HTTP, so its transport carries no header (probe 3). What reaches the child on every turn is the supervisor's stdin prompt.

**Rule.**
- Each spawn mints a handle. Three builders **wrap** `SUPERVISOR_INITIAL_PROMPT`, `SUPERVISOR_GREETING_PROMPT` and `SUPERVISOR_WAKE_PROMPT` (`src/shared/launcher/contract.ts:741`, `:760`, `:819`; the constants stay, and are what the builders return while dark), prefixing: *"Your Tandem owner handle for this run is `th_…`. Start this turn with `tandem_checkInbox` (or `tandem_status`) and pass it as `ownerHandle`, on each Tandem server you use."* The builders take an optional handle and the supervisor decides whether to pass one; nothing in `src/shared/launcher` imports the flag. Handle guidance lives **only** in these stdin prompts: no refusal and no inbox summary tells a session to look for a handle. The no-unasked-work clause stays.
- `ownerHandle` is an optional argument on four entry tools: `tandem_status`, `tandem_open`, `tandem_scratchpad`, `tandem_checkInbox`.
- **Bind check.** The handle is the current spawn's, and the presenting transport carries no `X-Claude-Session-Id` or carries the current run's id (`currentSessionId`, `src/server/launcher/supervisor.ts:1998`; probe 1 shows a resumed child keeps it). Any number of such transports may bind: a child with two toolsets binds each.
- **Outcomes.** The current handle on a transport already bound to it: a no-op success (every turn repeats the handle). A fresh transport: re-pointed to `tandem`; if its prior record is a never-bound single-transport record that already holds documents (the child opened something before binding), those move to `tandem` (v4.1 §5.10's absorb) — as `default` if present, else to the default rule. A prior record that holds documents and is anything else, or a transport with a document operation in flight → `OWNER_HANDLE_CONFLICT`, no side effects. An unknown, stale or malformed handle → `INVALID_OWNER_HANDLE`, no side effects; the message never echoes the value.
- **Every bind is logged, and Settings lists the transports bound to Tandem's Claude** by transport kind and whether each carried a header, so an unexpected one is visible.
- **Teardown.** When the run ends (`teardownTurnDelivery`, `supervisor.ts:2275`), the handle dies and every transport bound with it is re-pointed to a fresh empty `http` record. The `tandem` record keeps its documents: presence, not the run, decides what it holds.
- **An unbound child.** A refusal whose holder is Tandem's Claude ends with one conditional sentence: *"If your prompt gave you a Tandem owner handle (`th_…`), follow that prompt's instructions instead."* It never tells a session to search for a handle.
- **The greeting** is classified by "this transport presented the current handle" (§7.3), which holds from PR 3a even while the bind is inert (§16).

**If a later Claude Code build differs (probe 1).** If a resumed child got a new `CLAUDE_CODE_SESSION_ID`, the header half of the bind check would refuse a resumed bridge-entry child. The fallback is to accept any header on a handle bind.

### 3.4 When a client goes away

**Problem.** A dead terminal's documents should come back promptly, but a live client must not lose them to a blip.

**Rule.** A non-`tandem` record is **attached** while one of its transports is registered and, if any of its transports has ever held a `GET /mcp` stream, one such stream is open. When it stops being attached a 2-minute grace starts (v4.1 §5.8). A reopened stream, a new transport for the record, or any request on one of its transports ends the grace. At expiry the record **lapses**: each of its documents goes to the default rule through `setDocOwner` (§4.3), and its chat follows (§7.2). A lapsed record whose transport is still registered keeps its label and holds nothing; it may claim again like anyone (a lapse records no blocking loss, §5.3).

**Mechanism.** The registry counts open streams per entry (`openStreams`, `transport-registry.ts:83`) and fires `onEvicted` on `lru | idle | explicit` closes (`:100`). The ownership module listens to both.

**Bounds** (probe 3): a Claude Code terminal that exits or crashes closes its stream with the process, so its documents return about 2 minutes later. A client that never holds a stream is noticed only by the idle reaper: 30 minutes of idleness (`transport-registry.ts:290`), up to the 5-minute reap interval, then the grace — about 37 minutes at most. The stale-owner hint (§10.2) shows the gap and Assign closes it. An `http` record is its `Mcp-Session-Id`: a direct-HTTP terminal evicted by the 16-session cap, which any local process can force, re-initializes as a new record and its old one lapses (§15).

**If a later build differs (probe 3).** Without a held stream, Claude Code terminals fall into the reaper bound. Nothing else changes.

### 3.5 Stateless clients (MCP `2026-07-28`)

In probes 3 and 4, Claude Code sent `server/discover` (protocol `2026-07-28`) before `initialize`: it tries the stateless era first and falls back. Tandem serves only the legacy branch (ADR-045 amendment), so every caller still gets a transport. Ownership keys on the **record**; only rule 3 derives one from `Mcp-Session-Id` (§3.1). When Tandem adds the stateless branch, that work must give a stateless caller a record, or it holds nothing (§15).

## 4. Ownership

### 4.1 Kinds

| Kind | Holder | How it arises | A starting Tandem's Claude run | Another session's `tandem_open` |
|---|---|---|---|---|
| `default` | Tandem's Claude only | The default rule while present: Bryan's opens, restores, `welcome.md`, his scratchpads; documents Tandem's Claude opens, writes or posts on while present; take-back; documents returning to it | (its own) | takes it → `opened` |
| `claimed` | A non-`tandem` record | It was handed the document's work, or wrote or posted to it, while the document was unowned | takes it back → `default` | takes it → `opened` (its holder too) |
| `opened` | A non-`tandem` record | Its `tandem_open` of a closed file, or its take of an unowned, `default` or `claimed` document | not taken | refused |
| `assigned` | Any record | Bryan's Assign | not taken | refused |

### 4.2 Transitions

| Event | Result |
|---|---|
| Bryan opens a document (`POST /api/open`, upload, file association, startup restore, `welcome.md`, a scratchpad he creates) | Default rule |
| Tandem's Claude's `tandem_open` or `tandem_scratchpad` | While present: `default`, refused on an `opened` or `assigned` document held by another record. While not present: the document stays or opens unowned |
| Another session's `tandem_open` of a closed file, or `tandem_scratchpad` | `opened` by it |
| Another session's `tandem_open` of an open document | Unowned, `default` or `claimed` → `opened` by it; `opened` or `assigned` held by someone else → refused; its own `opened` or `assigned` → unchanged |
| A write, a post, or an inbox poll that hands items, on an unowned document | Claimed: `default` for a present Tandem's Claude, `claimed` for anyone else. Nobody claims while it holds a blocking loss record for that document (§5.3). A Tandem's Claude that is not present never claims: its writes and posts there are refused (`reason: "not-present"`) and its polls read nothing |
| A Tandem's Claude run **starts** (§8.2) | Every unowned and every `claimed` document → `default` |
| Tandem's Claude becomes present without a start (Off→On, Configure) | Every **unowned** document → `default`; `claimed` documents still wait for a run start (decision 2). A call made in v5, reversing the plan's "Off→On moves no documents" (§14 item 6) |
| Tandem's Claude stops being present | Every document it holds (`default` or `assigned`) → unowned, and its doc-less chat follows (§7.2) |
| A record lapses (§3.4) | Each of its documents → default rule |
| Release | Default rule |
| Assign to record R | `assigned` to R |
| Bryan closes the tab | The entry is removed after the handover (§6.3); unanswered chat on it gets a per-message owner (§7.2) |
| Server restart | Everything is forgotten; Tandem's Claude is not present until its first start this run (decision 11), so restored documents start unowned |

A read, list-mode `tandem_restoreBackup` and `tandem_exportAnnotations` never claim (v4.1 §3.7).

### 4.3 One composite for every change

Every change goes through `setDocOwner(documentId, next | null, kind, cause, caller)`. It runs at its turn in the document's operation queue (§5.1), with two synchronous exceptions: the tab-close point, and the inbox's commit step applying a claim (§6.2), both of which run with no `await` between their check and their write. In order:

1. if the previous owner was a record other than `next`, run the **handover** (§6.3) and record the loss on that record (§5.3);
2. update `ownerByDoc`, stamping `since` and `sinceSeq`;
3. queue a change notice for both records, drained by their next poll (§6.6);
4. publish through `broadcastOpenDocs` (`src/server/documents/registry.ts:162`), never an ad-hoc broadcast;
5. **wake or start** the new owner if it has waiting items there (§4.4).

The same step 5 runs whenever a chat message's owner changes on its own (§7.2).

### 4.4 Waking or starting the new owner

If the new owner has **waiting** items (§8.5): for Tandem's Claude, call the supervisor's `startOrWake` seam (§8.4); for any other record, send the `ownership` frames (§8.6). Skipped when `caller` is the new owner (its own poll, write or take) and for take-back, which has its own wake rule (§8.2). If a document or message becomes unowned with items waiting, send the unscoped `ownership` frame so an attached terminal can pick it up. Holding with nothing waiting wakes nobody (R4.4). Until PR 3b, `startOrWake` is a no-op stub.

**Lock order.** `setDocOwner` never awaits the supervisor's operation lock: `startOrWake` is fire-and-forget. The supervisor never awaits a document queue: take-back and the presence-loss sweep enqueue their `setDocOwner` calls and return. So the two locks have no wait cycle.

## 5. Enforcement

### 5.1 The operation queue and refusal placement

v4.1 §3.4a is kept, flag-on only: every MCP mutation and every ownership change on a document runs through a per-document serial queue, and the ownership check is the first thing inside the operation, using the `ownerId` passed in (§3.1); a test interleaves two records' operations on one document to pin it. Refusals decided by the arguments or by facts fixed at open (`LICENSE_REQUIRED`, `NO_DOCUMENT`, `DOCUMENT_REQUIRED`, `INVALID_ARGUMENT`, `INVALID_PATH`, `READ_ONLY`, extension-decided `FORMAT_ERROR`, handle errors) run before the queue and never claim. Refusals decided by live content, the disk or the save lock (`INVALID_RANGE`, `RANGE_MOVED`, `SAVE_IN_PROGRESS`, `EXTERNAL_CONFLICT`, serializer `FORMAT_ERROR`, I/O) run inside and keep the claim. Browser edits and the reload family stay outside the queue. PR 1c re-derives v4.1's line numbers, which are stale. **Flag off, there is no queue:** handlers run their bodies directly, as today, pinned by a flag-off interleaving test.

**Which tools are checked.** Every tool falls in exactly one row; PR 1c pins the table against the registered tool list, so a new tool fails the test until it is placed.

| Mode | Tools | Non-owner outcome |
|---|---|---|
| Write (checked in the queue; claims an unowned document) | `tandem_edit`, `tandem_appendContent`, `tandem_editList`, `tandem_applyChanges`, `tandem_restoreBackup` (restore mode), `tandem_save`, `tandem_rename`, `tandem_close`, `tandem_convertToMarkdown`, `tandem_comment` (and the deprecated `flag` / `suggest` stubs), `tandem_resolveAnnotation`, `tandem_removeAnnotation`, `tandem_editAnnotation`, `tandem_annotationReply` | `NOT_DOC_OWNER` with the holder's copy. A non-owner `tandem_close` is refused like any write, so closing and reopening is never a way around `opened` or `assigned` |
| Take | `tandem_open` (including `force`), `tandem_scratchpad` | §4.2's take rule |
| Reply | `tandem_reply` (and `/api/channel-reply`) | §7.3; on an open document it runs in the document's queue like a write |
| Owner-only, never claims | `tandem_switchDocument` | §5.6 |
| Read (open, never claims) | `tandem_getTextContent`, `tandem_getOutline`, `tandem_getContext`, `tandem_getAnnotations`, `tandem_listDocuments`, `tandem_search`, `tandem_resolveRange`, `tandem_getActivity`, `tandem_exportAnnotations`, `tandem_restoreBackup` (list mode), `tandem_diagnostics`, read-mode `tandem_status`, `tandem_checkInbox` (scoped, §6) | — |
| Write-mode `tandem_status` | `text`, `focusParagraph` | §5.2 |

On a document held by someone else, `NOT_DOC_OWNER` is answered before any lifecycle refusal, including #2360's `NOT_OWNED`. Whichever of PR 1c and #2360's lifecycle change lands second rebases through the lifecycle's refusal order.

### 5.2 Which document a call means (R4.1)

**Problem.** Retiring the active-tab default would break single-document scripts, and retargeting a range-keyed write to a document other than the one just read would apply its offsets to the wrong text.

**Rule.**
- **Reads** keep today's active-tab default (`getCurrentDoc`, `registry.ts:348`).
- **Range-keyed writes** without `documentId` target the active document, as today. If the caller does not hold it and cannot claim it → `NOT_DOC_OWNER`. They never retarget.
- **Replies** follow §7.3.
- **The four id-keyed annotation tools** resolve the document by annotation id first (#2187), then check ownership (R2.2).
- `DOCUMENT_REQUIRED`, where a call cannot resolve a document at all, carries the caller's held document ids and the remedy "pass `documentId`".
- **Write-mode `tandem_status`** (`text`, `focusParagraph`): the status text stays global free text, as today (an exception to §10.3's "no session text", recorded in §15). A `focusParagraph` on a document the caller does not hold is ignored, not refused.

### 5.3 Refusal copy (R4.2, R3.6)

One error code, `NOT_DOC_OWNER`, with `details: {reason, documentId, holder: {label, displayKind} | null}`. The holder is server-rendered from its record kind (§10.3) and is always the target document's or message's **real** holder. Each message carries its remedy, because older skills stay in use after the flip. When several rows apply, the first wins: the operation-specific rows come first.

| `reason` | When | Message (shape) |
|---|---|---|
| `switch` | `tandem_switchDocument` on a document another record holds | "{holder} has this document. Ask the user to click its tab; do not `tandem_open` it just to show it." |
| `chat` | A reply to a message owned by someone else | "{holder} answers this message. Do not reply to it." |
| `post` | A post with no document the caller may not make (§7.3) | "{holder} answers chat that is not about a document. (With no holder, this sentence is left out.) Reply with `replyTo` to a message you were handed, or pass the `documentId` of a document you hold. If the user asked you in your own conversation to say this, tell them there." |
| `answered` | The item already has another answerer (§5.5) | "{holder} already answered this. Do not answer it again." It carries no handle sentence. |
| `lost` | The caller lost this document and holds a blocking loss record for it | Cause `released`: "This document was released from you. You can still read it. Do not `tandem_open` it again unless the user asks you again after this point." Cause `taken back` (a starting run, or Tandem's Claude's own `tandem_open`): the same, with "Tandem's Claude took this document back". Cause `assigned` or `taken` (the new holder's kind is `assigned` or `opened`): "{holder} has this document now. Only the user can reassign it, from the owner badge on its tab. Do not retry." |
| `held` | `opened` or `assigned` by another record | "{holder} is working on this document. Only the user can reassign it, from the owner badge on its tab. Unless {holder} is your other Tandem toolset, do not retry." |
| `claimed` | `claimed` by another record | "{holder} picked this document up while Tandem's Claude was away. Call `tandem_open` on it only if the user asked you, in your own conversation, to work on it." |
| `default` — on a reply, thread answer or post | The document is Tandem's Claude's `default` | "Tandem's Claude answers this document's comments and chat. Do not answer this, and do not take the document because of it. If the user asked you in your own conversation to say something here, call `tandem_open` on it first." |
| `default` — on an edit, comment or other write | Same | "Tandem's Claude is answering this document. Call `tandem_open` on it only if the user asked you, in your own conversation, to work on it. An item Tandem pushed to you is not such a request." |
| `not-present` | Tandem's Claude, while not present, writing or posting to an unowned document | "Tandem's Claude is turned off or stopped, so it holds no documents now. Leave this document." |
| `unlinked` | `/api/channel-reply` from a shim the server cannot match to a record (§9.2) | "This reply could not be matched to your Tandem session. Send it with the `tandem` server's `tandem_reply` tool instead." |

Every message whose holder is Tandem's Claude, except `answered`, ends with §3.3's conditional handle sentence; `held`, `claimed`, `switch` and `chat` messages whose holder is a terminal end with §3.1's two-toolsets clause. No copy names the developer: it says "the user". A recipient that **is** Tandem's Claude gets, for `lost`: "A session the user is working with has this document now; leave it."

**Loss records.** A record keeps, per document it lost this run, the cause and the new holder, until that document changes owner again. Causes `released`, `taken back`, `assigned` and `taken` are **blocking**: while one stands, the record cannot implicitly claim the document (a write, a post or a poll), and its polls do not read it even when it is unowned; `tandem_open` still takes it under §4.2, and the copy above says when. This makes Release last while Tandem's Claude is not present. A lapse records nothing blocking. The `tandem` record gets no loss record when it stops being present.

### 5.4 `tandem_open`

The take rule is §4.2's, inside the operation queue: a take of a `default` document whose holder is mid-operation waits its turn, then takes it, and the holder's next operation meets `lost`. **Activation is today's** (`src/server/documents/open.ts:773-803`): every `tandem_open` brings its document's tab to the front, fresh or already open. A take never wakes the taker (§4.4).

### 5.5 One answer per item (R1.5)

**Problem.** Decision 3 lets a session that was pushed an item take the document after the item was answered, and then answer again. Ownership alone cannot stop that, because the new owner is the owner.

**Rule.** The first record whose **final** answer to an item is accepted becomes its answerer, if none is set. A later answer is accepted only from the answerer. An `inProgress` acknowledgement is not an answer: it neither sets the answerer nor makes the item handled, and the same record's final reply that follows is accepted.

**Mechanism.** An in-memory `answerer: Map<itemKey, ownerId>` in the ownership module, written only if unset:
- **Comments and thread replies.** The item is the thread's latest user entry (the comment at its current `editedAt`, or the latest user reply). A final Claude reply on the thread (`tandem_annotationReply`, or #2360's thread reply) by X sets the answerer to X. A reply by Y ≠ X while the latest user entry is answered by X → `NOT_DOC_OWNER`, `reason: "answered"`. A new user reply or an edit makes a new item. #2360 must give an in-thread acknowledgement an `inProgress` marker, or such an acknowledgement would count as the answer (§14).
- **Chat.** The item is the message named by `replyTo`. Today's batch rule (`answeredBy`, `src/server/mcp/awareness.ts:1554`) also settles earlier messages *any* model received. **Under the flag that global received-sweep in `answeredChatIds` is removed**, replaced by the scoped `settles` below: otherwise one owner's reply settles another owner's received message, which then leaves every inbox unanswered and is never re-owed (it reads as handled). Under the flag the batch is persisted on the reply row (`settles: [messageId]`, server-stamped with `withMcp`) in two steps, so it never trusts a hand-out that may not have arrived (a reply can follow a push of its target alone): when the reply is accepted, `settles` holds the earlier messages already marked received; when a later poll's `confirmHandOut` marks a hand-out received, the commit of that poll adds to the `settles` of every reply row whose target was in that hand-out the earlier messages of the same hand-out. In both steps only messages in the replier's scope at that moment are added, and each takes the replier as answerer if unset. So the normal flow — poll, reply to the latest, next poll — settles the batch at the next poll, as today. The handled filter reads `replyTo` plus `settles` from persisted rows (§6.4). A message settled in persisted state with no recorded answerer exists only after a restart; its current owner's reply is then accepted (decision 8).
- **A post** (no `replyTo`) answers nothing, so this rule cannot see it (§15).

### 5.6 `tandem_switchDocument`

It brings a document's tab to the front and never claims. Under the flag it is owner-only where an owner exists: refused on a document another record holds, with the `switch` copy, which tells the model to ask the user rather than take the document. On an unowned document, and on the caller's own, it works as today.

### 5.7 Reads and labels

Reads are open. `tandem_getAnnotations` and `tandem_listDocuments` label each document with `owner: {label, displayKind, kind, you}` (or `null`). `tandem_status` returns the caller's own label, display kind and held document ids, so Bryan can ask a session which one it is.

## 6. The inbox under cursors

### 6.1 What the inbox is today

`tandem_checkInbox` keeps no per-reader state. One process-wide registry gives every returned item version a sequence number the first time any poll returns it (`src/server/mcp/inbox-cursor.ts:10-12`); each reader's position is a mark per scope inside the opaque cursor it passes back (`inbox-cursor.ts:22-31`). A fresh reader counts as seen whatever some reader acknowledged (`seenBy`, `inbox-cursor.ts:107-110`). Default polls read every open document (`collectInboxDocuments`, `awareness.ts:1152`) and skip quiet background documents (`awareness.ts:1227-1237`). Chat is one scope read on every poll, and a message answered by a `replyTo` reply is skipped for every reader (`awareness.ts:1621`). Cursor-less (legacy) polls keep the process-wide `surfacedIds` / `replySurfacedIds` ledgers (`legacyLedgers`, `awareness.ts:861`). The registry already has the primitive this design needs: `retire` (`inbox-cursor.ts:308`) makes an item version owed again to **every** reader, fresh or not.

### 6.2 Scope, acknowledgement and claims (R1.1, R4.6)

**Rule.** A poll by record X reads:
- documents X holds;
- unowned documents X may claim now — not one it holds a blocking loss record for (§5.3), none at all if X is a Tandem's Claude that is not present, and only while the document's queue is idle;
- chat messages whose owner (§7.1) is X, or which X may claim.

Anything else is **not read**: it is left out of `collectInboxDocuments`'s order and out of the chat pass. This is exclusion, not an `admit` refusal, so nothing is logged as dropped and no "malformed" text appears. A named poll of such a document returns no items and lists it in `ownership.notYours`.

**An excluded document is treated as read with nothing handed:** on a default poll it is added to the pass's read documents with an empty held set (the quiet-skip pattern, `awareness.ts:1235`), so `nextCursor` moves its mark to the counter and never lists it (R4.6); a named poll leaves other documents' positions as today. This is safe because whatever the mark passed was registered for another owner, and when that ownership moves the handover retires every such entry the new owner could still be owed (§6.3).

**Acknowledgement is scoped.** `acknowledgeCursor` (`awareness.ts:1674`) runs before collection; it acknowledges entries for the fresh-reader floor and stamps chat `read`. Under the flag it does both only for documents and messages in the caller's scope as it stands when the poll begins. A reader's mark passing another owner's entries therefore never hides them from a fresh reader, and never stamps another owner's chat read. The handler reads the caller's record to choose scope; nothing is written into the cursor (R3.7).

**Claims.** Whether a document or message is claimable is decided as the pass reads it. One that yields items is claimed: the claim (`setDocOwner`, or the message's per-message owner) is applied in the handler's commit step (`awareness.ts:1995-2021`), after the response validates, in the same synchronous run (the contract is stated at `awareness.ts:1852-1866`). A document claimed through both its items and its chat in one poll is claimed once. If validation fails, nothing is claimed and the registry entries the pass created are retired, so they hide nothing from the next reader.

**Cost (R4.6).** An excluded document costs no collection and no cursor space, and foreign items never enter a reader's held lists. 300 pending items, or 300 open documents, held by another owner add nothing to a reader's cursor and nothing to its work beyond enumerating open documents.

### 6.3 Handover (R1.2, R2.1, R2.6, R4.5)

**Problem.** The old owner may have acknowledged items it never answered, so a fresh next owner would count them as seen; and the next owner's mark may already have passed them. Either way the item would be lost.

**Rule.** Whenever document D's owner changes away from a record X — to another record, to unowned, or by a tab close while X holds it — every item on D that X could have been handed and that is answerable and not handled is owed again to every reader. Handled items, and notices the old owner was handed, stay settled. A claim of an unowned document needs no handover: nobody else could have been handed its items (§6.2).

**Mechanism**, one synchronous step at the start of `setDocOwner`:
1. **Retire** every live registry entry in D's scope whose item the inbox would hand to *some* reader — the status, audience and thread-visibility tests of the `userActions` and `userReplies` buckets (`awareness.ts:2207-2320`, `:2433-2471`), but **not** the mode: in Solo the gate hides every user record, and the handover must still re-owe them for when Solo lifts — and that is not handled (§6.4). Delete the same items' keys from `surfacedIds` and `replySurfacedIds` for cursor-less readers. A retired item gets a new sequence number above every mark when it is next returned. Retiring moves no content, so R3.1 is unaffected.
2. **Advance D's `handoverSeq`**, kept in a per-document side map that outlives ownership entries (through an unowned spell and a close and reopen) for the server run: set it to the registry's counter at this moment. It is written only when ownership leaves a record, never on a claim of an unowned document, so a claiming poll's own entries are never below it. A notice (accept or dismiss) whose entry's sequence number is at or below D's `handoverSeq` was handed to an earlier owner, and is handed to nobody again. A notice with no entry goes to whoever holds D next. The current owner's own retries with an old cursor still get its notices, because those registered after `handoverSeq` (the #2294 lost-response contract holds).
3. **Bump the quiet epoch** of D (`quietDocState`, `awareness.ts:809`), so no reader skips D on a stale quiet record (R4.5).
4. **Chat** on D follows §6.5.

A tab close runs steps 1 to 3; reopening D starts from the default rule with nothing on it marked seen that its new owner could be owed, and no notice the old owner was handed.

### 6.4 The handled filter

**Rule.** Under the flag, on cursor and legacy polls alike (the legacy chat path, `collectUnreadChat` at `awareness.ts:1471`, gains the check it lacks today), these are never handed to anyone:
- a user comment at a given `editedAt` with a later **final** Claude reply on its thread;
- a user thread reply with a later final Claude reply on the thread;
- a chat message named by a final reply's `replyTo` or listed in its `settles` (§5.5); `inProgress` rows and `superseded` rows (§6.5) count for nothing;
- a notice at or below its document's `handoverSeq` (§6.3). `carryHeld` (`awareness.ts:999-1039`) treats such an entry as neither held nor retired, and marks it acknowledged, so the filter's own exclusion never retires the entry the rule depends on (otherwise the notice would come back with no entry on the next poll).

"Later" compares the server's own timestamps where both sides have one. The first three judge from persisted state, so they cover an answer given from a **push** before any poll registered the item (R1.2), and they hold across a restart. A `settles` list, a `superseded` flag or a Claude-authored reply counts only when the server's own origin wrote it: the same fields arriving from a Hocuspocus `Connection` (any editor client) are stripped by the server and ignored by the filter, so a client cannot hide an item from every inbox. For a single session the visible change is a fix: an item a lone session answered from a push is not handed to it again.

**Old skills.** Today's skill answers user comments in chat (`skills/tandem/SKILL.md:59`, `:65`), because #2360's thread reply does not exist yet. A comment answered only in chat is not handled by this filter, so after a handover the next owner is handed it and may answer it again, and it counts as waiting. The skill ships at the plugin's pinned ref, so the flip release bumps the plugin ref together with the new skill (§14).

### 6.5 The chat half of a handover

**Problem.** Chat is one global scope, and a message with no registry entry is owed only while unread (`awareness.ts:1622-1627`).

**Rule.** Whenever a message's owner changes away from a record — its document's owner changes away from X; its per-message owner lapses or stops being present (§7.2); Bryan releases or assigns the message (§10.1); or the close-derived messages move with their document (§7.2) — and the message is not handled:
1. retire its chat entry (`retire`);
2. in one `withInternal` transaction on `Y_MAP_CHAT` (Critical Rule 2; the chat observer emits `chat:message` only for browser-origin writes, so no event fires): set `read: false`, delete `delivered` (the field is `delivered?: true`), and set `superseded: true` on every `inProgress` row replying to it;
3. run §4.4 for the message's new owner.

`superseded` is a new field. The handled filter ignores a superseded row, and the editor's pickup row (`src/client/panels/chat-pickup.ts`) leaves superseded rows out of both its acknowledgements and its replies, so it reads "waiting" rather than "working". Under the flag the pickup and stall clock counts from the message's last change of owner (its arrival, if it never had one), the same clock as §10.2's stale flag, so a handover does not show an old message as instantly stalled.

### 6.6 What the response says about ownership

`tandem_checkInbox` gains `ownership: {holding: [documentId], notYours: [documentId], changed: [{documentId, change: "gained" | "lost", cause}]}`. `holding` is computed per poll; `changed` drains the record's change notices (§4.3 step 3). Loss records (§5.3) are separate and outlive the drain. Nothing here is read from or written into the cursor.

### 6.7 Delivery rounds

`pendingSince` (`src/server/events/delivery-state.ts:86`) is one global round, closed by any poll; under ownership a terminal's poll would close a round Tandem's Claude has not seen. Under the flag, rounds are keyed by document for document items and by message for chat. A poll closes the rounds of the documents it read and of the messages it handed out or that are now handled; a document's rounds are dropped when it closes, and a message's when chat is cleared. `/health` keeps reporting one aggregate (the oldest open round's age), never a document id or a per-document breakdown.

### 6.8 The cursor pin (R3.7)

`tests/server/inbox-cursor.test.ts:1060-1078` pins that the cursor module and the inbox handler import no transport or session identity. It is amended to: `inbox-cursor.ts` imports nothing from the ownership module; the inbox handler may import the caller resolution and the scope predicate from it and nothing else; and a new test shows that two records with the same position and the same holdings receive byte-identical cursors.

## 7. Chat ownership and replies

### 7.1 Who owns a message (R1.4)

| Message | Owner |
|---|---|
| Has a per-message owner (§7.2) | That owner, even if its document is open again |
| On an open document D, no per-message owner | D's owner; if D is unowned, claimable with D (§6.2) |
| Doc-less, or on a closed document, no per-message owner | Tandem's Claude while present; else claimable |

A claimable message gets an owner when a poll hands it (its document's claim if it has an open one, else a per-message owner, applied at commit) or when a record's reply to it is accepted — an `inProgress` acknowledgement included, which sets the owner but not the answerer (§5.5) — whichever comes first. So two terminals pushed the same message cannot both acknowledge and work on it. A reply or post on an open document runs in that document's operation queue like a write (§5.1), so its ownership check and its claim happen at one turn and two sessions cannot both claim the same document; a reply to a claimable message on an open, unowned document claims the **document**, not a per-message owner. Claiming a doc-less message is a check-and-set with no `await` between the check and the write. A per-message owner keeps its message until it lapses (§7.2); a session that acknowledged and then stalled is handled by Bryan's control on the message (§10.2), not by a timer. So at any moment exactly one record may answer it, or none is set and the first accepted answer sets it. A per-message owner keeps its message when Tandem's Claude becomes present (the plan's call).

### 7.2 Successors (R2.3)

- When Bryan closes D, each unanswered chat message on D gets a per-message owner: D's owner at that moment; or, if D was unowned, Tandem's Claude if present; otherwise none. Reopening D does not move them.
- When a per-message owner lapses, each of its unanswered messages loses that owner and follows the table again, with §6.5.
- When Tandem's Claude stops being present, every unanswered message it owned — by a per-message owner or by being present — follows the table again, with §6.5.

- Once D is open again, Bryan's Assign or Release of D also moves the unanswered messages whose per-message owner came from D's close. Any per-message-owned message can also be released from its pickup row (§10.2).
- When Tandem's Claude becomes present without a start (Off→On), a waiting doc-less message with no per-message owner becomes its by derivation, and this runs §4.4 like any other change of a message's owner: `startOrWake` starts it for that message. Unowned documents become `default` at the same moment (§4.2); `claimed` ones do not move.

A document's change of owner moves only the chat that follows that document, never the old owner's doc-less chat. Every change here runs §4.4, so a message that returns to an idle Tandem's Claude starts it.

### 7.3 Reply acceptance (R2.2)

`tandem_reply({text, replyTo?, documentId?, inProgress?})`:
1. **With `replyTo`.** The message's owner decides (§7.1). A claimable message is claimed by the accepted reply. Then §5.5's answered-once check. An explicit `documentId` that contradicts the message's → `INVALID_ARGUMENT`.
2. **Without `replyTo`, a post.**
   - With an explicit `documentId`: accepted when the caller holds the document, or when it is unowned and the caller may claim it, in which case the post **claims** it, like a write. Otherwise refused with the holder's copy (`held`, `claimed` or `default`).
   - Without one: stamped with the active document only if the caller already holds it. Otherwise it is a **doc-less** post (it never claims the active tab Bryan happens to be on): accepted from the doc-less chat owner (Tandem's Claude while present; any record other than a not-present Tandem's Claude while it is not present); otherwise `post`.

A post answers nothing; claiming is what keeps two sessions from both posting about the same unowned document.

**The first-run greeting** (#2193) is Tandem's Claude's post, accepted under rule 2 either on a document it holds or doc-less. The greeting classifier (`isGreetingReply`, and the supervisor's own-child checks at `supervisor.ts:1270` and `:1310`) keys today on the reply's session header and treats a reply with no header as possibly the child's. Under the flag it keys on the calling transport having presented the current spawn's handle, on the MCP path only; a `/api/channel-reply` reply is never the greeting. This lands in PR 3a with the handle, and works there although the bind itself is inert until 3b.

## 8. Tandem's Claude: presence, take-back, starting, waking

### 8.1 Presence (R4.3, decision 11)

**Rule.** Tandem's Claude is present when all of these hold, read from the supervisor's own fields:
- `startedThisRun` (new in PR 3b): a spawn has reached the post-spawn point this server run (`supervisor.ts:1985-1998`);
- `configured === true` (a tri-state today);
- its in-memory `standby` is not `"off"` (`supervisor.ts:1069`) — the supervisor's live state, not the saved `lastGoodSettings.startMode`, which can disagree when saving Off fails;
- `breakerTripped` is false;
- `lastError` is unset, or a restart is underway: `restartTimer` is set or `launching > 0`. Today's `lastError` values are `needs-login`, `unlicensed`, `cli-unusable`, `binary-not-found`, `spawn-failed`, `stop-failed`, `circuit-open` and `wake-delivery-failed`; any of them with no restart underway is staying down. A new value counts as staying down; an exhaustive-switch test makes adding one a decision.

It keeps its documents through idle-stop, resume, crash-resume and relaunch (decision 7).

**Announcer.** These fields are written in about thirty places, some outside the operation lock (the exit handler, the stream parser's sign-in trip, restart scheduling), and several transitions write two in sequence (an error, then `scheduleRestart`). PR 3b routes every write through setters that mark presence dirty; presence is recomputed once, after the current synchronous run of writes (a queued microtask).
- Becoming **present** is announced at once, and at the post-spawn point it is announced synchronously, before take-back runs.
- Becoming not present because Bryan turned it Off (`standby` becomes `"off"`) is announced at once.
- Becoming not present through an error, or through `configured` becoming false (recomputed from `integrations.json` on every plan build, `supervisor.ts:1869-1870`, so a bad read can flip it), is announced only if it still holds 5 seconds later, so a crash-resume that briefly reads as down never sweeps documents away.

The ownership module reads the last announced value, with one exception: the arm ownership **widens** — the `ignoreOtherAi` bit (§8.3), `startOrWake` (§8.4), and every start reason today's `isStartWorthy` would refuse — re-checks the live `standby !== "off"` (§8.4 step 2), so the new start reasons never start a Claude Bryan just turned off. Today's arm is untouched: a chat (or a user reply on Claude's thread) still starts Tandem's Claude from Off and saves the mode as on-click, as `tests/server/launcher/supervisor-turn-delivery.test.ts:2443` pins. `status()` is not a transition: its `cli-unusable` lapse (`supervisor.ts:3412-3418`) clears the error without recomputing, and presence follows at the next transition.

### 8.2 Take-back (decision 2)

**Rule.** A run **starts** at the post-spawn point — where `startedThisRun` is set and presence is announced — **before** the spawn decides which turn to write (`supervisor.ts:2365-2400`, the same synchronous stretch). Take-back runs there: every unowned and every `claimed` document becomes `default`, each through `setDocOwner`. The same point also runs §6.3's retire step over the documents Tandem's Claude already holds, and §6.5 over the unanswered chat it owns, so a new run (often with a fresh cursor) is owed the previous run's handed-but-unanswered items; if any are waiting, this sets the owed wake the same way take-back does. The cost is duplicates of unanswered items only (§15). `opened` and `assigned` documents stay. Take-back is never itself a start trigger: it happens because a run started. A spawn that dies on arrival has still started a run; the next spawn's take-back finds nothing left to take.

**Its wake.** Take-back computes waiting synchronously, before it enqueues its `setDocOwner` calls. If any taken-back document has items waiting, it sets `wakeOwedAcrossSpawns`, which the **same** spawn then consumes when it decides its turn: a fresh spawn's bootstrap or greeting turn covers it (`:2373`, `:2386`), and a resumed spawn sends its wake (`:2395-2399`). A take-back `setDocOwner` that runs later (its document's queue was busy) and finds items waiting with a child running calls `requestWake()`, every time; the wake coalesces, so the cost is at most one payload-free turn.

**Sign-in loops.** A child that is not signed in still reaches the post-spawn point, so each Check again starts a run that takes back `claimed` documents, then trips `needs-login`, and 5 seconds later the presence-loss sweep returns them to unowned. That churn is bounded by Bryan's clicks (§15).

A run started by a chat while Off follows the 2026-10-13 behaviour (the mode becomes on-click; `tests/server/launcher/supervisor-turn-delivery.test.ts:2443`) and is a run start like any other. Take-back's queued `setDocOwner` re-checks the document's kind at its turn, so a `tandem_open` queued ahead of it (now `opened`) is not overridden.

### 8.3 Start rules (R2.4, decision 10)

**Rule.** A present Tandem's Claude that is not running starts, whether or not another AI is on, for:
- on a document it holds: a user chat message, a new user comment (`annotation:created` of a user comment, with or without a suggestion), or any user thread reply;
- a doc-less or closed-document chat message it owns.

An event on a document held by another attached record starts nothing. Everything else is today's rule: `isStartWorthy` (`src/shared/events/wake-scope.ts:57`) and "not if another AI is on", including for a document whose holder is in its grace; such a start takes back that document if it is `claimed`.

**Leaving Solo.** The Solo→Tandem release wake carries no document. When it fires, the supervisor asks the ownership module whether any document Tandem's Claude holds has items waiting, and if so calls `startOrWake` (§8.4), so the Off check applies.

**Mechanism.** The standby watch callback (`supervisor.ts:1410`) asks the ownership module `startWorthyFor(event)` → `{start, ignoreOtherAi}`. A burst of events coalesces into one queued start (`messageStartQueued`, `:1414`), so `ignoreOtherAi` is OR-ed into supervisor state by each event the watch accepts. `startForMessage`'s re-check under the lock (`:1432`) reads it and clears it on every path; when the bit is what lets this start past "another AI is on", it also re-checks live `standby !== "off"` (§8.1); and its `finally` re-queues a start if the bit was set again meanwhile. The watch subscribes through `wasForwardedExternally` (`supervisor.ts:321`), so the Solo hold, `hideFromAI` and the licence refusal run before it sees an event (R3.1). `startsOnMessage` in `status()` keeps today's document-free value; the composer line (§10.2) is what promises a start for a specific document.

### 8.4 Starting or waking for returning work

**Rule.** When a document or chat message reaches Tandem's Claude with items **waiting** — by Assign, Release, a lapsed holder, or a message whose owner went away — it is woken if running, and otherwise started if present, whether or not another AI is on. At Off→On the unowned documents that become `default` (§4.2) and the doc-less messages it now owns (§7.2) go through this rule like any other returning work.

**Mechanism.** `startOrWake(cause)` is fire-and-forget and goes through the **same** single queued start as the standby watch: it sets a separate "start-or-wake owed" flag, ORs the "ignore other AI" bit, and sets the one queued-start flag (so the status reads Starting) unless it is already set. The locked step runs, in order:
1. a running child with turn delivery → `requestWake()` (§8.6), and done;
2. if the live `standby` is `"off"`, return here unless at least one event coalesced into this queued start passed **today's whole** watch rule (`isStartWorthy` and not "another AI is on", evaluated when the event was accepted). The watch records that ("today's-arm owed") only for an event it accepts into a queued start; the locked step reads and clears it with the bit, and the `finally` re-queues if either was set again meanwhile. So only today's chat-from-Off start survives an Off (`supervisor-turn-delivery.test.ts:2443`); the reasons ownership adds — `startOrWake`, the bit, a new comment or any thread reply on a held document — never start a Claude Bryan turned off. Tests queue a `startOrWake`, and separately a user comment, ahead of an Off, and assert no spawn and a saved mode still Off;
3. then re-check that something is still waiting, and `startForMessage`'s full guard (`supervisor.ts:1432`) — `shuttingDown`, `standby === undefined`, `breakerTripped`, `isAlive()` all still apply, and only `anotherAiOn()` is bypassed by the bit — and, if it passes, sets `wakeOwedAcrossSpawns` (after the guard, as `startForMessage` does today at `supervisor.ts:1436-1439`, so a chat queued before an Off still gets its wake turn on a resumed spawn, and no wake is owed for a start that is refused) and makes the same start `startForMessage` makes.

Within `startOrWake`, `wakeOwedAcrossSpawns` is set in exactly two places (take-back §8.2 and today's standby watch set it too): when step 3's guard passes, and when the guard fails **only** because a restart is pending (`standby === undefined` with a pending `restartTimer`, not Off, breaker not tripped), so a child that crashed between `startOrWake` and the locked step leaves the wake for its pending restart to send. A start refused for any other reason owes nothing. An unlocked restart already under way is never doubled, and nothing starts beside a tripped breaker. A pending `restartTimer` counts as "a start pending" everywhere the badge and composer ask (§10.2). The `finally` re-queues while the "start-or-wake owed" flag is set again.

### 8.5 Waiting

**Waiting** is computed by the inbox's own document collector with no cursor, after every privacy gate (the Solo hold, `hideFromAI`, the ADR-027 and withheld predicates; R3.1). It counts only answerable items — user comments, user thread replies and user chat, never accept or dismiss notices — that pass the handled filter (§6.4) and have not been handed to the current owner: no live registry entry above the document entry's `sinceSeq`; for chat, no live chat entry at all, since every change of a message's owner retires its entry (§6.5). So an item the owner already has, and answered in some other way, does not keep starting it. A Solo-held item is never waiting. Take-back (§8.2) counts what will be owed **after** the handover it is about to run: the losing record's handed-but-unanswered items count.

### 8.6 Waking a running owner (R2.7)

**Rule.** When work reaches a running owner (a lapsed holder's documents, Assign, Release, a message whose owner went away), that owner is woken. Holding with nothing waiting wakes nobody (R4.4).

**Mechanism.**
- **Tandem's Claude:** `requestWake()`, exposed by the current spawn's turn delivery, writes the wake prompt through the same coalescing as `onTandemEvent` (`supervisor.ts:2246`). It passes `aiRefusal()` first (R3.2).
- **Other records:** a payload-free `ownership` frame on `/api/wake`, and a payload-free `ownership-changed` event on every push stream, mapped or not (§9.1), so Assign, Release or a return also wakes a direct-HTTP terminal whose shim is unmapped. Before Phase 3 a wake socket is unscoped, so every armed session gets the frame, polls, and finds nothing unless it is the new owner.
- **Licence.** Neither frame enters `pushEvent`, so neither inherits its revocation. Each writer calls `aiRefusal()` before writing and, on a refusal, ends the socket (4403) or the stream exactly as the revocation does.
- **The inventory.** `tests/docs/ai-surface-inventory-claims.test.ts` gains derivations over these two writers and over every `sendTurn` caller, so a new path that skips the check fails the test (R3.2).
- Pull is the backstop: the change is in the next poll's `ownership.changed`.

### 8.7 A run that never binds (R2.5)

A child that never presents its handle runs as an ordinary `http` record. Its documents stay with the `tandem` record, so the inbox hands them to nobody, and their items stay waiting after it exits; the next start answers them. If every run fails to bind, the stale hint shows that Tandem's Claude has not polled since items arrived, and Bryan can Assign another session (§10.2, §15).

## 9. Push paths and the shim's identity

### 9.1 Narrowing the event stream (R3.4, decision 9)

**Problem.** The shim and the plugin monitor read `/api/events` with full content for every document. Both already send `X-Claude-Session-Id` (`authFetch` → `withClaudeSessionHeader`, `src/shared/cli-runtime.ts:157-160`, `:178`).

**Rule.** For each event, at the moment of writing it (live and on `Last-Event-ID` replay, `src/server/events/sse.ts:72-84`, `:97-108`; wake-mode `?filter=wake` streams included), the stream's header is mapped, in this order:
1. Tandem's Claude's session id: while a run is current, the `tandem` record, for reading only (it never maps a reply, §9.2); while none is, **unmapped**. This id never maps through rule 2;
2. a live `claude:<id>` record → that record;
3. anything else, or no header → **unmapped**, which gets exactly today's stream.

A mapped stream gets an event when its document is held by the record or unowned; a chat event when the message's owner (§7.1) is the record or the message is claimable; and every event with no document that is not chat (the Solo release wake, for example). Narrowing runs after the existing Solo filter and licence refusal, never before (R3.1). Mapping per event means a shim that connected before its bridge initialized becomes mapped once the record exists. A push never marks anything handled or delivered: notices and items reach their owner's inbox by its poll.

`ownership-changed` (§8.6) goes to unmapped streams too (it carries nothing, so it adds nothing to today's stream beyond a nudge). It is written as its own SSE event name, outside the `TandemEvent` union, with **no `id:` line and an empty `data: {}`**: an id missing from the buffer would make `replaySince` replay the whole buffer, and today's consumer parses `data` as an event, fails validation and logs one line per frame (`src/shared/sse-consumer.ts`), which PR 4 pins as the expected outcome for an older shim or monitor.

**Monitor terminals (probe 2).** A plugin monitor saw `CLAUDE_CODE_SESSION_ID` equal to its session's id, so its stream is mapped exactly when its terminal has a `claude:<id>` record (the plugin's bridge entry). *If a later build differs:* such monitors are unmapped and keep today's stream.

**Tracking is unchanged.** `pushEvent` marks an event pushed (`alreadyPushed`, the delivery round) before any stream's narrowing, so an event every mapped stream drops still reads as pushed. That is today's over-report, kept until Phase 3's reach-first ordering (§15).

### 9.2 `/api/channel-reply` (R1.3, R3.3)

**Rule.** After the body checks (`src/server/mcp/channel-routes.ts:124-133`) and before the greeting classifier and the append (`:137-145`), the route maps the header in §9.1's order and applies §7.3's acceptance and §5.5's answered-once check, passing the mapped record explicitly; the reply text gets the same live-handle check as tool arguments (§11.2):
- Tandem's Claude's session id → never accepted as Tandem's Claude, because the header is never enough to act as it (R3.3). Today's code expects the child's shim might send the greeting this way (`channel-routes.ts:158-160`); under the flag that reply is refused with `unlinked`, whose remedy leads to the `tandem` server's `tandem_reply`, where the bound child is accepted;
- a `claude:<id>` record → accepted or refused as that record;
- unmapped → if the target message's owner is Tandem's Claude, refused with `chat` (one refusal instead of two); otherwise `unlinked`.

A refusal is HTTP 409 with the `NOT_DOC_OWNER` body; the shim relays a failed reply's status and body to the model as the tool result.

### 9.3 A direct-HTTP terminal's shim (R4.8, settled)

**Problem.** A `tandem setup` terminal's MCP entry is direct-HTTP (`apply.ts:514`). Its shim sends `X-Claude-Session-Id`; its MCP transport does not (probe 3), so no record carries that id.

**Settled: such a shim is never linked.** It keeps today's full stream (R3.4), and its replies are refused with `unlinked` (or `chat`, §9.2); the remedy sends the model to the `tandem` server's `tandem_reply`, checked as the terminal's `http` record. The ways to link it were each ruled out:
- **Expanding `${CLAUDE_CODE_SESSION_ID}` in the entry's headers** — measured (probe 4): Claude Code expands header variables from its own process environment, which does not hold its own session id. The header arrived as the fallback value, or, for a `claude` started inside another Claude Code session, as the **parent's** id. It cannot link, and setup must never write it.
- **A pairing id written by setup** names the install, not the session: two terminals sharing one `.mcp.json` would each answer as the other.
- **A value the model carries between the two servers** depends on every model and every older skill doing it, and fails silently when they don't. The refusal and its remedy reach the same end with no new protocol.

The cost is a single-session change for the flip's CHANGELOG (§14). Plugin terminals, whose bridge and shim send the same header, are linked.

### 9.4 What stays unscoped until Phase 3

`/api/wake` sockets and the supervisor's stdin wake stay unscoped: an armed session, or Tandem's Claude's child, is still woken for every wake-worthy event, finds nothing for documents it does not hold, and ends its turn. That costs a turn per event and produces no answer. An unmapped shim or monitor still receives full content; the refusal copy (§5.3) is what keeps a pushed item from becoming a take.

## 10. Controls

### 10.1 Routes (R3.5)

One new registrar, `src/server/mcp/routes/ownership.ts`, mounted through `api-routes.ts` behind `apiMiddleware`, whose Host check covers DNS rebinding.

- **`POST /api/ownership`** `{documentId, action: "release" | "assign", ownerLabel?}`, or `{messageId, action: "release" | "assign", ownerLabel?}` for a chat message not tied to an open document (§10.2). A message action is a synchronous check-and-set (§7.1), not a document-queue operation, runs the chat handover (§6.5), and records a message loss (§10.2), so the released record cannot simply re-claim the message. It calls `assertLoopbackForMutation` and `assertOriginAllowlisted` at handler top, so CLAUDE.md's enumeration of routes that call neither (pinned by `tests/docs/loopback-gate-claims.test.ts`) is unchanged, and it requires a parsed JSON body, so a `text/plain` simple request cannot reach it. The native menu's Release and Assign leaves are emitted to the webview as `ctx:tab:*` actions (`src-tauri/src/context_menu.rs`; ids in `src/client/tabs/tab-context-menu.ts:15-26`, where the new ids join), so every request comes from the webview with its origin. It runs through the document's queue with v4.1's 10-second wait, `409 busy`, no-op answers (`200 {changed: false}`), `404 unknown-owner` and `409 owner-detached`.
- **`GET /api/ownership/owners`** returns `[{label, displayKind, holds: [documentBasename], canTake}]` for attached records and for Tandem's Claude while present. GET is outside the path-wide loopback invariant, so the handler checks `req.socket.remoteAddress` itself and answers 403 otherwise.
- **Critical Rule 9.** Both get `open` rows in `tests/server/license-gate-api-coverage.test.ts`. The POST's reason says that Release and Assign must work keyless, and that their AI effect (`startOrWake`, the wake frames) is refused downstream, in the supervisor's start and in each frame writer; `tests/server/launcher/license-refusal.test.ts` gains an unlicensed Assign case.

### 10.2 The badge and the composer (R4.7)

`data-testid="tab-owner-badge"` shows the holder's display kind and label and the document's kind. It is **shown only when it says something**: whenever any record other than Tandem's Claude is attached (so a lone terminal beside Tandem's Claude sees whose comments go where), when the document is held by a record other than Tandem's Claude, or when a hint below is active. A lone Tandem's Claude, or no AI at all, shows no badge unless a hint is active. Accept and dismiss notices never make anything "waiting" (§8.5), so they never raise a hint. All fields ride on the `Y_MAP_OPEN_DOCUMENTS` entries through `toDocListEntry` (`registry.ts:127`), so there is no new Y.Map key.

- **Stale owner** (a boolean): the holder is in its grace, or the document's oldest waiting item is more than 5 minutes old and the holder has not polled since it arrived. Suppressed while a start is pending. A 60-second server tick recomputes it and republishes only on a change; `lastPollAt` itself stays server-side.
- **Unowned and waiting**: the document is unowned and an item is waiting — at once when no attached record could claim it, after 5 minutes otherwise ("waiting N min; nobody has checked in"). It offers Assign, and Start where Start can help.
- **"Waiting — Start to answer"**: items are waiting on a document Tandem's Claude holds and it is not running, with no start pending.
- **Where Start can help**: Tandem's Claude is configured and not needing sign-in, unlicensed or missing its CLI. A tripped breaker counts, since Start resets it, and so does Off (Start from Off is the 2026-10-13 behaviour). Every Start control that will take back `claimed` documents (on a badge, in the composer, or Settings' own Start) says so and lists them by name.
- **Release** is hidden where it would change nothing: on an unowned document, and on a `default` document while Tandem's Claude is present. Its menu entry says where the document goes: "Back to Tandem's Claude", or, while Tandem's Claude is not present, "Unassigned — the next session to check in takes it, or Tandem's Claude when it is turned on; this one won't take it back on its own".
- **Assign** lists only records that can take a document (`canTake`): attached records, and Tandem's Claude only while present. It is hidden when that list is empty. Each row shows the display kind, label and the basenames of what it holds, so two terminals can be told apart.
- **Chat with no controlling badge** — doc-less, on a closed document, or held by a per-message owner even on an open document. The `CTRL_ROOM` summary (below) carries "chat waiting" for such a message that is unanswered, and "chat stale" once it has had no final answer for 5 minutes since its last change of owner (its arrival, if it never had one), whether it has an owner or is still claimable. The pickup row of **every** unanswered such message offers **Assign** (to any record that can take it, Tandem's Claude included) and, when it has a per-message owner, **Release** — always, not only when stale, so a session that acknowledged and then stalled can always be overridden. The stale flag, counted from the message's last change of owner, only drives the stall banner and the composer's Start offer (where Start can help). Any other message on an open document is covered by that document's badge. So no waiting message is ever left without a control.
- **A message's loss record.** Releasing or reassigning a message records a blocking loss for the record that held it, until that message changes owner again. While it stands, §7.1's table **skips** that record: if the table would give the message back to it (Tandem's Claude by presence, or its document's holder), the message is claimable by anyone else instead, and that record cannot claim it by a poll, a reply or a post (its reply gets the `chat` copy). So Release always moves a message away from the record it was released from.
- **The chat composer** names who will answer a message sent now, from the active document's entry, or, with no tab, from a small server-written ownership summary in `CTRL_ROOM`'s existing awareness map (a new field whose key is a constant, Critical Rule 1, written with `withInternal`; it says whether Tandem's Claude is present, running or startable, and whether any other AI is attached), which a dark server never writes: "→ Tandem's Claude", "→ Tandem's Claude (will start)" (including an unowned document when no other AI is attached and today's rule would start it), "→ terminal owner-k7qx", "→ terminal owner-k7qx (disconnected)" for a holder in its grace, "→ terminal owner-k7qx (not checking in)" for a stale holder, "→ the first session to check in" for an unowned document an attached record could claim, and "No AI will answer" otherwise, with a pointer to Start or to Settings, whichever can help. "(will start)" is a best effort: a mapped terminal can claim an unowned document first during Tandem's Claude's first start.

The Tauri menu gains a Release leaf and an Assign leaf that opens the popover (v4.1 §3.11), each **omitted** (not just disabled) unless the entry carries owner fields, so a dark build shows neither. The testid snapshot gains the new selectors, add-only.

### 10.3 What the badge and refusals may say (R3.6)

- **Only the server writes them.** The owner fields ride on `Y_MAP_OPEN_DOCUMENTS` entries and the composer summary on `CTRL_ROOM`'s awareness map, both Y.Maps any authenticated editor client can write (and a page on an allowlisted origin can authenticate with the generation id from `GET /api/info`). So the server observes those fields and that key and, on any transaction whose origin is not one of its own helpers, restores its own value (`withInternal`). The guard covers the open-documents entry in `CTRL_ROOM` **and in every document room** (`broadcastOpenDocs` writes all of them, `src/server/documents/registry.ts:162-190`, and the client renders from each), plus the summary key. It is attached at room creation and again from `onDocSwapped`, since Hocuspocus replaces the Y.Doc. It restores from server state (`toDocListEntry` over the open-document registry), never from the map, which by then holds the forgery; restores are coalesced per tick, so a client writing in a loop costs one restore per tick, not one per write; and every restore is written with an origin the lifecycle observer (`src/server/events/observers/ctrl-meta.ts:124`) skips, so it raises no `document:opened`/`closed` events of its own. A forgery is on screen for at most one round trip. Tests write a forged "Tandem's Claude" into `CTRL_ROOM`, into a document room, and after a swap, and assert each reverts.
- The display kind is the server's choice from a closed list: `Tandem's Claude` for `recordKind: "tandem"` only; `Claude Desktop` when `clientInfo.name` equals `CLAUDE_DESKTOP_CLIENT_NAME` (`transport-registry.ts:235`); `terminal` for a `claude` record or an `http` record whose client name is Claude Code's; `other app` otherwise. A client can choose which of the last three it appears as, never `Tandem's Claude`, and never free text. `clientInfo.name` is never displayed.
- **No names.** v4.1's session rename is not built: a nickname set through a route any local process can call would put chosen text on the badge. The Assign list's held-document basenames do what rename did — tell two terminals apart. They are session-influenced, like tab titles, so they are shown quoted and subordinate to the server's display kind and label (§11.3).

## 11. Security posture

### 11.1 The headers (R3.3)

`X-Claude-Session-Id`, `X-Tandem-Client-Id` and `Mcp-Session-Id` **select** among identities and are not proof. Any local process can send any value, and the ids are easy to find: transcript file names, child process arguments, `launcher-session.json`, and — for `Mcp-Session-Id` — `tandem.log`, which logs it today (`server.ts:553`, `:562`, `:892`; `transport-registry.ts:314`, `:344`, `:413`). Under the flag those log lines print a short hash instead. An `Mcp-Session-Id` selects a transport (`dispatchToSession`, `server.ts:865`) and so its record: for an `http` record it is the whole identity, and for a transport bound to Tandem's Claude it is equivalent to the handle for the rest of that run (§11.2). Neither header is, or may be, in `Access-Control-Allow-Headers` (`api-routes.ts:174` allows only `Content-Type`), which is what keeps a local web page from sending them.

Within D4 — ownership coordinates Claude sessions and is not a security boundary; every local process already holds every write, since loopback callers bypass bearer auth — a forged id gets everything the named record has: its narrowed event stream; its reply rights on `/api/channel-reply`; and, on an MCP transport, its documents, its answerer rights, and acknowledgement of its inbox items. A forged transport or stream also keeps a dead terminal's record attached, so its documents do not return; and an `initialize` carrying an unlinked shim's session id creates a `claude:` record that its stream then maps to, narrowing a stream §9.3 leaves whole (R3.4 holds only for ids no record carries). A forged `X-Claude-Session-Id` never gets Tandem's Claude's rights: binding to the `tandem` record needs the live handle (§3.3); Tandem's Claude's id never names a shared record (§3.1); and the channel route never maps a header to Tandem's Claude (§9.2). A bound transport's `Mcp-Session-Id` is the exception, covered with the handle in §11.2. A forged child id on `/api/events` gets at most the `tandem` record's narrowed stream, never more than today's unmapped stream. PR 4 records this in `docs/security.md`.

### 11.2 The handle is a bearer secret

It is minted per spawn and written only to that run's stdin, never to `launcher-session.json`, and it dies at teardown. But every spawn's turns, resumed ones included, are written into the same session transcript under the user's Claude config, so any local process that can read that transcript can read the **current** handle on every run, indefinitely — including a terminal acting on text planted in a document. Holding the live handle, it can bind as Tandem's Claude and have its rights: it is handed Bryan's `default` documents' items and doc-less chat, and its answers, edits and posts are accepted as Tandem's Claude and shown as such. A bound transport's `Mcp-Session-Id` carries the same rights for the rest of the run without the handle (§11.1). The Settings list of bound transports (§3.3) makes an extra headerless bind visible next to the child's own.

**A stronger alternative exists, with costs.** Probe 4 showed Claude Code expands `${VAR}` in an MCP entry's headers from its own environment, and the supervisor controls the child's environment. So the child could be launched with `TANDEM_OWNER_HANDLE` set, and its entry could carry `X-Tandem-Owner-Handle: ${TANDEM_OWNER_HANDLE:-}`: the handle would never enter the transcript or the model's context, and binding would no longer depend on the model (single-session change 7 would go away). Its costs: same-user processes can still read a process's environment; a nested `claude` or other subprocess the child spawns inherits the variable (probe 4 saw exactly that inheritance); the entry needs the header template, which sits cleanly only in a launcher-only `--mcp-config` (§14 item 2(b)); and two facts are unprobed — whether an empty expansion is sent or omitted, and whether Claude Code logs expanded headers. This exposure, and this alternative, are **open for Bryan** (§14), and PR 3a does not merge until he decides.

Hygiene: an invalid handle has no side effects and is never echoed. A redaction for `th_[A-Za-z0-9_-]{32}` is applied at the log sink, so it covers every line where the child's own output reaches `tandem.log` (including `supervisor.ts:2434`, `:2527` and `:2562`), not only `sanitizeForLog`. Every string argument of every tool other than `ownerHandle` itself, recursing into nested arrays and objects, and every string field of a `/api/channel-reply` body, is checked for a live handle and refused with `INVALID_ARGUMENT`, comparing against the live set (no oracle for a stale one). This stops accidental echo into documents, chat and annotations; it does not stop exfiltration, for example a handle written to a file by another tool and then opened.

### 11.3 Exposures filed for Bryan (R3.5)

PR 5 adds two entries to `docs/security.md`, as Bryan confirmed on 2026-11-04 (the plan's last section):
- **The owners list is readable by local pages.** Any page served from an allowlisted `127.0.0.1` origin can list the attached sessions' labels and display kinds.
- **Any local process can Assign itself a document**, including a Claude session using curl, bypassing the `opened` and `assigned` refusals; so can a page on an allowlisted `127.0.0.1` origin, which CORS admits with a JSON body. This is coordination, not security (D4).

**The full `docs/security.md` filing list** across the series: (1) the owners list readable by local pages (PR 5); (2) Assign and Release by any local process or page (PR 5); (3) the three identity selectors — `X-Claude-Session-Id`, `X-Tandem-Client-Id`, `Mcp-Session-Id` — and what a forged one gets (PR 4, §11.1); (4) the handle as a bearer secret, in the form Bryan decides (PR 3a, §11.2). PR 3a's build steps also probe whether Claude Code's own MCP debug logs record `Mcp-Session-Id`, and how `X-Tandem-Client-Id` appears in Tandem's and Claude Code's logs, and file what they find under (3).

The design publishes more than those entries name, and the additions are for Bryan to confirm (§14) before PR 5 files them:
- **Which session holds which document**, readable by local pages (the owners list's held basenames; the owner fields on every `Y_MAP_OPEN_DOCUMENTS` entry, which every editor client syncs) and by any local MCP client (`owner` on `tandem_listDocuments` and `tandem_getAnnotations`, `ownership.notYours` in `tandem_checkInbox`, `holder` in every refusal). Document names and paths are already on those entries; the mapping is new.
- **The transports bound to Tandem's Claude** (§3.3), shown in Settings through the launcher status route PR 3a extends.
- **Release** is as forgeable as Assign, for a document or a chat message: any local process can call it, and the released session is told only that the document "was released", never that the user chose it.

Held-document basenames are session-influenced text (a session chooses file and scratchpad names, and `tandem_rename`), as tab titles already are. The Assign list renders them quoted, truncated and visibly subordinate to the server's display kind and label, never in the display kind's place.

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
| Ownership code is under a blocking test | Each ownership test file turns the flag on for itself with `vi.stubEnv("TANDEM_OWNERSHIP", "1")`, so it runs in `check`. Unlike `TANDEM_DOCX`, which the root `test.env` sets for every suite, `TANDEM_OWNERSHIP` is **not** in the root `test.env` (which beats the shell): the default run is flag-off |
| A positive anchor | One anchor test, in a file of its own that never stubs the variable, runs only when the flag is on (`it.runIf(ownershipEnabled())`); the flag-on job's runner refuses unless it reports at least one pass. Only that file may use `runIf` on the flag (pinned). From PR 1c a second, runtime anchor starts the **built** server and asserts it refuses a non-owner write, so a build whose define override failed cannot pass. From PR 5, which lands the first ownership E2E spec, the job runs Playwright with a `json` reporter and the runner also refuses unless at least one ownership E2E spec passed; those specs gate on a **runtime** signal (`tools/list` carries `ownerHandle`), not on the literal |
| Each PR is green flag-off **and** flag-on | A rule for PRs 1a–5. Because the flag-on job is advisory and **not enforced by GitHub** (making it required is §14 item 7), PR 1a adds a line to `.github/pull_request_template.md` and to the CLAUDE.md "ships dark" entry: while ownership is dark, a red `ownership-flag-on` blocks merging **any** PR (#2360's and Dependabot's included), or the merger files a fix-forward issue the next ownership PR must close first. A test that pins dark behaviour stubs the variable to `""` for itself; each PR lists such tests under "changed tests" (§17). Unit tests that call handlers directly flag-on use the caller helper PR 1a lands with the fail-closed default (§3.1). Each PR's "changed tests" are what a flag-on run of that PR actually turned red, measured, not predicted. The E2E helper (`tests/e2e/helpers.ts`) sends one fixed `X-Tandem-Client-Id`, so every spec's client is the same `bridge:` record and a document one spec opened never refuses the next (PR 1c). Flag-off, a per-tool precedence pin keeps today's error order |
| Nothing visible while dark | `tools/list` is built per `McpServer` from the flag: no `ownerHandle`, no `ownership` output field, no `NOT_DOC_OWNER` text, no new codes in descriptions. Caller resolution and the fail-closed default, the hashed session ids in logs, the composer's `CTRL_ROOM` summary, the owner-field restore, the operation queue itself (handlers run their bodies directly), scope exclusion, acknowledgement scoping, the handled filter, the handover, the start-rule change, `startOrWake` and both frames are bypassed. Nothing is stamped: no owner fields on document entries, no `settles` or `superseded` on chat rows, no handle in prompts |
| An advisory flag-on job | `ownership-flag-on` in `.github/workflows/ci.yml`. `scripts/ci/build-ownership-on.ts`, run under tsx (`tsup.config.ts` imports a `.ts` module), loads the config array and calls tsup's `build({...block, define: {...block.define, __OWNERSHIP_ENABLED__: "true"}, config: false})` once per block (without `config: false`, tsup would load the config itself and merge the passed options over every block). Then `typecheck`, `npm test` and the E2E suite with `TANDEM_OWNERSHIP=1`, and `scripts/ci/ownership-flag-on-runner.mjs` checks the anchors; the job also runs `scripts/ci/vitest-file-anchor.mjs`, so a flag-on run that loses test files cannot read green. About 17–19 runner-minutes per push, in parallel. A wiring test inside `check` pins the job, its env, both scripts, the reporter and the anchors (ADR-051; PR 1a adds the instances-table row). A full flag-on E2E run is a precondition of PR 6 |
| The bound-launcher path without `claude` | The launcher tests' mocked child (as `tests/server/launcher/supervisor-turn-delivery.test.ts` builds one) reads the `th_` handle from its stdin turn, and an in-test MCP client presents it to the real HTTP server, or withholds it (R2.5) |

## 13. Probes (R5 and R4.8) — measured

Measured on Claude Code 2.1.318, Windows 11, 2026-11-04.

| # | Question | Measured | Used in | If a later build differs |
|---|---|---|---|---|
| 1 | Does a resumed child keep `CLAUDE_CODE_SESSION_ID`? | `claude -p --session-id U`, then `claude -p --resume U`: a tool subprocess saw `U` both times | The bind check's header half (§3.3); the child-id mappings (§3.1, §9.1) | Accept any header on a handle bind; a child's streams become unmapped and keep today's stream |
| 2 | Does a plugin monitor carry a session id? | A monitor (`experimental.monitors`, `when: always`) in an interactive session started with `--session-id U` saw `U` in its environment | Monitor streams map like the shim's (§9.1) | Such monitors are unmapped and keep today's stream |
| 3 | Does Claude Code hold a `GET /mcp` stream? | A direct-HTTP server under `claude -p` saw `server/discover`, `initialize`, `notifications/initialized`, then `GET /mcp` (accept `text/event-stream`) held until the process exited; no `X-Claude-Session-Id` was sent. Interactive mode was not measured; the same transport code is likely, unverified | The 2-minute return (§3.4); the direct-HTTP shim (§9.3); the stateless-era note (§3.5) | A dead terminal's documents return by the reaper bound, about 37 minutes at most |
| 4 | Can a direct-HTTP entry's headers carry the session id by `${CLAUDE_CODE_SESSION_ID}` expansion? | An `http` entry with `"X-Claude-Session-Id": "${CLAUDE_CODE_SESSION_ID:-unset}"`, under `claude -p --session-id V --strict-mcp-config`: every request (`server/discover`, `initialize`, `GET /mcp`) carried `unset`. Run from inside another Claude Code session, it carried that **parent** session's id instead of `V` | Rules out linking a direct-HTTP terminal by header (§3.1, §9.3) | If a later build sets the variable in its own process to its own id, setup could write the header and direct-HTTP terminals would become `claude` records; until then, never |

Not probed: whether `claude -p` loads plugin MCP servers. If it does, Tandem's Claude's child has two toolsets; §3.3 already binds each and tells an unbound one how to bind.

## 14. Conflicts, single-session changes, and what is open for Bryan

| Conflict | Where | What changes |
|---|---|---|
| ADR-011: `documentId` defaults to the active document | `docs/decisions.md` | Narrowed, not superseded: reads and range-keyed writes keep it (writes refuse rather than retarget); replies follow §7.3. ADR-054 records this |
| ADR-049 Decision 1: the inbox arbitrates between sessions | `docs/decisions.md` | Ownership arbitrates; the cursor registry stays the delivery record. Amended in ADR-054 |
| CLAUDE.md: do not key new per-client state on `Mcp-Session-Id` | CLAUDE.md, MCP / Server | `http` records key on it (§3.1 rule 3), the only identity a direct-HTTP client has. ADR-054 records the exception; PR 1a amends the line |
| #2196: no start "if another AI is on" | `supervisor.ts:1410`, `:1432` | Overridden for documents Tandem's Claude holds and the chat it owns (decision 10); unchanged elsewhere |
| #2330's inbox identity pin | `tests/server/inbox-cursor.test.ts:1060-1078` | Amended per §6.8 |
| `NOT_OWNED` (#2360) | annotation lifecycle | `NOT_DOC_OWNER` is answered first; #2360's in-thread acknowledgement needs an `inProgress` marker (§5.5) |
| v4.1 D5, §5.5-A, session rename, `issueHandle`, `ownerLabel` | v4.1 | Dropped or reversed (§0) |
| The plan's call that a chat on a Claude Desktop document can start Tandem's Claude | plan | Moot: §8.3 starts nothing for a document another attached record holds, Desktop included |
| Critical Rule 9 tables | `license-gate-api-coverage.test.ts`, `ai-surface-inventory-claims.test.ts` | Two route rows (§10.1); the new turn and frame writers join the inventory (§8.6) |
| CLAUDE.md's enumeration of routes that call neither gate | CLAUDE.md, `tests/docs/loopback-gate-claims.test.ts` | Unchanged: `POST /api/ownership` calls both |
| `SKILL.md`, `SERVER_INSTRUCTIONS` | `skills/tandem/SKILL.md` | Changed only at the flip (PR 6): pass the handle first in Tandem-launched sessions; follow a refusal's remedy; `tandem_open` a held document only when the user asked in your own conversation; reply with `replyTo`; answer comments in their thread. The flip release also bumps the plugin's pinned ref, so plugin terminals get that skill (§6.4) |

**What changes for a single session**, for the flip's CHANGELOG. The plan's two, worded to v5's copy, then the rest:
1. Another AI client (a terminal or Claude Desktop) next to a present-but-idle Tandem's Claude is refused on Bryan's documents and on doc-less chat, and is no longer handed their items. The refusal says `tandem_open` is right only when the user asked it directly, and Claude starts for those items. (Plan; its wording "the refusal tells it to `tandem_open`" is updated to this.)
2. Tandem's Claude alone and idle-stopped is started by a new comment or a user thread reply on its documents, not only by chat. A comment on a document a terminal claimed while it was Off, and not yet taken back, does not start it. (Plan.)
3. A direct-HTTP terminal's opt-in shim has its replies refused with a remedy (§9.3).
4. A post (`tandem_reply` without `replyTo`) from a terminal is refused on a document another session holds and, while Tandem's Claude is present, as doc-less chat; a post on an unowned document claims it (§7.3).
5. `tandem_switchDocument` is refused on a document another session holds; a `focusParagraph` on such a document is ignored (§5.2, §5.6).
6. `tandem_reply` with a `replyTo` and a contradicting `documentId` is refused with `INVALID_ARGUMENT` (§7.3).
7. Tandem's Claude depends on its model passing the handle; an unbound run answers nothing until it does (§3.3, §8.7).
8. A terminal with both Tandem toolsets is two sessions: writing through one toolset to what it opened through the other is refused (§3.1).
9. An item a lone session answered from a push is no longer handed to it again (§6.4).
10. New visible UI: the composer's "who answers" line, and the badge and its hints wherever they say something (§10.2).
11. A terminal's `tandem_open` of a document Tandem's Claude holds — even just to read it — takes it until Release, Assign or a lapse (§4.2, decision 3).
12. A terminal beside a present Tandem's Claude still takes a "woke, found nothing" turn for each event on Tandem's Claude's documents until Phase 3 (§9.4).
13. Turning Tandem's Claude On gives it back every unowned document, and starts it when items on them, or a doc-less chat sent while it was Off, are still waiting; documents a terminal claimed while it was Off stay with that terminal until a run starts (§4.2, §7.2).
14. A chat on a document Claude Desktop holds no longer starts Tandem's Claude (§8.3).

Item 1's "your documents" means the user's: the CHANGELOG says "your documents", not a name.

**Open for Bryan.**
1. **PR 1b.** Land it now (reopen #1952, amend ADR-056 and the register), or defer it to the LAN re-enable, where ADR-056 already schedules it (§11.6).
2. **Two Tandem toolsets in every terminal** (§3.1). With a configured Tandem's Claude and the plugin — the normal desktop setup, and the plan's manual-check setup — each terminal is two records that nothing can link (probe 4). If the model opens through one toolset and writes or replies through the other, it is refused; and the plugin's shim and monitor are not pushed what the direct-HTTP record holds, so those comments wait for the stale hint. v5 adds refusal copy telling the model to compare labels through its other toolset. Options:
   - (a) accept it with that copy, and make the doctor's duplicate-toolset warning a flip prerequisite;
   - (b) move the launcher's Tandem entry out of the user-level config into a launcher-only `--mcp-config` file passed to the child, so terminals keep only the plugin's toolset and "configured" checks that file instead (a setup and launcher change). Cost: a user without the plugin then has no Tandem toolset in terminals unless setup keeps writing the user-level entry for them (which brings the two toolsets back for plugin users), and existing configs need a migration;
   - (c) have the doctor offer to remove the duplicate where the plugin is installed, which today would unconfigure Tandem's Claude unless (b) is done.
3. **The handle's exposure** (§11.2). Any local process that can read Tandem's Claude's transcript can read the current handle and bind as it, on every run, and answer as Tandem's Claude; a bound transport's logged `Mcp-Session-Id` does the same for that run (logs hash it under the flag). Options:
   - (a) accept it as a third filed exposure (D4);
   - (b) pass the handle through the child's environment and a header template instead of the prompt (§11.2), so it never reaches the transcript, at the costs listed there — and it needs a probe of two unknowns and pairs naturally with item 2(b);
   - (c) do not ship ownership in v1.0: without a bind, Tandem's Claude can hold nothing, so decisions 1, 2, 7, 10 and 11 would do nothing.

   PR 3a does not merge until this is decided.
4. **What the owners exposure covers** (§11.3). The confirmed entry names labels and kinds. Three things go further:
   - **Which session holds which document**, to local pages and to any local MCP client. This cannot be removed without losing the badge (R4.7), the refusals that name their holder (R4.2) and the read labels; it is part of the feature.
   - **The Assign list's held-document basenames and the Settings list of bound transports**, which could be dropped. Without the basenames, two terminals in Assign read alike.
   - **Release is as forgeable as Assign**, by any local process or any page on an allowlisted `127.0.0.1` origin.

   Confirm the wider entry, or say which of the droppable pieces to drop.
5. **Session rename** (v4.1 §5.12, decided 2026-09-17) is not built (§10.3); held-document basenames in the Assign list replace it. Reinstating it needs a route curl cannot reach, or a further filed exposure.
6. **The plan's text** needs edits only Bryan can make to the approved plan:
   - steps 2, 3 and 5 depend on which toolset the model picks in the plan's own setup (item 2), so the setup needs pinning, or a separate row for the two-toolset case;
   - step 6 closes every tab, so it reopens by the default rule rather than testing take-back; keep step 1's tab open and send a doc-less chat instead. And on Windows the terminal must run the new skill (the plugin ref), or step 5's chat answer is not "handled" and step 6 answers it again (§6.4);
   - step 8's "the copy said so" now has copy (§10.2);
   - step 9 depends on timing: a terminal that polls before Tandem's Claude's post-spawn point claims the document, which take-back then takes, so its own `tandem_open` needs the user to ask again;
   - "Calls I made" says a chat on a Claude Desktop document can start Tandem's Claude; v5 replaces that call: an attached Desktop holder's chat starts nothing (§8.3; single-session change 14). And the "Who answers" table's ~35 minutes is about 37 (§3.4);
   - the plan's call "Off→On moves no documents" is reversed by a v5 call: unowned documents become `default` at Off→On, `claimed` ones still wait for a run start (§4.2). The "Who answers" row "Tandem's Claude turned back On (no start)" and manual-check step 6 change to match;
   - R2.6 is met for the poll route only: a notice an owner saw only by push can reach the next owner as a duplicate accept or dismiss notice — never a second answer (§15). Bryan confirms narrowing R2.6's "by any route" to "by poll";
   - manual-check row 1 should name the plugin-ref skill; row 10 ("as today") holds only for documents a terminal claimed, since unowned documents go to Tandem's Claude at its next presence; and a new row should cover Off→On (unowned documents return, claimed ones stay);
   - it would gain rows for Solo, needs-login, a run that never binds, and two terminals given one doc-less chat.
7. **Make `ownership-flag-on` a required check while ownership is dark (recommended).** It is advisory and **not enforced by GitHub**: the PR-template line and the CLAUDE.md rule (§12) only ask mergers to respect it.

**Calls made by the maintainer's session after the final review round** (recorded, not asked): refusals carry no handle guidance (§3.3); Off→On returns unowned documents (§4.2); PR 6 waits for #2360's switch (§17); `answeredChatIds`' global sweep is replaced under the flag (§5.5); each spawn re-owes its held documents' unanswered items (§8.2); unmapped streams get `ownership-changed` (§9.1); `sinceSeq` comes from the claiming pass's counter (§2).

## 15. Known limitations

- **Restart forgets** ownership, answerers, loss records, `handoverSeq` and change notices (decision 8). The handled filter still keeps answered items out of every inbox; an old notice may be handed once more.
- **A client that never holds a `GET /mcp` stream** keeps its documents up to about 37 minutes after it dies (§3.4). An `http` record evicted by the session cap, which any local process can force, becomes a new record and loses its documents after the grace.
- **A direct-HTTP terminal's shim** is never linked (§9.3), and a terminal with two Tandem toolsets is two records (§3.1, §14).
- **A post is not an answer.** A reply without `replyTo` is checked by ownership only, so it can carry a second, unlinked answer: from a session that holds the document, or — while Tandem's Claude is not present — from any session posting doc-less about a comment it was pushed (today's skill answers comments in chat). Answers in a comment's thread (#2360) and chat answers with `replyTo` are what answered-once can see; the flip's new skill, carried by the bumped plugin ref, asks for both (§6.4, §14).
- **Comments answered only in chat** (today's skill) are not handled, so a handover can hand them to the next owner again (§6.4), until the plugin ref carries the new skill.
- **A batch answered just before a handover.** Earlier messages of a chat batch settle at the replier's next poll (§5.5); a handover in between re-owes them to the next owner, as a duplicate (today's behaviour). The same holds when a response fails validation after its hand-out token was spent.
- **A notice in a lost response.** If the old owner's response carrying a notice was lost (#2294) and then the document changed owner, the notice is at or below `handoverSeq` and goes to nobody.
- **Two bound transports** of Tandem's Claude poll with two cursors, so the same record can be handed the same items twice.
- **Notices reach their owner by poll only.** A notice an owner saw only by push, and never polled, goes to the next owner as well (R2.6 is met for the poll route).
- **An Undo across a handover.** An item that was not answerable when its document changed owner (a resolved comment) is not re-owed; if Bryan undoes the resolve after the new owner's mark passed it, the new owner is not handed it until it is edited or replied to.
- **The same record, again.** When a document returns to a record that already had it, or a new Tandem's Claude run starts (each spawn re-owes its held documents and owned chat, §8.2), items it was handed and did not answer may be handed again. Answered-once lets the same record reply again, so a duplicate answer is possible.
- **Wasted turns until Phase 3:** unscoped wake sockets, the supervisor's stdin wake and unmapped shims and monitors still wake sessions that have nothing to do; `alreadyPushed` and delivery rounds still count an event as pushed before narrowing.
- **Sign-in loops and crash-on-arrival loops** churn take-back and release: a child that dies on arrival still reached the post-spawn point, so presence and take-back happen per spawn until the breaker trips, and the 5-second loss settle then sweeps the documents back (§8.1, §8.2).
- **Each spawn re-owes its held documents' unanswered items** (§8.2), so a run can be handed an item its predecessor was already working on.
- **A run that never binds**, repeatedly, leaves Tandem's Claude's documents waiting until Bryan sees the stale hint and Assigns (§8.7).
- **Separately spawned helpers** (a remote subagent, a second `claude` process) are separate sessions, refused on documents their orchestrator holds as `opened` or `assigned`.
- **Status text** set by write-mode `tandem_status` is global free text any session can set, as today.
- **Chat labels.** A Claude chat message does not record which session sent it.
- **The local-model collaborator** (dark, `BYO_MODELS_ENABLED`) writes in-process, never through the MCP wrapper, so ownership never sees it; its rows carry `agentIdentity` and settle nothing. Revisit when it flips.
- **Stateless clients** (MCP `2026-07-28`) hold nothing until the stateless branch gives them a record (§3.5).

## 16. Requirements, tests and the PR that lands each

| Req | Section | Acceptance test (the plan's) | PR |
|---|---|---|---|
| R1.1 | §6.2 | The #2358 repro with cursor polls and with legacy polls; two terminals, Tandem's Claude Off, one comment | 2 |
| R1.2 | §6.3, §6.4 | Take-back after a push-answered comment; after a `claimed` owner's answer; handover both ways with old and fresh cursors | 2 (the take-back cases in 3b) |
| R1.3 | §5, §7.3, §9.2 | Refusals per tool (1c), posts (2) and on the channel path (4) | 1c, 2, 4 |
| R1.4 | §7.1 | Two terminals, Tandem's Claude Off, one doc-less chat: one answer | 2 |
| R1.5 | §5.5 | Tandem's Claude answers; a pushed terminal takes the document and replies; refused | 1c (comments), 2 (chat) |
| R2.1 | §6.3, §6.5 | Acknowledged, then Off, then the terminal is handed it | 3b |
| R2.2 | §5.2, §7.3 | Doc-less answer with no tabs; greeting; id-keyed reply on a non-active held document | 2, 3a (greeting) |
| R2.3 | §7.2 | The owner dies, then the chat is answered | 2 (Tandem's Claude starting for it in 3b) |
| R2.4 | §8.3, §8.4 | The decision-10 cases; Assign and Release with items waiting; single-session change 2; today's matrix otherwise | 3b (Assign and Release through the seam; end to end in 5) |
| R2.5 | §8.7 | A child that never presents its handle | 3a |
| R2.6 | §6.3 | A handover does not hand over the old owner's notices, with an old and a fresh next-owner cursor; the owner's own retry with an old cursor still gets its notices | 2 |
| R2.7 | §8.6 | Assign to a running terminal, take-back while running, a lapse while running, each answered with no new event | 3b, 5 |
| R3.1 | §6.2, §8.3, §8.5, §9.1 | Solo-held items never claim, start or wake | 2, 3b, 4 |
| R3.2 | §8.6 | AI-surface inventory derivations and licence seam pins | 3b, 4 |
| R3.3 | §3.1, §3.3, §9.2, §11.1 | A forged child id cannot bind, join or pre-create the child's record, or reply as Tandem's Claude | 1a, 3a, 4 |
| R3.4 | §9.1 | Unmapped and no-header streams equal today's, live and on replay | 4 |
| R3.5 | §10.1, §11.3 | Route gate tests; the register entries | 5 |
| R3.6 | §5.3, §7.3, §10.3 | No session text and no forged "Tandem's Claude" in any refusal, badge or greeting | 1c, 3a, 5 |
| R3.7 | §6.8 | The amended pin; identical cursors across records with the same holdings | 2 |
| R4.1 | §5.2 | Reads default to the active tab; writes refuse rather than retarget | 1c |
| R4.2 | §5.3 | One test per `reason`, and the precedence | 1c, 2, 4 |
| R4.3 | §8.1 | One announcement per transition, none from `status()`, no flap through a crash-resume, Off announced at once | 3b |
| R4.4 | §4.4 | Opening and default holding wake nobody | 2, 3b |
| R4.5 | §6.3 | Handover of a quiet background document | 2 |
| R4.6 | §6.2 | More than 256 pending foreign items; 300 open foreign documents | 2 |
| R4.7 | §10.2 | Badge and composer E2E | 5 |
| R4.8 | §9.3 | A direct-HTTP shim's reply is refused with the remedy; its stream equals today's | 4 |
| R5 | §13 | Measured | 0 |

**Flag-on state between PRs.** After 1a, records exist and nothing is enforced. After 1c, writes are checked, but Tandem's Claude is never present (presence arrives in 3b), so every document is unowned or held by a terminal, and the child is an ordinary `http` record that claims and answers. After 2, the inbox is scoped. PR 3a lands the bind **inert**: the handle is minted and accepted, but the transport stays on its own record until 3b's presence lands, so flag-on behaviour does not regress between 3a and 3b. After 3b the plan's MCP behaviour is complete. After 4, push narrows; after 5, Bryan has the controls.

## 17. PR sizing

Rough sizes include tests. "Changed tests" lists existing tests whose assertions change, flag-on or flag-off.

| PR | Files touched | Scope | Changed tests |
|---|---|---|---|
| **1a. Flag and identity** (may split into "flag and CI" then "identity") | New `src/server/ownership-flag.ts`; `src/shared/constants.ts`; `tsup.config.ts`; `scripts/ci/build-ownership-on.ts`; `scripts/ci/ownership-flag-on-runner.mjs`; `.github/workflows/ci.yml`; `.github/pull_request_template.md`; new `src/server/sessions/ownership.ts` (records, labels, kinds, `ownerByDoc`, `handoverSeq` map, `setDocOwner` with no enforcement and a no-op `startOrWake` stub, the presence seam); `src/server/sessions/context.ts`; `src/server/mcp/server.ts` (records at dispatch, the stdio `local` record, the fail-closed default, hashed session ids in its log lines); `src/server/mcp/response.ts` (caller resolution in `withErrorBoundary`) and `src/server/mcp/awareness.ts` (moving `tandem_reply`'s context read into the wrapper, so the context-getter seam test passes); the test caller helper; `src/server/mcp/transport-registry.ts` (`ownerId`, hashed log lines); `src/cli/mcp-stdio.ts` and `src/shared/cli-runtime.ts` (`X-Tandem-Client-Id`, unconditional); the default rule in the **user-side callers only** (`src/server/mcp/routes/{open,upload,scratchpad}.ts`, startup restore and `welcome.md` in `src/server/index.ts`), never in the shared `src/server/documents/open.ts` that `tandem_open` also runs; the close point in `src/server/mcp/document-service.ts`; `docs/decisions.md` (ADR-054, ADR-051 instances row, ADR-056 checklist items); `CLAUDE.md` (ships-dark entry and merge rule, the `Mcp-Session-Id` line) | Large: about 23 files, 1,400–1,900 lines | Flag-off: the `tandem_reply` tests that pin today's session-id read, which moves into the wrapper. Flag-on: the roughly 25 test files that register tools directly (`registerDocumentTools` and siblings, `InMemoryTransport` users) move onto the caller helper. The flag seam, context-getter seam, wiring and anchor tests are new |
| **1b. #1952** *(conditional)* | `src/server/mcp/wake-url.ts`; `docs/security.md`; `CLAUDE.md`; `docs/decisions.md` (ADR-056 amendment) | Small: under 200 lines | `tests/docs/security-findings-claims.test.ts` |
| **1c. Enforcement** | New `src/server/sessions/doc-op-queue.ts` (flag-on only; every MCP mutation routes through it here); the tool-mode table and its pin against the registered tools (§5.1); `src/server/mcp/{document.ts, annotations.ts, list-edit.ts, docx-apply.ts, convert.ts, navigation.ts, response.ts, output-schemas.ts}` (the tool wrappers only, never the shared cores); `tests/e2e/helpers.ts` (the fixed client id); the annotation lifecycle's reply path (answered-once for threads); `src/shared/types.ts` (`NOT_DOC_OWNER`); the refusal copy module; `docs/mcp-tools.md`; the flag-on `/api`-and-autosave no-context test. May split into queue-and-placement, then copy-and-answered-once, if review wants | Large: about 14 files, 1,800–2,500 lines | `tests/docs/tool-error-codes-claims.test.ts`; `mcp-output-schemas.test.ts`; #2360's refusal-order tests; tool-description snapshots flag-on |
| **2. Inbox and replies** | `src/server/mcp/awareness.ts` (scope, scoped acknowledgement, claims decided in collection and applied at commit, the handled filter on both paths, the notice rule, `settles`, reply and post acceptance, the `ownership` field); `src/server/sessions/ownership.ts` (handover with retire and `handoverSeq`, chat handover, per-message owners); `src/server/events/delivery-state.ts` (per-document and per-message rounds); `src/server/mcp/annotations.ts` (labels); `src/shared/types.ts` (`settles`, `superseded`); `src/client/panels/chat-pickup.ts`; `docs/mcp-tools.md` | Large: about 9 files, 1,600–2,200 lines | `tests/server/inbox-cursor.test.ts` (the pin); delivery-state tests; `checkInbox` output-shape tests; multi-session inbox tests that expect both sessions to be handed an item (flag-on); chat pickup tests |
| **3a. Handle and bind (inert)** | `src/shared/launcher/contract.ts` (three builders wrapping the constants); `src/server/launcher/supervisor.ts` (mint per spawn, teardown, the child-id record demotion, bind logging and the Settings list); `src/server/index.ts` (wiring the handle check); `src/server/sessions/ownership.ts` (bind check, absorb); the four entry tools' schemas and descriptions in `src/server/mcp/{awareness.ts, document.ts}`; `src/shared/types.ts` (`INVALID_OWNER_HANDLE`, `OWNER_HANDLE_CONFLICT`); the argument-level handle scrub (the tool wrapper) and the channel-reply body check; the handle redaction at the log sink; the greeting classification; the bound-transports list (a `SupervisorStatus` field, a Settings component and its testid, hidden while dark); `docs/mcp-tools.md`; `docs/security.md` (the handle, once Bryan decides) | Medium-large: about 13 files, 1,000–1,400 lines | The launcher prompt tests (about 99 assertions on the constants across `stream-json-protocol`, `supervisor-turn-delivery`, `supervisor` and `mcp-tool-integration`) move to the builders; greeting tests; the dark `tools/list` pin |
| **3b. Presence, take-back, starts, wakes** | `src/server/launcher/supervisor.ts` (`startedThisRun`, the presence setters, microtask recompute, the at-once and 5-second announcements, take-back at the post-spawn point, the start predicate and its accumulated bit at `:1410`/`:1432`, the live Off re-check, the Solo-release check, `startOrWake`, `requestWake`); `src/server/index.ts` (wiring `startWorthyFor`, waiting, `startOrWake` and presence); `src/server/sessions/ownership.ts` (presence consumer, waiting, the bind made live); `src/server/events/wake-socket.ts` (the `ownership` frame and its licence check) | Large: about 5 source files, 1,200–1,600 lines, concurrency-heavy | The #2196 start matrix (flag-on); `tests/docs/ai-surface-inventory-claims.test.ts`; licence seam pins; `tests/server/launcher/license-refusal.test.ts` (an unlicensed `startOrWake`) |
| **4. Push and shim identity** | `src/server/events/sse.ts` (narrowing, the `ownership-changed` frame and its licence check); `src/server/mcp/channel-routes.ts`; `src/shared/sse-consumer.ts`; the shim and monitor (`src/channel/`, `src/monitor/`); `docs/security.md` (the headers) | Medium: about 7 files, 800–1,200 lines | SSE and channel-route tests that assume every stream gets every event (flag-on) |
| **5. Controls** | New `src/server/mcp/routes/ownership.ts`; `src/server/mcp/api-routes.ts`; `src/shared/api-paths.ts`; new `src/client/tabs/TabOwnerBadge.svelte`; `DocumentTabs.svelte`; `tab-context-menu.ts`; the chat composer line; `src-tauri/src/context_menu.rs`; `src/server/documents/registry.ts` (`toDocListEntry` fields, the stale tick); `playwright.config.ts` or the job (the `json` reporter); testid snapshot and manifest; the first ownership E2E specs; `docs/security.md` (the exposures, as Bryan confirms them) | Large: about 14 files, 1,300–1,800 lines incl. E2E | `license-gate-api-coverage.test.ts` (two rows); `testid-set.snap.txt` (add-only) |
| **6. Flip** | **Precondition:** #2360's switch PR has merged (thread replies are the answered-link, decision 6). If it slips, the flip waits; no partial skill text ships. The release-smoke row re-runs probes 1–4 on the release build. Files: `src/shared/constants.ts`; `skills/tandem/SKILL.md` (version bump); `SERVER_INSTRUCTIONS`; `.claude-plugin/plugin.json` (the ref carrying the new skill); docs; `CHANGELOG.md` (§14's changes); the release-smoke checklist | Small in code, large in docs | Dark pins removed; skill contract hash and version |
