# Plan: #2358, one Claude answers each ask (document ownership)

**Plan rev 8, 2026-11-05.** Issue #2358. Rev 8 applies Bryan's 2026-11-05 decisions (below) and the plan-text edits design v5 §14 listed, which he accepted.

References:
- Code cites are to origin/master `3b0c6943`.
- Design of record: `docs/spikes/multi-session-ownership/README.md` (v4.1, Bryan 2026-09-17, unimplemented). Below, "the design" means this doc, and "design v5" means its revision, which is PR 0 of this plan.

**How to read this plan.** It fixes the rules and the shipping order, and lists the **requirements** design v5 must meet. It does not choose mechanisms; design v5 does that, with its own adversarial review rounds. Six review rounds showed that mechanism sketched here only produced seams.

## Bryan's decisions (2026-11-04)

1. Build the design's Phase 1 with a new default: "maybe we should have only tandem's claude respond unless it is on a document that another claude session opened?"
2. When Tandem's Claude starts again, it takes back the documents it held by default.
3. Another session's `tandem_open` of a document Tandem's Claude holds by default takes it.
4. No interim advisory fix.
5. #2360's switch lands after ownership.
6. "comments should get answered with replies to the comment directly, not in the chat"
7. Tandem's Claude keeps its documents while idle-stopped or starting.
8. A server restart forgets ownership (an accepted limitation).
9. The channel shim gets an identity, so its replies are ownership-checked (design §5.5-B, reversing §5.5-A).
10. A chat, new comment or thread reply on a document held by a stopped Tandem's Claude starts it, even with a terminal attached. This overrides #2196's "Not if another AI is on" for that case only.
11. Tandem's Claude holds documents only once it has started at least once since the server started.

## Bryan's decisions (2026-11-05), on design v5's open items

1. PR 1b lands now: "land the wakeurl fix now".
2. Two Tandem toolsets per plugin terminal: "the bridge route". `tandem setup` writes Claude Code's `tandem` entry as the stdio bridge, which forwards the session id, so a terminal's two toolsets are one session (design §3.1, §3.6).
3. The handle never goes in the transcript (option (b)): the supervisor puts it in the child's environment, and the child's bridge sends it at `initialize` (design §3.3).
4. The owners exposure: "wider is fine".
5. Rename stays dropped: "doc names in the assigned list is ok".
6. `ownership-flag-on` is a required check while ownership is dark: "ok, as you recommend".
7. R2.6 is narrowed to the poll route: "ok".
8. The plan-text edits design v5 listed: "ok". Applied in this revision.

## Why two sessions answered

Since #2330, every session that passes its inbox cursor is handed the same new items (`inbox-cursor.ts:1-60`, `awareness.ts:1605-1607`). The channel shim pushes full event content to every terminal that has it (`shared/events/types.ts:165-196`). Nothing decides which session owns a document, so nothing stops a second answer.

## The rules

**Ownership.** Every open document has at most one owner.
- Only the owner is **handed** the document's items, by the inbox or by push (shim, plugin monitor).
- Only the owner's answers and writes are accepted.
- Reads stay open: `getAnnotations` shows everything, labelled with the owner.
- The server enforces all of this (design D1, D4).

**Tandem's Claude** is one identity across its child runs. It is **present** when all of these hold:
- it has started at least once this server run;
- it is configured;
- it is not Off;
- it is not in a staying-down state (crash breaker tripped, sign-in or licence refused, CLI unusable or missing, spawn or stop failed with no restart pending).

While present, it keeps its documents through idle-stop, restarts and respawns.

**How a document got its owner decides what can move it:**

| Kind | How | When Tandem's Claude becomes present | Another session's `tandem_open` |
|---|---|---|---|
| default | Held by Tandem's Claude because no other session opened it: Bryan's opens, restores, `welcome.md`, user scratchpads, documents Tandem's Claude opens itself, documents it takes back | (already its own) | takes it → `opened` |
| claimed | A session was handed its work, or wrote to it, while Tandem's Claude was not present | taken back → `default` when a Tandem's Claude run **starts** (decision 2); becoming present without a start (Off→On) takes nothing | takes it → `opened` |
| opened | Another session opened it fresh, or took it with `tandem_open` (including its own `claimed` doc) | not taken | refused |
| assigned | Bryan used Assign | not taken | refused |

**Further rules:**
- **When an owner goes away** (a transport reaped or evicted after the detach grace, Tandem's Claude no longer present, or a server restart), its documents return to the **default rule**: Tandem's Claude if present, otherwise the next session handed the work.
- **A run started by a chat while Tandem's Claude is Off** follows existing behaviour (Bryan, 2026-10-13, pinned in `supervisor-turn-delivery.test.ts`). The saved mode becomes on-click, so Tandem's Claude is present from then on, and that run's start takes back like any other.
- **Release** (from the badge) is allowed on any kind. It sends the document to the default rule, and the waking and starting rules below apply to whatever is waiting. It is hidden where it would change nothing.
- **Chat on a closed document** is owned by the document's owner at close time. If that owner goes away, it follows the default rule like doc-less chat.
- **Doc-less chat** belongs to Tandem's Claude while it is present. Otherwise the first session handed it, or the first whose answer is accepted, owns that message. The design's D5 (disable send on an empty tab) is dropped: Bryan's 2026-10-12 decision answers doc-less chat.
- **Starting.** A present Tandem's Claude that isn't running is started, even beside another AI, by any of:
  - a chat, a new comment or a user thread reply on a document it holds;
  - a doc-less chat it owns;
  - an Assign to it with waiting items;
  - a document returning to it with waiting items (a reaped terminal, a Release);
  - at Off→On, waiting items on the unowned documents it gets back, or a waiting doc-less message it now owns. Off→On returns every **unowned** document to Tandem's Claude as `default`; `claimed` documents still wait for a run start (design v5 §4.2, §7.2, §8.4).

  Take-back is never a start trigger: it happens **because** a run started. Chat on a document a terminal holds as `claimed` belongs to that terminal and starts nothing. Those documents come back only when a run starts for one of the reasons above. A chat on a document another attached session holds, Claude Desktop included, starts nothing.

  This is wider than today in two ways:
  - **for documents it holds**, a new comment and any user thread reply also start it, beyond `isStartWorthy`'s chat and replies on Claude's own threads;
  - **Assign and returning documents** with waiting items start it.

  Everything else is unchanged: `isStartWorthy`, Apply's `other-ai` refusal, and "not if another AI is on".
- **Waking a running owner.** Any owner that is running when a document reaches it with items waiting is woken: take-back, a document returning after a reap, Assign, or Release. Holding with nothing waiting never wakes anyone.

**Who answers:**

| Situation | Who answers |
|---|---|
| Comment on a doc Bryan opened, Tandem's Claude present | Tandem's Claude, in the comment's thread; the terminal stays silent |
| Same, Tandem's Claude idle-stopped | Tandem's Claude starts and answers |
| Terminal opened the doc with `tandem_open` | Terminal |
| Bryan tells the terminal "work on foo.md" | Terminal, after its `tandem_open` takes foo.md |
| Tandem's Claude never started this run, or Off | First session handed it; that session then holds the doc as `claimed` |
| Tandem's Claude turned back On (no start) | Unowned docs return to Tandem's Claude, which starts if items on them, or a doc-less chat, are waiting; the terminal keeps answering its `claimed` docs until a Tandem's Claude run starts, which takes them back |
| The terminal holding a doc dies | After the detach grace (or up to ~37 min with no `GET /mcp` stream), the doc returns to Tandem's Claude, which starts for what's waiting. The stale-owner hint covers the gap, and Assign shortens it. |
| Bryan wants a particular session on a doc | Assign from the badge (offered only to sessions that can take it) |

**What changes for a single session** (both go in CHANGELOG):
1. Another AI client (a terminal or Claude Desktop) next to a present-but-idle Tandem's Claude is refused on Bryan's documents. The refusal says `tandem_open` is right only when the user asked it directly, and Claude starts for them.
2. Tandem's Claude alone and idle-stopped is now started by a new comment or a user thread reply on its documents, not only by chat.

Design v5 §14 lists the rest, including that Claude Code's `tandem` entry becomes the stdio bridge, and a terminal's two toolsets one session.

## Requirements design v5 must meet

Each requirement comes with the acceptance test that proves it.

**R1. No double answer.**
- R1.1: Two sessions polling with cursors are never both handed an item on a document only one of them holds. When the document is unowned, exactly one of them claims it. *Tests:* the #2358 repro with cursor polls and with legacy cursor-less polls; two terminals with Tandem's Claude Off, one comment on Bryan's doc.
- R1.5: An item that has been answered can't be answered again by anyone. That covers a session that got the item by push, then took the document (decision 3) and became its owner. For comments this mirrors today's `answeredChatIds` for chat. *Test:* Tandem's Claude answers a comment; a terminal that was pushed it then `tandem_open`s the doc and replies, and is refused.
- R1.2: An item answered by one owner is never re-handed to the next owner. This includes an item answered from a **push**, before any poll registered it (the cursor registers on first return, `inbox-cursor.ts:10-12`). *Tests:* take-back after a push-answered comment; take-back after a comment the terminal answered as a `claimed` owner; handover in both directions with old and fresh cursors.
- R1.3: A reply or write from a session that isn't the owner is refused, through MCP and through `/api/channel-reply`. The shim check runs after body validation and before the greeting classifier and the append (`channel-routes.ts:124-145`). *Tests:* refusals per tool and per path.
- R1.4: Doc-less chat and chat on a closed document each have exactly one permitted answerer at any time. *Test:* two terminals, Tandem's Claude Off, one doc-less chat: one answer.

**R2. Nothing goes unanswered.**
- R2.1: An item handed to an owner that goes away before answering reaches the next owner. That includes an item the old owner acknowledged but didn't answer (the `acked` floor, `inbox-cursor.ts:109`). *Test:* acknowledged, then Off, then the terminal is handed it.
- R2.2: Every chat has a permitted answerer:
  - doc-less chat stays answerable with no tab open;
  - Tandem's Claude's first-run greeting still lands;
  - `tandem_reply` with `replyTo` resolves to the message's own scope;
  - the id-keyed annotation tools resolve by id before the ownership check (#2187).

  *Tests:* doc-less answer with no tabs; greeting; an id-keyed reply on a non-active owned doc.
- R2.3: Closed-document chat, and per-message doc-less ownership, have a defined successor when their owner goes away. *Test:* the owner dies, then the chat is answered.
- R2.4: A start the rules call for actually happens. For documents Tandem's Claude holds, two things change:
  - the start-worthy set widens (new comment, any user thread reply);
  - the "another AI is on" condition is overridden at both the watch callback and `startForMessage`'s re-check (`supervisor.ts:1410`, `:1432`).

  All other starts are today's. Assign and a returning document with waiting items also start it. *Tests:* the decision-10 cases; Assign and Release with waiting items; single-session change #2; today's matrix for everything else.
- R2.7: A running owner is woken when a document reaches it with items waiting. *Tests:* Assign to a running terminal, take-back while running, and a reap while running, each answered with no new event.
- R2.5: A run that never binds strands nothing. Its documents' items stay owed after it exits. *Test:* a stub child that never presents its handle.
- R2.6: Notices nobody answers (accept or dismiss) count as handled once they reach their owner by poll (narrowed from "by any route", Bryan 2026-11-05; a notice seen only by push can reach the next owner as a duplicate notice, never a second answer). *Test:* a handover doesn't hand over the old owner's notices.

**R3. Privacy, licence and security hold.**
- R3.1: Ownership filtering never runs before the Solo hold, `hideFromAI` or the ADR-027/withheld predicates. "Waiting" is always counted after them, so a Solo-held item never starts or wakes Claude.
- R3.2: Every new path that writes a turn to the child (`requestWake`) passes `aiRefusal()`. The AI-surface inventory test can see it, and the licence-module seam pin is updated.
- R3.3: `X-Claude-Session-Id` is never sufficient to bind to Tandem's Claude. `docs/security.md` records honestly what the header can do: it selects among identities and is not proof. Within D4, a forged id gets that session's events and reply rights.
- R3.4: A consumer with no id, or an id that maps to no session, never gets less than today's stream. The mapping is evaluated per event, for both the live path and `Last-Event-ID` replay (`sse.ts:79-118`).
- R3.5: The new routes keep the loopback and CORS invariants:
  - `GET /api/ownership/owners` is loopback-checked in the handler from `req.socket.remoteAddress`;
  - `POST /api/ownership` requires a parsed JSON body;
  - both are wired through `api-routes.ts`.

  `POST /api/ownership` also calls `assertOriginAllowlisted`, unless v5 shows the native menu sends no Origin.

  Two exposures are filed in `docs/security.md` for Bryan:
  - the owners list is readable by local pages;
  - any local process, including a Claude session using curl, can Assign itself a document, bypassing the `opened`/`assigned` refusal. This is coordination, not security (D4).
- R3.6: No session can make another session's tool results or the badge say "Tandem's Claude", or carry text it chose. Refusals name the server label; the badge renders Tandem's Claude from its record kind.
- R3.7: No owner data goes into an inbox cursor, and nothing trusts cursor contents. The inbox's identity pin (`inbox-cursor.test.ts:1060-1078`) is amended explicitly: the handler may read the caller's owner to choose scope, never to key stored state.

**R4. Behaviour stays sane.**
- R4.1: Reads keep today's active-tab default. Only answers and range-keyed writes use the ownership-aware default, and a `DOCUMENT_REQUIRED` there carries the remedy.
- R4.2: Refusal copy carries its remedy inline, because older skills stay in use after the flip. It distinguishes:
  - held by default ("`tandem_open` it if the user asked you");
  - you just lost it (naming the new holder);
  - opened or assigned (Assign is Bryan's);
  - doc-less chat;
  - a shim not linked to its terminal ("use the `tandem` server's `tandem_reply`").

  The error code is `NOT_DOC_OWNER`, distinct from `NOT_OWNED`.
- R4.3: Presence changes are announced once per transition, by the supervisor, never as a side effect of a status read (`status()` clears `cli-unusable`, `supervisor.ts:3412-3418`).
- R4.4: Holding a document by default, and opening one, never wakes anyone.
- R4.5: An ownership change on a document can't be skipped past by the inbox's quiet-document skip (`awareness.ts:1227-1237`). *Test:* handover of a quiet background document.
- R4.6: A non-owner's poll costs bounded work and is never told about items it can't have. No "malformed" text appears, and nothing grows unboundedly. *Test:* more than 256 pending foreign items.
- R4.7: The badge has:
  - a stale-owner hint, which needs a per-record last-poll time;
  - "waiting — Start to answer" where it applies;
  - Release hidden where it would do nothing;
  - Assign offered only to owners that can take a document.
- R4.8: Design v5 settles how a `tandem setup` (direct-HTTP) terminal's shim is linked to its MCP record before PR 4 is built. Until it is linked, that shim keeps today's stream and its replies get the "use `tandem_reply`" refusal. *Settled (2026-11-05):* setup writes the stdio bridge, so a migrated terminal's shim is linked; a direct-HTTP entry setup did not migrate keeps the refusal (design v5 §3.6, §9.3).

**R5. Probes PR 0 or the first build step must answer:**
- Does a resumed child keep `CLAUDE_CODE_SESSION_ID` equal to the resumed id? Both outcomes must be written into v5: the bind check and the child's shim matching.
- Does the plugin monitor process carry a session id? This decides whether monitor terminals get the narrowed stream.
- Does Claude Code hold a `GET /mcp` stream? This decides how long a dead terminal's documents linger.

## Shipping

Ownership lands **dark**, with the following requirements. PR 1a picks the mechanism.
- Release builds never carry the flag, pinned by a test.
- A shell export can't produce a half-on build.
- Tests can run with the flag on, proven by a positive-anchor test that runs only in the flag-on job. The root `test.env` beats the shell, so the flag's test variable can't live there.
- While dark:
  - `tools/list` carries no ownership argument, field or string;
  - the op queue and the start-rule change are bypassed;
  - nothing new is stamped.
- A separate CI job builds and tests with the flag on, pinned by a wiring test in `check` (ADR-051), and is a **required** check while ownership is dark (Bryan, 2026-11-05). It costs about 17–19 runner-minutes per push, in parallel.
- Existing tests that change are listed per PR, not promised "additive only".
- The bound-launcher path is covered by a stub child, because CI has no `claude`.

| PR | Contents |
|---|---|
| **0. Design v5** | Meets R1–R5. Tracked, with adversarial rounds until clean. PRs 1–4 are sized after it. |
| **1a. Identity** | Owner records, kinds, the Tandem's Claude identity with a presence seam; registry `ownerId`, descriptor, `claudeSessionId` and per-record last-poll time; request context `ownerId`, and `peerIsLoopback` set ungated from the socket only; the bridge's client id; the stdio record; the flag; ADR-054; a CLAUDE.md "ships dark" entry. |
| **1b. #1952** | Per-request `wakeUrl` suppression reading `peerIsLoopback`, ungated (a separate security fix). Lands now (Bryan, 2026-11-05): it reopens #1952 and amends ADR-056, the `docs/security.md` register and CLAUDE.md's Security bullet. |
| **1c. Enforcement** | Op queue, refusal placement, `NOT_DOC_OWNER` and the kind-based copy, the write-side default, the `tandem_open` take rule, the answered-once rule (R1.5), `switchDocument` owner-only. |
| **2. Inbox and replies** | Scope, handover, chat ownership, reply acceptance, `getAnnotations` labels, the inbox pin amendment. |
| **2b. Setup entry and migration** | Behind the flag: `tandem setup`, the wizard and `rotate-token` write Claude Code's `tandem` entry as the stdio bridge, and the boot sweep migrates the HTTP entry Tandem wrote; the doctor names any entry it leaves alone; the ADR-045 amendment. Lands before PR 3's bind (design v5 §3.6). |
| **3. Launcher** | The probes; the handle in the child's environment and the bind at `initialize`; presence and its announcer; take-back; the start rules; waking a running owner; `requestWake`. Comes after PR 2 because "waiting" and doc-less ownership come from there. The Assign- and Release-triggered start and wake are a seam that PR 5 calls. |
| **4. Push and shim identity** | SSE narrowing and `/api/channel-reply` permit, per R3.3, R3.4 and R4.8. |
| **5. Controls** | The ownership routes, badge, popover and native menu; Assign and Release calling PR 3's start/wake seam. |
| **6. Flip** | Waits for #2360's switch to merge. Flag on, `SKILL.md` bump, the plugin's pinned ref bumped to carry the new skill, `SERVER_INSTRUCTIONS`, docs, CHANGELOG (including the entry migration), release-smoke rows (probes and the first-boot migration), dark pins removed, `ownership-flag-on` dropped from the required checks. |

After the flip comes the design's Phase 3 (scoping the `/api/wake` watch and the supervisor); Phase 2 is dropped with D5. Until Phase 3, a session armed on `/api/wake` is still woken for every event. So is a shim the server can't map to a session. Such a session finds nothing and ends its turn silently. That costs one turn per event, but produces no answer.

## Sequencing with #2360

The comment-thread reply is the answered-link (decision 6), and #2360's switch waits for ownership (decision 5). So **#2360's switch merges immediately before this flip, and both ship in the same release.** #2360's PRs 1–3 proceed now. The refusal order is pinned: `NOT_DOC_OWNER` before `NOT_OWNED`.

## Manual check (after both flips, before release)

Setup: Windows desktop build, Tandem's Claude in Auto mode with an idle-stop lifetime, and a terminal `claude` started **after** the flipped build's first boot, with the plugin at the bumped ref (so it runs the new skill) and the channel shim. Claude Code's user-level `tandem` entry is the stdio bridge (row 17 checks the migration). The terminal then has two Tandem toolsets, the plugin's and setup's; both are bridges forwarding the same session id, so they are **one session**, and which toolset the model picks does not change any row.

| # | Step | Expected |
|---|---|---|
| 1 | Comment on a doc you opened | One thread reply, from Tandem's Claude; the terminal silent |
| 2 | The terminal `tandem_open`s a new doc; you comment on it | The terminal answers in the thread, through either toolset; Tandem's Claude silent |
| 3 | Open a new doc X yourself; tell the terminal "comment on X" | The terminal takes X with `tandem_open` (the badge changes) and comments, through either toolset |
| 4 | Switch to step 1's doc, wait for idle-stop, comment | Tandem's Claude starts and answers |
| 5 | Turn Tandem's Claude Off; comment on step 1's doc | The terminal answers once, in the comment's thread |
| 6 | Turn it On (no start). Keep step 1's tab open; open a new scratchpad and send a chat from it; then comment on step 1's doc | The chat (on a document Tandem's Claude holds by default) starts Tandem's Claude, which answers it and, starting, takes step 1's doc back from the terminal; it answers the new comment; step 5's comment is not answered again |
| 7 | Kill the terminal while it holds X; comment on X | The stale-owner hint shows; Assign to Tandem's Claude → it answers. Without Assign, X returns to Tandem's Claude after the grace or reap, and Claude starts and answers. |
| 8 | Release a doc the terminal holds | It returns to Tandem's Claude; the Release entry said "Back to Tandem's Claude" |
| 9 | Restart the server while the terminal holds a doc | The doc goes back to Tandem's Claude once it starts (if the terminal polled first, it claims the doc and take-back then takes it); asked again, the terminal's `tandem_open` re-takes it |
| 10 | On-click mode, never pressed Start; the terminal works on your doc | As today for docs the terminal claimed; unowned docs go to Tandem's Claude when it is next present |
| 11 | Repeat 1, 2, 5, 6 and 17 on the Linux VM AppImage, with the plugin ref bumped | Same |
| 12 | Off→On with nothing claimed: turn Off, comment on a doc no session holds, turn On | The doc returns to Tandem's Claude, which starts and answers; a doc a terminal claimed while Off stays with it until a run starts |
| 13 | Switch to Solo; comment on step 1's doc; wait a minute; switch back to Tandem | Nothing starts and nobody answers during Solo; after it, Tandem's Claude answers once |
| 14 | Sign Tandem's Claude out (needs-login); comment on a doc it held | After about 5 seconds its docs go unowned; the terminal can pick the comment up; Start is not offered as a fix for sign-in |
| 15 | A run that never binds: hand-edit the `tandem` entry back to direct-HTTP, restart Tandem, comment | `tandem doctor` names the entry; the comment waits; the stale hint shows after 5 minutes; Assign to the terminal → it answers |
| 16 | Two terminals, Tandem's Claude Off; send one doc-less chat | Exactly one answer |
| 17 | First-boot migration: before installing the flipped build, keep the direct-HTTP entry `tandem setup` wrote; install and start | The entry is now the bridge carrying the same token; `tandem doctor` shows only the duplicate-toolset warning; in a new terminal, `tandem_status` through each toolset shows the same label |

## Calls I made (documented, not asked)

- **A document returning to a present Tandem's Claude with waiting items starts it.** A reaped terminal is not a radio click. *Revised in rev 8:* Off→On returns unowned documents and starts for what waits on them (design v5 §4.2, accepted 2026-11-05).
- **A per-message doc-less owner keeps its message when Tandem's Claude becomes present.** The answer is already in flight, and `answeredChatIds` covers the rest.
- **"Present" excludes every staying-down state.** A child that can't answer doesn't hold documents.
- **Take-back happens when a run starts, not at Off→On.** Decision 2 says "starts again". The terminal keeps answering until Tandem's Claude actually runs.
- **A chat-started run from Off follows the 2026-10-13 behaviour** already in code (the mode becomes on-click).
- ~~**A chat on a doc held by Claude Desktop can start Tandem's Claude.**~~ *Replaced in rev 8:* a chat on a document any other attached session holds, Desktop included, starts nothing (design v5 §8.3).
- **`assigned` documents return to the default rule when their owner goes away.**
- **The error code is `NOT_DOC_OWNER`.**
- **#1952 is its own PR** (1b), landing now (Bryan, 2026-11-05).
- **The setup entry's migration ships behind the flag**, in its own PR (2b); the reversible alternative, migrating live before the flip, is in design v5 §14.
- **D5 is dropped.**

## Confirmed by Bryan (2026-11-04)

- My reading of decisions 5 and 6: #2360's switch merges right before the flip, in the same release.
- The first call above (a returning document with waiting items starts Tandem's Claude).
- Whether to accept two local exposures:
  - any page served from 127.0.0.1 can list the attached sessions' labels and kinds;
  - any local process (including a Claude session using curl) can Assign itself a document.

On 2026-11-05 he widened the first ("wider is fine"): it also covers which session holds which document, the Assign list's document names, the Settings list of bound transports, and Release being as forgeable as Assign (design v5 §11.3).
