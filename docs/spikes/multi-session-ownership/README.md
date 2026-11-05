# Multi-Session Document Ownership — Design v5

> **Not implemented.** Design v5 is PR 0 of the approved plan, [`docs/plans/2358-ownership.md`](../../plans/2358-ownership.md) (rev 9, issue #2358). It replaces v4.1 (Bryan, 2026-09-17) and meets the plan's requirements R1–R5. Bryan's eleven decisions of 2026-11-04, the items he confirmed, and his 2026-11-05 decisions, two rounds (§14), are settled and are restated, not reopened. ADR-054 stays reserved for this design and is written in PR 1a.
>
> - Every `file:line` here was verified against master `4fb053a5` on 2026-11-04, except those added or changed for the 2026-11-05 decisions (the setup entry, the bridge, the handle's route, the migration), which were verified against master `32c55352` on 2026-11-05.
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
| Direct-HTTP terminal's shim | n/a | Once setup writes the bridge, a terminal's bridge and shim send the same id and are linked. A direct-HTTP entry setup did not migrate (hand-edited, or another tool's) is **never linked**, measured (probes 4, 5); it keeps today's stream, replies refused with a remedy (§9.3) | R4.8 |
| Launcher | Handle per run; the child's record dies with it | The handle binds each run to the one **Tandem's Claude** record, which outlives runs; presence, take-back at spawn, widened starts, waking (§8) | Decisions 2, 7, 10, 11 |
| The handle's route | Named in the supervisor's prompts; the model passed it as a tool argument | Put in the `env` of the `tandem` bridge entry in a per-spawn launcher config the child loads (`--mcp-config`), or, if probe 9 fails, in the child's environment; the bridge sends it as a header and the server binds the transport at `initialize`. Tandem never writes it into a prompt or the transcript; no `ownerHandle` argument (§3.3) | Bryan, 2026-11-05: option (b), then "probe, then narrow" |
| Claude Code's setup entry | Direct-HTTP `{type: "http"}` | The **stdio bridge** on a system Node where one exists, shipped **live one release before the flip**; the boot sweep migrates Tandem-written HTTP entries (§3.6) | Bryan, 2026-11-05: "the bridge route", "One release early", "Prefer system Node" |
| Two Tandem toolsets in one terminal | Two records nothing could link | Both are bridges forwarding the same session id, so they resolve to **one** `claude:<id>` record; the duplicate tool list stays cosmetic (§3.1) | Follows from the bridge route |
| Dead terminal | ~32 min (idle reaper) | About 2 minutes after its `GET /mcp` stream closes (§3.4) | Probe 3 |
| `#1952` | Fixed per request | PR 1b lands: `wakeUrlField()` reads `peerIsLoopback`; #1952 is reopened and ADR-056, the register and CLAUDE.md are amended (§11.6) | Bryan, 2026-11-05: "land the wakeurl fix now" |
| Error code | `NOT_OWNER` | `NOT_DOC_OWNER` with a `reason` (§5.3) | R4.2 |
| Names on the badge | Nicknames (set by Bryan or the session), client name | Server-derived display kind, label and held-document names only; rename is not built (§10.3) | R3.6 |
| `tandem_open` activation | Re-open and claim do not activate | Today's behaviour: every `tandem_open` activates (§5.4) | No unlisted single-session change |
| Subagent hand-off (`issueHandle`), `ChatMessage.ownerLabel` | Built | Not built (§15) | No requirement needs them |
| Wake socket scoping (`?watch=`, socket pin) | Phase 3 | After the flip; Phase 3 starts from v4.1's text | Plan |

## 1. Summary

- Every open document has **at most one owner**. Only the owner is handed its items (inbox and push), and only the owner's answers and writes are accepted. Reads stay open. The server enforces this in the MCP tool wrapper and on `/api/channel-reply` and nowhere else; the rest of `/api` is Bryan's own surface (D4).
- **Who is calling.** From one release before the flip, `tandem setup` gives Claude Code the stdio bridge, which forwards the Claude Code session id, so each terminal is one record however many Tandem toolsets it loads. Tandem's Claude's child is recognised by a per-spawn handle the supervisor hands only to the child's own Tandem bridge, through a launcher config file (or, if a probe fails, the child's environment); Tandem never shows it to the model.
- **Tandem's Claude** is one owner record across all its child runs. While **present**, it holds every document no other session opened. A terminal answers only documents it opened or took with `tandem_open`, documents Bryan assigned to it, and documents it was handed while Tandem's Claude was not present.
- **Kinds** say what can move a document: a starting Tandem's Claude run takes back `claimed` documents; another session's `tandem_open` takes `default` and `claimed` ones; `opened` and `assigned` move only by Bryan's Release or Assign, or when their owner goes away.
- **The inbox stays on #2330's cursors.** A document held by someone else is not in the caller's scope. When ownership moves away from a record, the items it was handed and did not answer are owed again to everyone; answered items are never handed to anyone.
- **One answer per item.** The first record whose final answer is accepted is the item's answerer.
- **Starting and waking.** A present Tandem's Claude that is not running starts for asks on its own documents, even with a terminal attached, and for documents or chat that come back to it with items waiting. A running owner that receives work is woken.
- **It ships dark** behind one build-time flag. Its tests run in the blocking `check` job; a flag-on job, required while ownership is dark, runs everything else flag-on.

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
| **Handle** | `th_` plus 32 base64url characters, minted per Tandem's Claude child spawn and given to that child's Tandem bridge as `TANDEM_OWNER_HANDLE` (route L: the launcher config's `env`; route E: the child's environment); the bridge sends it as the `X-Tandem-Owner-Handle` header (§3.3). Tandem never writes it into a prompt or a tool argument. |

## 3. Identity

### 3.1 Records, callers, and where the check lives

**Problem.** Ownership needs to know who is calling. Direct-HTTP Claude Code sends no per-session header and cannot be made to (probes 3, 4 and 5, §13), the stdio bridge forwards one (`src/cli/mcp-stdio.ts:438`), Claude Desktop sends neither, and stdio mode has no transport registry. That is why setup moves Claude Code onto the bridge (§3.6), one release before the flip; a direct-HTTP entry remains only where setup did not write it. And the same service code serves MCP tools, Bryan's `/api` routes, autosave and the reload family.

**Rule: records.** Each transport resolves to one record at `initialize`:
0. The current spawn's handle in `X-Tandem-Owner-Handle`, with `X-Claude-Session-Id` equal to the current run's id → the `tandem` record (§3.3). Checked first.
1. `X-Claude-Session-Id` present → `claude:<id>`. Several transports may share it (bridge reconnects and respawns, and a terminal's two bridges, below). **Exception:** an id in the supervisor's `ownChildSessionIds` — every child id this server run has spawned, kept across stops (`src/server/launcher/supervisor.ts:1220`, added at `:1992`), not only the saved one — that did not bind by rule 0 gets a private **unbound-child** record per transport, never shared; and at each spawn, any shared `claude:` record holding that spawn's id is demoted (its transports re-pointed to unbound-child records, its documents to the default rule). So nothing can pre-create or join the child's record, including the record of a child a start-fresh replaced. What reaches this exception: a forger, and a bridge in the child that does not present the handle — the plugin's bridge, if the child loads plugins (§3.3). An unbound-child record joins nothing, is refused on Tandem's Claude's documents, and its refusals use the `unbound-child` copy (§5.3), never copy that names Tandem's Claude as someone else.
2. Else `X-Tandem-Client-Id` present → `bridge:<id>`. A new header, minted once per bridge process and reused by its reconnects. The bridge sends it unconditionally: `src/cli/mcp-stdio.ts` is in the define-less stdio-bridge bundle and never reads the flag; a dark server ignores the header.
3. Else → `http:<Mcp-Session-Id>`. After the migration (§3.6) this is the legacy and third-party case: a direct-HTTP entry setup did not write or could not migrate, a terminal still running from before the migration, or another MCP client. It keys per-client state on the legacy session id, which CLAUDE.md's MCP/Server section says not to do for new state; ADR-054 records the exception (it is the only identity a direct-HTTP client has, probe 4) and PR 1a amends that CLAUDE.md line (§14). When such a record's client name is Claude Code's, its `held`, `claimed` and `default` refusals add: "If Tandem was updated while this terminal was open, restart this terminal."
4. Stdio transport mode (chosen at boot, `src/server/index.ts`, which tells the ownership module) → one process-wide `local` record, permanently attached, display kind `terminal`. In HTTP mode — and in any process no boot has told, such as a unit test — a tool call with no request context, or a context with no `ownerId`, is **refused** (fail closed): every HTTP MCP request enters a context (`runWithMcpContext`, `src/server/mcp/server.ts:875` and `:930`), which PR 1a pins with a test. Unit tests that call handlers directly flag-on run inside a test helper that supplies a caller; PR 1a adds the helper together with the fail-closed default and lists the files it touches.

**Rule: where the check lives.** The ownership check, claims and answered-once run **only** in two places: the MCP tool wrapper `withErrorBoundary` (`src/server/mcp/response.ts:149`), which wraps every registered tool and resolves the caller once at entry, and `/api/channel-reply`, which maps its own caller (§9.2). The caller's `ownerId` is passed explicitly into the operation queue (§5.1), `setDocOwner`, answered-once and the greeting classifier; nothing reads the ambient context inside a handler body (today's `getCurrentSessionId()` read in `tandem_reply`, `awareness.ts:2060`, moves into the wrapper). A seam test pins that the context getters are imported only by the wrapper, the caller resolver and `wake-url.ts` (which reads `peerIsLoopback` and nothing else, §11.6), and that every registered tool goes through the wrapper. Shared service code — `applyChangesCore`, `convertToMarkdown`, the save, open and close paths, the lifecycle — never checks ownership. So Bryan's `/api` routes, autosave, the reload family, startup restore and the local-model collaborator's in-process writes never meet it. A flag-on test drives every mutating `/api` route and an autosave tick with no MCP context and expects today's results.

**Mechanism.** The registry entry already stores `claudeSessionId` and `clientName` (`McpSessionEntry`, `src/server/mcp/transport-registry.ts:54-84`), filled in at `onsessioninitialized` (`server.ts:550`). PR 1a adds `ownerId` to the entry, and to `McpRequestContext` (`src/server/sessions/context.ts:37-59`) as set in `dispatchToSession` (`server.ts:858`); the initialize request itself needs no caller. `peerIsLoopback` is added to the context by PR 1b, which lands first (§11.6). PR 3a reads `X-Tandem-Owner-Handle` at the same `onsessioninitialized` point and stores only the bind outcome on the entry, never the value.

**Two Tandem toolsets in one terminal — one record (Bryan, 2026-11-05: "the bridge route").** The plugin bundles a bridge `tandem` entry and the shim (`.claude-plugin/plugin.json`); `tandem setup` writes the user-level `tandem` entry, the bridge from PR 2b on (§3.6). So a user with both has two toolsets in every terminal (the doctor's warning stays, `src/cli/doctor.ts:2455-2470`), but both are bridges, and each forwards `CLAUDE_CODE_SESSION_ID` from the environment Claude Code gives it (`resolveClaudeSessionId`, `src/shared/cli-runtime.ts:144-150`, sent at `src/cli/mcp-stdio.ts:435-438`; probe 6). Both resolve to the **same** `claude:<id>` record (rule 1), and so do the plugin's shim and monitor (§9.1). Opening through one toolset and writing through the other is the same session; the duplicate tool list is cosmetic. v5's earlier two-toolsets refusal clause is **dropped**, not kept for unmigrated setups: it asked every model with two toolsets to check its other one on every such refusal, almost always for nothing once terminals migrate, and the honest remedy for the rest is the doctor's (§3.6).

**Tandem's Claude's child** does not depend on the user-level entry when the launcher's own config takes precedence (§3.3, route L): its `tandem` toolset is the launcher's bridge, and the plugin's bridge, if loaded, is namespaced apart from it.

### 3.2 The Tandem's Claude record

**Problem.** Tandem's Claude is a sequence of child processes (spawn, idle-stop, resume, crash-resume, relaunch), each with its own transports. Decisions 2, 7 and 11 need one identity that outlives them.

**Rule.** The ownership module creates one record `tandem` at boot. It holds documents only while present (§8.1); while not present it holds nothing, its writes to unowned documents are refused, and its polls read nothing (§4.2). Its transports are those bound with the current spawn's handle. Its label is fixed for the server run, and its display kind is always `Tandem's Claude`.

### 3.3 Binding a child run

**Problem.** The server must know which transports are the current Tandem's Claude run, and nothing the model says can be the proof: a session id is a selector (§11.1), and anything placed in a prompt lands in the session transcript. What the supervisor controls is how the child is launched: its arguments, its environment, and any config file it names.

**Rule (Bryan, 2026-11-05: the handle never goes in the transcript; then "probe, then narrow").** The supervisor mints a handle per spawn and gets it to the child's own Tandem bridge without the model seeing it. Two routes; which one ships is **probe-contingent** on probe 9 (§13, a PR 3a build step on Bryan's machine): does an `--mcp-config` entry named `tandem` replace a same-name **user-scope** entry? Probe 8 measured that it replaces a same-name project-scope entry and that its `env` block reaches the server.

- **Route L, the launcher config — if probe 9 shows the user-scope entry is replaced.** Each spawn writes a config file naming one server, `tandem`: `command` = the server's own Node (`process.execPath`), `args` = [`STDIO_BRIDGE_DIST`], `env` = `TANDEM_URL`, `TANDEM_AUTH_TOKEN` when a token is set, and `TANDEM_OWNER_HANDLE`. `buildClaudeArgs` (`supervisor.ts:911-921`) adds `--mcp-config <path>` flag-on only. The handle is **not** put in the child's process environment, so the child's Bash, hooks, other MCP servers and plugin processes never inherit it. The file holds the handle and the token: it lives in the app-data root's `launcher/` directory (owner-only, like the other app-data stores since #2266: `0700` directory, file created exclusively at `0600`, owner-only ACL on Windows), is named per spawn, is deleted at that spawn's teardown, and every leftover is deleted at boot before the first spawn (no child outlives a server restart; the reaper kills it). The token is the server's own accepted token, never read back from a Claude Code config; if the supervisor has to import the token store to get it, `TOKEN_FILE_REFERENCES` in `tests/docs/config-writer-set-claims.test.ts` gains the launcher module and PR 3a lists it. The child's `tandem` toolset is then always a bridge Tandem built, whatever the user-level entry says, so Tandem's Claude binds even beside a hand-edited or direct-HTTP user entry.
- **The plugin's bridge in the child, under route L.** Plugin servers are namespaced, so the launcher config cannot shadow the plugin's bridge. If the child loads plugins (unprobed for `claude -p`), that bridge carries the child's session id and no handle. **Probe-contingent on probe 10** (a PR 3a build step): if `--settings` with an `enabledPlugins` override that disables the Tandem plugin takes effect for that run, the launcher passes it, flag-on. The child loses nothing it needs: it is woken on stdin, the skill already tells a launched session not to arm a watch, and the user-level skill that `tandem setup` and the wizard install (`installSkill`, `apply.ts:2281`) stays; probe 10 also checks the child still loads it. If the override does not take effect, the plugin's bridge is an unbound-child transport (§3.1 rule 1): it holds nothing and its refusals say to use the other Tandem toolset.
- **Route E, the environment — if probe 9 shows the user-scope entry wins or both load.** The handle goes in the child's environment as `TANDEM_OWNER_HANDLE`, added to the `env` passed to the reaper's `spawn` (`childEnv()`, `supervisor.ts:992-1002`, used at `:1945-1951`); the child's bridge, loaded from the user-level entry, inherits it, merged with the entry's own `env` (probes 6 and 7). Its reach is wider, and filed (§11.2): every process the child starts inherits it — Bash and anything it runs, hooks, every other MCP server, plugin processes such as the monitor and the plugin's bridge (which then binds too, if its version forwards the handle, since it carries the child's id), and a nested `claude`. Under route E the child's toolset is the user-level entry, so presence requires it to be a Tandem-written bridge (§8.1).
- **Both routes.** `TANDEM_OWNER_HANDLE` joins `TANDEM_SECRET_ENV_KEYS` (`supervisor.ts:971-975`), so a value the server itself inherited never reaches the child; route E adds the current spawn's value after the strip. The mint and `currentSessionId = plan.sessionId` (`:1998`) happen in one synchronous stretch, so the bind check never sees one without the other.

**Sending.** The stdio bridge reads `TANDEM_OWNER_HANDLE` once at start, validates its shape (`th_` plus 32 base64url characters, as `normalizeSessionId` does for the session id, `src/shared/cli-runtime.ts:120-126`) and, if valid, adds `X-Tandem-Owner-Handle` to `upstreamHeaders` (`src/cli/mcp-stdio.ts:436-438`). Every upstream transport is built from that one object (`createUpstream`, `:452-456`), so the header rides the first `initialize` and every re-initialize after a 404. The bridge is in the define-less bundle and sends it unconditionally; a dark server ignores it.

**Bind check, at `initialize` only** (`onsessioninitialized`, `src/server/mcp/server.ts:550-551`, where `claudeSessionId` is already read into the registry entry). The transport binds to `tandem` when the handle is the **current** spawn's and its `X-Claude-Session-Id` equals the current run's id (`currentSessionId`). Any number of such transports may bind. Later requests' handle headers are ignored; the bind is a property of the transport. Requiring the id refuses a request that merely holds the handle: a headerless `curl`, and under route E a nested `claude` started by the child, whose bridge inherits the handle but is given its own session id.

**Outcomes.** Current handle and matching id → bound to `tandem`. Anything else — a stale, unknown or malformed handle, or a mismatched or missing id — → **not bound**: the transport resolves by rules 1–3 as if it had sent no handle, the server logs one line (never the value), and the `initialize` succeeds. It is never refused, because a bridge left over from a torn-down spawn would otherwise retry its handshake forever. Binding happens before any tool call, so v5's earlier `OWNER_HANDLE_CONFLICT`, absorb rule and `INVALID_OWNER_HANDLE` have no input and are dropped.

**Every bind is logged, and Settings lists the transports bound to Tandem's Claude** by transport kind and whether each carried a header, so an unexpected one is visible.

**Teardown, per spawn.** `teardownTurnDelivery` runs for a superseded spawn too, deliberately not identity-guarded (`supervisor.ts:2262-2275`). So the handle, the transports bound with it and (route L) the config file belong to a per-spawn object the spawn's closure holds, and teardown ends only **that** spawn's: its handle stops matching, its transports are re-pointed to fresh unbound-child records, its config file is deleted. It never touches a newer spawn's. "The current handle" in the bind check is the current spawn's object. The `tandem` record keeps its documents: presence, not the run, decides what it holds.

**The greeting** is classified by "this transport was bound with the current handle" (§7.3), which holds from PR 3a even while the bind is inert (§16).

**What the prompt route needed and this does not** (dropped): the three prompt builders around `SUPERVISOR_INITIAL_PROMPT`, `SUPERVISOR_GREETING_PROMPT` and `SUPERVISOR_WAKE_PROMPT` (`src/shared/launcher/contract.ts:741`, `:760`, `:819`; the constants and their roughly 99 assertions stay as they are); the `ownerHandle` argument on four tools, which would put the handle back in the model's context; the "unbound child" sentence on refusals naming Tandem's Claude, since the model cannot bind itself; and the argument-level handle scrub, which stopped echo of a handle the model had been shown. Tandem never writes the handle into a prompt, a tool result or the transcript; under route E a child that prints its environment (`env` in Bash) would put it in its own transcript, which route L avoids. The redaction at the log sink stays (§11.2).

**If a later Claude Code build differs.**
- *Probe 1:* if a resumed child got a new `CLAUDE_CODE_SESSION_ID`, its bridge would forward an id that no longer equals `currentSessionId`; the fallback is to accept any id on a handle bind.
- *Probe 6, and stdio servers under `--resume`:* probe 1 measured a tool subprocess of a resumed child, not a stdio MCP server. `src/shared/cli-runtime.ts:134` records Claude Code's changelog saying the id is "also forwarded on `--resume` since 2.1.163". If a resumed child's bridge, or any bridge, got no id, or no `CLAUDECODE=1` beside it (`resolveClaudeSessionId` requires both, `:148-149`), no child transport could bind; the fallback is to accept a current handle with no id, which under route L is still confined to the launcher's own bridge.
- The flip's release-smoke rows re-run probes 1 and 5–10 on the release build (§17).

### 3.4 When a client goes away

**Problem.** A dead terminal's documents should come back promptly, but a live client must not lose them to a blip.

**Rule.** A non-`tandem` record is **attached** while one of its transports is registered and, if any of its transports has ever held a `GET /mcp` stream, one such stream is open. When it stops being attached a 2-minute grace starts (v4.1 §5.8). A reopened stream, a new transport for the record, or any request on one of its transports ends the grace. At expiry the record **lapses**: each of its documents goes to the default rule through `setDocOwner` (§4.3), and its chat follows (§7.2). A lapsed record whose transport is still registered keeps its label and holds nothing; it may claim again like anyone (a lapse records no blocking loss, §5.3).

**Mechanism.** The registry counts open streams per entry (`openStreams`, `transport-registry.ts:83`) and fires `onEvicted` on `lru | idle | explicit` closes (`:100`). The ownership module listens to both.

**Bounds** (probe 3): a Claude Code terminal that exits or crashes closes its stream with the process, so its documents return about 2 minutes later. A client that never holds a stream is noticed only by the idle reaper: 30 minutes of idleness (`transport-registry.ts:290`), up to the 5-minute reap interval, then the grace — about 37 minutes at most. The stale-owner hint (§10.2) shows the gap and Assign closes it. An `http` record is its `Mcp-Session-Id`: a direct-HTTP terminal evicted by the 16-session cap, which any local process can force, re-initializes as a new record and its old one lapses (§15).

**If a later build differs (probe 3).** Without a held stream, Claude Code terminals fall into the reaper bound. Nothing else changes.

### 3.5 Stateless clients (MCP `2026-07-28`)

In probes 3 and 4, Claude Code sent `server/discover` (protocol `2026-07-28`) before `initialize`: it tries the stateless era first and falls back. Tandem serves only the legacy branch (ADR-045 amendment), so every caller still gets a transport. Ownership keys on the **record**; only rule 3 derives one from `Mcp-Session-Id` (§3.1). When Tandem adds the stateless branch, that work must give a stateless caller a record, or it holds nothing (§15).

### 3.6 Claude Code's setup entry, and migrating existing ones (PR 2b, live, one release before the flip)

**Problem.** The bridge route needs every Claude Code terminal's user-level `tandem` entry to be the stdio bridge, the only shape that sends the session id. Every existing install has the direct-HTTP entry, and today nothing rewrites it: the boot sweep returns `no-op` for an entry with no `command` (`src/server/integrations/apply.ts:1706`, `:1995`), and its one shape-changing rule, npx convergence, is scoped to Claude Desktop because, its comment says, the user-level Claude Code config only ever gets the HTTP shape (`:2093`, gate at `:1893`). ADR-045 decision 6 (`docs/decisions.md:1840`) records that the direct-HTTP entry "carries nothing" and that closing that gap "is a separate decision". This is that decision; PR 2b amends ADR-045 and ADR-054 records it.

**Timing (Bryan, 2026-11-05: "One release early").** PR 2b is independent of ownership and ships **live**, not behind the flag, in a release before the flip. By the flip, terminals have restarted onto the bridge, the migration has had a release of real use, and the flip's CHANGELOG changes no config. Ownership itself still ships dark. The pre-flip release has its own smoke (plan, "Pre-flip release smoke") and its own CHANGELOG lines: the entry change, one more Node process per terminal, "restart open terminals", and the two live behaviour changes below.

**Rule: the writer.** `buildMcpEntries` (`apply.ts:497-533`) gives `claude-code` a stdio bridge entry: an absolute Node plus the bridge script, `env` = `TANDEM_URL` and, when a token is known, `TANDEM_AUTH_TOKEN` (`STDIO_ENTRY_ENV_KEYS`, `:492`). That one branch covers all three callers: `tandem setup` (`src/cli/setup.ts:473`), the wizard's apply route (`src/server/integrations/api-routes.ts:1084`), and `applyConfigWithToken` (`apply.ts:2740`), which is `tandem rotate-token`, so rotation writes the new token into `env` and overwrites the `tandem` key as it does today.

**Rule: which Node (Bryan, 2026-11-05: "Prefer system Node").** A Windows desktop update replaces the bundled sidecar, killing the Node under every terminal's bridge. So for `claude-code` the writer prefers a **system Node**: the first `node` on Tandem's own `PATH` that passes `isValidNodeBinary` and `probeNodeBinary` (`src/server/integrations/node-binary.ts:159`) and is not this process's own `process.execPath` when it is the desktop sidecar. Only when none qualifies does it fall back to `resolveNodeBinary()` (`:69`), the bundled sidecar in the desktop app. The fallback is documented where it lands: the doctor and the pre-flip CHANGELOG say that a terminal whose entry names the bundled Node loses its Tandem tools across a desktop update until it restarts, and how to install Node to avoid it. On macOS a GUI-launched app's `PATH` usually holds no Node, so the fallback is the common case there. Claude Desktop entries keep today's choice. The launcher's own config (§3.3, route L) always uses the server's own Node: the child dies with an update anyway.

**Rule: which script.** The bridge bundle is self-contained (`sidecarBundle("stdio-bridge")`, `tsup.config.ts:106`). The writer records `STDIO_BRIDGE_DIST` when `isDurableInstallLayout` (`apply.ts:1795-1811`) accepts it. A Linux AppImage runs from a per-run mount that is gone when Tandem quits, so a path there dies with the app and every launch would rewrite the config, widening #1599's window per launch. **Probe-contingent on a PR 2b build step** (is the AppImage's resource dir inside the mount? expected yes): if it is, the writer copies the bundle once per version to the app-data root's `bin/stdio-bridge-<version>.js` (owner-only, as §3.3's file) and records that path, so the entry changes only on a version change; `isDurableInstallLayout` gains an AppImage-mount refusal so no caller records a mount path. If it is not, the resource path is recorded as on other platforms.

**Rule: no `npx` floor for Claude Code.** When no absolute pair can be built (a Debian `nodejs` basename, a `..` in the path, a missing bundle), `buildStdioTandemEntry`'s `npx` floor (`:453-480`) would cost every terminal a registry round-trip per start, fail offline, and is unmeasured for environment pass-through. So for `claude-code` the writer keeps the **direct-HTTP** entry instead, the migration declines, and the doctor names why. *Probe-contingent on a build-step probe of an `npx` bridge* (start time, offline behaviour, and that `CLAUDE_CODE_SESSION_ID` arrives): if all pass, the floor may be allowed later; until then, never.

**Rule: the migration**, in the boot sweep (`refreshAllMcpEntryBinaries`, `apply.ts:2098`), which `src/server/index.ts:937-945` awaits before the launcher starts (`:960`):
- **Its own branch, before the `command` check.** An HTTP entry has no `command`, so it would return at `apply.ts:1995` before `classify` runs, and it would fail convergence's `env` gate (`:1895-1896`). So the migration is a separate pre-`command` branch for the `tandem` key, scoped to the `claude-code` target kind, not a `classify` arm. It matches exactly `{type: "http", url, headers?}` with `url` equal to `${MCP_URL}/mcp` and `headers`, if present, exactly `{Authorization: "Bearer <token>"}` with a token that passes the bridge's own token check. Anything else — another URL or port, any other header or key, a malformed token — is left exactly as found. A hand-written entry identical to ours cannot be told apart and is migrated, the bound npx convergence accepts.
- **Only from an installed build.** It runs only when the writer would record a durable path (`isDurableInstallLayout`, which already refuses a dev checkout through its `.git` ancestor walk) and a system or bundled Node resolves; so `npm run dev:server`, `tsx` and `cargo tauri dev` on Bryan's machine never rewrite his real config. The vitest root `test.env` and the E2E server's `env` (`playwright.config.ts:120-128`, which isolates only `TANDEM_APP_DATA_DIR` today) also set a client-config home override that `detectTargets` honours, so the sweep reads a scratch home; a wiring test in PR 2b pins both, and a test pins that the migration declines from a checkout layout.
- **The token** moves verbatim from `Authorization` into `env.TANDEM_AUTH_TOKEN`; the sweep never reads the token store, so `TOKEN_FILE_REFERENCES` in `tests/docs/config-writer-set-claims.test.ts` is unchanged, and a token that was already stale stays stale until `tandem rotate-token`. It is the sweep's first `env` write, and exactly `STDIO_ENTRY_ENV_KEYS`, so the next boot reads its own output as ours.
- **One write, re-checked.** It runs inside the existing one-read, one-write-per-config path (`apply.ts:2129` reads, `:2199` writes), so `WRITER_SITES` (`config-writer-set-claims.test.ts:134-151`) stays at 9. Claude Code rewrites the same file itself, so immediately before the write the sweep re-reads the file's mtime and size and skips the write if either changed since its read, logging it and retrying at the next boot.
- **Re-picking Node.** On every boot the sweep repoints a Tandem-written `claude-code` bridge entry whose `command` is gone, or is the bundled sidecar while a system Node now qualifies, to the system Node. The doctor names a `tandem` entry whose `command` or script is gone ("restart Tandem to repair it, or run `tandem setup`").
- It logs one distinct line per migrated config, naming the file, never the token.

**#1599.** On master the sweep's write to the user-level Claude Code config essentially never fires; the migration makes it fire once on every install, at the pre-flip release, and the Node re-pick can fire again after a Node move. PR 2b amends #1599's register entry: the migration and the re-pick are convergence-class triggers; Claude Code itself is a writer of the same file, so the race includes it; the mtime-and-size re-check narrows it to the moment between the re-check and the rename, where a Claude Code write can still be lost; and a stale write-back by a running Claude Code can revert the migration, which the next boot redoes. That residual is recorded as the entry's bound.

**Live behaviour changes in the pre-flip release**, tested in PR 2b and in its CHANGELOG. Once the user-level entry is the bridge, a dark Tandem's Claude child (still loading that entry before route L exists) sends its session id:
- **"Another AI is on" stops counting the child's own transport.** `hasLiveEntryOtherThan` (`src/server/mcp/transport-registry.ts:273-287`) counts any live entry with no `claudeSessionId` as another AI, so today a child on the HTTP entry counts itself; with an id in `ownChildSessionIds` it is excluded, as the comment at `supervisor.ts:1215-1218` already assumes. Fewer starts are refused.
- **The greeting classifier sees ids.** A reply with no id is counted as possibly the child's greeting (`supervisor.ts:1265-1272`); with the bridge, the child's reply carries its id and a terminal's carries another, so the classification becomes exact.

**Rollback.** There is no reverse migration. A bridge entry works against an older server, which ignores the headers it does not know. A release before PR 2b, reinstalled, keeps the bridge entry (its sweep repairs the bridge's paths, `isOwnStdioBridgeScript`, `apply.ts:1617-1619`), and its own `tandem setup` writes the HTTP entry back; from PR 2b on, `tandem setup` writes the bridge. The pre-flip CHANGELOG says so.

**Tandem's own record is unchanged.** `integrations.json`'s `claude-code` record keeps `transport: "http"` (`src/server/integrations/schema.ts:117-128`, `.strict()`), read as how Tandem's endpoint is reached, which the bridge also uses. Its only readers that branch on it are the wizard's reachability check (`src/client/hooks/useReachabilityCheck.svelte.ts:175-210`), which should still probe the server, and the launcher's "configured" test (`readIntegration`, `supervisor.ts:1507-1512`). No schema bump.

**The wizard and the doctor.** `validateTandemEntry` (`src/server/integrations/existing-config.ts:126-183`) already accepts the bridge shape, so the wizard reads a migrated entry as valid and offers an HTTP entry an "update" diff. `tandem doctor` reads config, not live transports, so for a direct-HTTP or unrecognised `tandem` entry it reports what that costs (the terminal is a separate session; under route E, Tandem's Claude is not present, §8.1) and the fix (`tandem setup`), and it always adds "terminals opened before Tandem migrated the entry keep the old one until they restart". The live counterpart is rule 3's refusal sentence (§3.1). The duplicate-toolset warning (`src/cli/doctor.ts:2455-2470`) stays, worded as cosmetic.

**What still reaches a direct-HTTP entry.** A terminal started before the migration, until it restarts. A boot whose store another instance holds read-only skips the sweep (`src/server/index.ts:937`, `!isStoreReadOnly()`); the next boot that owns the store migrates. A hand-edited or foreign entry, an entry where no absolute Node resolves, a project-scope `.mcp.json` entry setup never wrote, and other MCP clients. Each is rule 3's `http` record and §9.3's unlinked shim. Under route L none of them affects Tandem's Claude's child; under route E the child's own entry decides its presence (§8.1).

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
| Tandem's Claude becomes present without a start (Off→On, Configure) | Every **unowned** document → `default`; `claimed` documents still wait for a run start (decision 2). A call made in v5, reversing the plan's "Off→On moves no documents"; Bryan accepted it on 2026-11-05 and plan rev 8 carries it |
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

v4.1 §3.4a is kept, flag-on only: every MCP mutation and every ownership change on a document runs through a per-document serial queue, and the ownership check is the first thing inside the operation, using the `ownerId` passed in (§3.1); a test interleaves two records' operations on one document to pin it. Refusals decided by the arguments or by facts fixed at open (`LICENSE_REQUIRED`, `NO_DOCUMENT`, `DOCUMENT_REQUIRED`, `INVALID_ARGUMENT`, `INVALID_PATH`, `READ_ONLY`, extension-decided `FORMAT_ERROR`) run before the queue and never claim. Refusals decided by live content, the disk or the save lock (`INVALID_RANGE`, `RANGE_MOVED`, `SAVE_IN_PROGRESS`, `EXTERNAL_CONFLICT`, serializer `FORMAT_ERROR`, I/O) run inside and keep the claim. Browser edits and the reload family stay outside the queue. PR 1c re-derives v4.1's line numbers, which are stale. **Flag off, there is no queue:** handlers run their bodies directly, as today, pinned by a flag-off interleaving test.

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
| `answered` | The item already has another answerer (§5.5) | "{holder} already answered this. Do not answer it again." |
| `lost` | The caller lost this document and holds a blocking loss record for it | Cause `released`: "This document was released from you. You can still read it. Do not `tandem_open` it again unless the user asks you again after this point." Cause `taken back` (a starting run, or Tandem's Claude's own `tandem_open`): the same, with "Tandem's Claude took this document back". Cause `assigned` or `taken` (the new holder's kind is `assigned` or `opened`): "{holder} has this document now. Only the user can reassign it, from the owner badge on its tab. Do not retry." |
| `held` | `opened` or `assigned` by another record | "{holder} is working on this document. Only the user can reassign it, from the owner badge on its tab. Do not retry." |
| `claimed` | `claimed` by another record | "{holder} picked this document up while Tandem's Claude was away. Call `tandem_open` on it only if the user asked you, in your own conversation, to work on it." |
| `default` — on a reply, thread answer or post | The document is Tandem's Claude's `default` | "Tandem's Claude answers this document's comments and chat. Do not answer this, and do not take the document because of it. If the user asked you in your own conversation to say something here, call `tandem_open` on it first." |
| `default` — on an edit, comment or other write | Same | "Tandem's Claude is answering this document. Call `tandem_open` on it only if the user asked you, in your own conversation, to work on it. An item Tandem pushed to you is not such a request." |
| `not-present` | Tandem's Claude, while not present, writing or posting to an unowned document | "Tandem's Claude is turned off or stopped, so it holds no documents now. Leave this document." |
| `unlinked` | `/api/channel-reply` from a shim the server cannot match to a record (§9.2) | "This reply could not be matched to your Tandem session. Send it with the `tandem` server's `tandem_reply` tool instead." |
| `unbound-child` | Any write, post or reply from an unbound-child record (§3.1 rule 1), checked before every other row; it replaces the copy that would name Tandem's Claude as someone else, including a refused greeting | "This Tandem connection was not started by Tandem's launcher, so it cannot act for Tandem's Claude. Use your other Tandem toolset; if you have none, stop and tell the user to check Tandem's Settings." |

No copy carries handle guidance or a two-toolsets clause (both dropped with the bridge route, §3.1, §3.3). No copy names the developer: it says "the user". A recipient that **is** Tandem's Claude gets, for `lost`: "A session the user is working with has this document now; leave it."

**Loss records.** A record keeps, per document it lost this run, the cause and the new holder, until that document changes owner again — and going to unowned counts as a change, so a terminal whose document was taken back can claim it again once Tandem's Claude stops being present. Causes `released`, `taken back`, `assigned` and `taken` are **blocking**: while one stands, the record cannot implicitly claim the document (a write, a post or a poll), and its polls do not read it even when it is unowned; `tandem_open` still takes it under §4.2, and the copy above says when. This makes Release last while Tandem's Claude is not present. A lapse records nothing blocking. The `tandem` record gets no loss record when it stops being present.

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

**The first-run greeting** (#2193) is Tandem's Claude's post, accepted under rule 2 either on a document it holds or doc-less. The greeting classifier (`isGreetingReply`, and the supervisor's own-child checks at `supervisor.ts:1270` and `:1310`) keys today on the reply's session header and treats a reply with no header as possibly the child's. Under the flag it keys on the calling transport having been bound with the current spawn's handle at `initialize` (§3.3), on the MCP path only; a `/api/channel-reply` reply is never the greeting. This lands in PR 3a with the handle, and works there although the bind itself is inert until 3b.

## 8. Tandem's Claude: presence, take-back, starting, waking

### 8.1 Presence (R4.3, decision 11)

**Rule.** Tandem's Claude is present when all of these hold, read from the supervisor's own fields:
- `startedThisRun` (new in PR 3b): a spawn has reached the post-spawn point this server run (`supervisor.ts:1985-1998`);
- `configured === true` (a tri-state today);
- **`bindable`** (new in PR 3b; Bryan, 2026-11-05: "Not present" while the child cannot bind): computed at each plan build, beside `configured`. Under route L (§3.3) it means the supervisor could build this spawn's launcher config: `STDIO_BRIDGE_DIST` exists and its own Node is valid (it always is; the bridge is what can be missing). Under route E it means the integration record's `configPath` holds a `tandem` entry the sweep classifies as a Tandem-written bridge. A false value is announced like `configured` becoming false, with the 5-second settle, and Settings and the composer say why ("Tandem's Claude can't connect its Tandem tools: run `tandem setup`"). While it is false Tandem's Claude still runs and answers chat as today; it holds nothing, so sessions claim as they would with it Off;
- its in-memory `standby` is not `"off"` (`supervisor.ts:1069`) — the supervisor's live state, not the saved `lastGoodSettings.startMode`, which can disagree when saving Off fails;
- `breakerTripped` is false;
- `lastError` is unset, or a restart is underway: `restartTimer` is set or `launching > 0`. Today's `lastError` values are `needs-login`, `unlicensed`, `cli-unusable`, `binary-not-found`, `spawn-failed`, `stop-failed`, `circuit-open` and `wake-delivery-failed`; any of them with no restart underway is staying down. A new value counts as staying down; an exhaustive-switch test makes adding one a decision. `status-check-failed` (`src/shared/launcher/contract.ts:240`) is a `LauncherErrorCode` the status **route** returns when it cannot read the supervisor (`src/server/launcher/api-routes.ts:286`); the supervisor never sets it as `lastError`, so the switch's input type excludes it rather than classifying it.

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

With `bindable` in presence (§8.1), the predictable causes — no bridge to build, or under route E an unrecognised user-level entry — make Tandem's Claude not present, so it holds nothing and nothing waits on it. What remains is a fault: a later Claude Code build that changed what probes 1, 6 or 9 measured (§3.3), or a bridge that failed to start. A child that never binds runs as an ordinary record — an unbound-child record if its bridge sends the child's id, else `http`. Its documents stay with the `tandem` record, so the inbox hands them to nobody, and their items stay waiting after it exits; the next start answers them. If every run fails to bind, the stale hint shows that Tandem's Claude has not polled since items arrived (the composer shows "→ Tandem's Claude (not checking in)" from then), and Bryan can Assign another session (§10.2, §15). A stub child that never presents its handle tests this (R2.5).

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

**Rule.** After the body checks (`src/server/mcp/channel-routes.ts:124-133`) and before the greeting classifier and the append (`:137-145`), the route maps the header in §9.1's order and applies §7.3's acceptance and §5.5's answered-once check, passing the mapped record explicitly:
- Tandem's Claude's session id → never accepted as Tandem's Claude, because the header is never enough to act as it (R3.3). Today's code expects the child's shim might send the greeting this way (`channel-routes.ts:158-160`); under the flag that reply is refused with `unlinked`, whose remedy leads to the `tandem` server's `tandem_reply`, where the bound child is accepted;
- a `claude:<id>` record → accepted or refused as that record;
- unmapped → if the target message's owner is Tandem's Claude, refused with `chat` (one refusal instead of two); otherwise `unlinked`.

A refusal is HTTP 409 with the `NOT_DOC_OWNER` body; the shim relays a failed reply's status and body to the model as the tool result.

### 9.3 A direct-HTTP terminal's shim (R4.8, settled)

**Problem.** From PR 2b, one release before the flip, `tandem setup` writes the bridge (§3.6), whose transport sends the same `X-Claude-Session-Id` as the terminal's shim, so a migrated terminal's shim is linked like a plugin terminal's. What remains is a terminal whose `tandem` entry is still direct-HTTP (`apply.ts:514` today): one started before the migration, or an entry setup did not write or could not migrate (§3.6). Its shim sends the id; its MCP transport does not (probes 3, 5), so no record carries that id.

**Settled: such a shim is never linked.** It keeps today's full stream (R3.4), and its replies are refused with `unlinked` (or `chat`, §9.2); the remedy sends the model to the `tandem` server's `tandem_reply`, checked as the terminal's `http` record. The ways to link it were each ruled out:
- **Expanding `${CLAUDE_CODE_SESSION_ID}` in the entry's headers** — measured (probes 4 and 5): Claude Code expands header variables from its own process environment, which does not hold its own session id (only its children get it). The header arrived as the fallback value, or, for a `claude` started inside another Claude Code session, as the **parent's** id. It cannot link, and setup must never write it. Rewriting the entry as the bridge is the link (§3.6).
- **A pairing id written by setup** names the install, not the session: two terminals sharing one `.mcp.json` would each answer as the other.
- **A value the model carries between the two servers** depends on every model and every older skill doing it, and fails silently when they don't. The refusal and its remedy reach the same end with no new protocol.

The cost is a single-session change for the flip's CHANGELOG (§14), now limited to unmigrated entries. Plugin terminals and migrated setup terminals, whose bridge and shim send the same header, are linked.

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
- **No names.** v4.1's session rename is not built (Bryan, 2026-11-05: "doc names in the assigned list is ok"): a nickname set through a route any local process can call would put chosen text on the badge. The Assign list's held-document basenames do what rename did — tell two terminals apart. They are session-influenced, like tab titles, so they are shown quoted and subordinate to the server's display kind and label (§11.3).

## 11. Security posture

### 11.1 The headers (R3.3)

`X-Claude-Session-Id`, `X-Tandem-Client-Id` and `Mcp-Session-Id` **select** among identities and are not proof. Any local process can send any value, and the ids are easy to find: transcript file names, child process arguments, `launcher-session.json`, and — for `Mcp-Session-Id` — `tandem.log`, which logs it today (`server.ts:553`, `:562`, `:892`; `transport-registry.ts:314`, `:344`, `:413`). Under the flag those log lines print a short hash instead. An `Mcp-Session-Id` selects a transport (`dispatchToSession`, `server.ts:865`) and so its record: for an `http` record it is the whole identity, and for a transport bound to Tandem's Claude it is equivalent to the handle for the rest of that run (§11.2). None of these headers, nor `X-Tandem-Owner-Handle`, is or may be in `Access-Control-Allow-Headers` (`api-routes.ts:174` allows only `Content-Type`), which is what keeps a local web page from sending them.

Within D4 — ownership coordinates Claude sessions and is not a security boundary; every local process already holds every write, since loopback callers bypass bearer auth — a forged id gets everything the named record has: its narrowed event stream; its reply rights on `/api/channel-reply`; and, on an MCP transport, its documents, its answerer rights, and acknowledgement of its inbox items. A forged transport or stream also keeps a dead terminal's record attached, so its documents do not return; and an `initialize` carrying an unlinked shim's session id creates a `claude:` record that its stream then maps to, narrowing a stream §9.3 leaves whole (R3.4 holds only for ids no record carries). A forged `X-Claude-Session-Id` never gets Tandem's Claude's rights: binding to the `tandem` record needs the live handle as well (§3.3); Tandem's Claude's id never names a shared record (§3.1); and the channel route never maps a header to Tandem's Claude (§9.2). A bound transport's `Mcp-Session-Id` is the exception, covered with the handle in §11.2. A forged child id on `/api/events` gets at most the `tandem` record's narrowed stream, never more than today's unmapped stream. PR 4 records this in `docs/security.md`.

### 11.2 The handle is a bearer secret

It is minted per spawn and dies at that spawn's teardown (§3.3). Bryan chose on 2026-11-05 that it never goes in the transcript (option (b)), then to probe and narrow its reach. Tandem never writes it into a prompt, a tool result, the transcript, `launcher-session.json` or any Claude Code config. Holding the live handle and the child's session id, a process can bind as Tandem's Claude for the rest of the run: it is handed Bryan's `default` documents' items and doc-less chat, and its answers, edits and posts are accepted as Tandem's Claude and shown as such. Where the handle can be read depends on the route, and PR 3a files the one that ships in `docs/security.md` (§11.3, item 4):
- **Route L (launcher config).** The handle is in one file, the spawn's launcher config: owner-only, in the owner-only app-data root, deleted at teardown and swept at boot (§3.3). It is in the environment of the one bridge process Claude Code starts from that entry, and nowhere else: not the child's Bash, hooks, other MCP servers or plugin processes. A same-user process can read that file, or that bridge's environment, while the run lasts.
- **Route E (environment), only if probe 9 fails.** Every process the child starts inherits it: the reaper that launches the child, every MCP server the child starts — Tandem's bridges, the shim, and **third-party MCP servers** — the plugin's processes (the monitor, the plugin's bridge), **hooks**, the child's Bash commands and anything they run, and a nested `claude`. Each of them can also read the child's session id (probe 1 saw a tool subprocess receive it), so each holds both halves of the bind check. A same-user process can read any of their environments (`/proc/<pid>/environ` on Linux, `ps eww` on macOS, the process's PEB on Windows). And a child that prints its environment puts the handle in its own transcript.
- **Both.** A bound transport's `Mcp-Session-Id` carries the same rights for the rest of the run without the handle (§11.1).

The Settings list of bound transports (§3.3) makes an extra bind visible next to the child's own. Within D4 this is coordination, not a security boundary: the same process could already write every document through `/api`.

Hygiene: an invalid handle has no side effects and is never echoed or logged. A redaction for `th_[A-Za-z0-9_-]{32}` is applied at the log sink, so it covers every line where the child's own output reaches `tandem.log` (including `supervisor.ts:2434`, `:2527` and `:2562`), not only `sanitizeForLog`. The launcher config's path, never its contents, may be logged. Unprobed, and a PR 3a build step: whether Claude Code's own debug logs record an `--mcp-config` entry's `env` or a stdio server's environment; what it finds is filed under item 4.

### 11.3 Exposures filed for Bryan (R3.5)

PR 5 adds the owners entry to `docs/security.md`, in the wider form Bryan accepted on 2026-11-05 ("wider is fine"), beside the two he confirmed on 2026-11-04:
- **The owners list is readable by local pages.** Any page served from an allowlisted `127.0.0.1` origin can list the attached sessions' labels and display kinds, **and which session holds which document**: the owners list's held basenames, the owner fields on every `Y_MAP_OPEN_DOCUMENTS` entry (which every editor client syncs), and, to any local MCP client, `owner` on `tandem_listDocuments` and `tandem_getAnnotations`, `ownership.notYours` in `tandem_checkInbox` and `holder` in every refusal. Document names and paths are already on those entries; the mapping is new. The Assign list's document names and the Settings list of bound transports (§3.3) are part of it.
- **Any local process can Assign or Release a document or a chat message**, including a Claude session using curl, bypassing the `opened` and `assigned` refusals; so can a page on an allowlisted `127.0.0.1` origin, which CORS admits with a JSON body. A released session is told only that the document "was released", never that the user chose it. This is coordination, not security (D4).
- **The badge also shows each holder's recent activity**: "(disconnected)", "(not checking in)" and the stale flags tell any editor client, and so any page that can authenticate, when a session last polled or held a stream. PR 5's owners entry says so in one sentence.

**The full `docs/security.md` filing list** across the series: (1) the owners list, as above (PR 5); (2) Assign and Release by any local process or page (PR 5); (3) the three identity selectors — `X-Claude-Session-Id`, `X-Tandem-Client-Id`, `Mcp-Session-Id` — and what a forged one gets (PR 4, §11.1); (4) the handle in the child's environment, as §11.2 states it (PR 3a); (5) #1952 moves from accepted to fixed (PR 1b, §11.6). PR 3a's build steps also probe whether Claude Code's own MCP debug logs record `Mcp-Session-Id` or a stdio server's environment, and how `X-Tandem-Client-Id` appears in Tandem's and Claude Code's logs, and file what they find under (3) and (4).

Held-document basenames are session-influenced text (a session chooses file and scratchpad names, and `tandem_rename`), as tab titles already are. The Assign list renders them quoted, truncated and visibly subordinate to the server's display kind and label, never in the display kind's place.

### 11.4 What a non-loopback bind would add

ADR-056 ships the non-loopback bind dark. If it were re-enabled, LAN MCP peers would become records that can hold and take documents and read labels, through the #1906 path. PR 1a records this in ADR-054 and amends ADR-056's re-enable checklist with a new item, and updates its item 5, which un-suspends v4.1 stories that v5 does not re-status. This PR does not edit ADR-056.

### 11.5 Licence

Every new path that writes to the child (`requestWake`, take-back's owed wake) or to an AI's push channel (the two `ownership` frames) refuses through `aiRefusal()` (§8.6). The routes stay keyless (§10.1).

### 11.6 `#1952` and `peerIsLoopback`

**PR 1b lands now** (Bryan, 2026-11-05: "land the wakeurl fix now"), independent of ownership and ungated by its flag, since it is a security fix in its own right. So that it truly lands now, **PR 1b adds `peerIsLoopback` itself**: `McpRequestContext.peerIsLoopback`, set from `req.socket.remoteAddress` through `isLoopback` inside the request context that wraps the whole awaited `handleRequest`. PR 1a then builds on it rather than adding it.

**Rule.** `wakeUrlField()` (`src/server/mcp/wake-url.ts:57-60`) returns the field only when the current request's context says `peerIsLoopback === true`. A missing context, or a context without the field, omits it: fail closed, matching the function's own "absent rather than present-and-undefined" contract (`:50-56`). `wake-url.ts` reads `peerIsLoopback` through one narrow getter and nothing else from the context, and §3.1's context-getter seam test (PR 1a, landing after) allowlists exactly that file and that getter.

**What 1b amends**, so nothing still calls #1952 accepted:
- `docs/security.md`: #1952's entry (`:673`) moves from Accepted (bounded) to fixed, and the narrative line that records the 2026-10-05 move (`:307`) gains the reversal.
- `docs/decisions.md`, ADR-056: the "not dormant" amendment (`:2896`) and the Findings paragraph (`:2939`) say #1952 is fixed; re-enable item 3 (`:2950`) is marked done; item 7 (`:2954`) names #1906 alone.
- `CLAUDE.md`'s Security bullet (`:260` on master): "thirteen are accepted" becomes "twelve", and "the two bind-level findings #1952 … and #1906" becomes the one, #1906. `tests/docs/security-findings-claims.test.ts` derives the count word from the register's Accepted subsection, so it fails until both agree.
- #1952 is reopened and closed by the PR.
- Tests: `wakeUrl` is present for a loopback peer, absent for a non-loopback peer and absent with no context, across `tandem_status`, `tandem_open` and `tandem_scratchpad`.

### 11.7 Unchanged

No new `NON_LOOPBACK_ALLOWED` entry. `/api/wake` keeps its own origin and address checks. The rest of `/api` stays ungated by ownership: a session refused `NOT_DOC_OWNER` that holds Bash can still curl `/api/save` and the other mutating routes, which no refusal copy names.

## 12. Shipping dark

**Flag.** `OWNERSHIP_ENABLED`, a literal `const false` in `src/shared/constants.ts`, injected by tsup as `__OWNERSHIP_ENABLED__` into both the server and cli blocks (the cli inlines server code). `src/server/ownership-flag.ts` reads it per call, like `src/server/file-io/docx-flag.ts`, with the same `TANDEM_TAURI_SIDECAR` warning when the define is missing. With no define (tsx, vitest), `TANDEM_OWNERSHIP=1` turns it on. The define-less bundles (the stdio bridge, the shim, the monitor, `src/shared`) never read the flag: what they add (the bridge's client id and its forwarding of `TANDEM_OWNER_HANDLE`, PR 4's consumer handling) is unconditional and ignored by a dark server.

| Requirement | How |
|---|---|
| Release builds never carry the flag | A test pins the literal `false`, in the style of `tests/docs/license-flip-consts.test.ts` |
| A shell export can't make a half-on build | `tsup.config.ts` derives the define from the literal and reads no environment variable for it (pinned by a test). A seam test pins that every bundle reaching `ownership-flag.ts` carries the define and every define-less bundle never reaches it (as `tests/server/license-module-seam.test.ts` does for the licence). The client needs no flag: the badge, composer line and menu leaves appear only when document entries carry owner fields, which a dark server never writes |
| Ownership code is under a blocking test | Each ownership test file turns the flag on for itself with `vi.stubEnv("TANDEM_OWNERSHIP", "1")`, so it runs in `check`. Unlike `TANDEM_DOCX`, which the root `test.env` sets for every suite, `TANDEM_OWNERSHIP` is **not** in the root `test.env` (which beats the shell): the default run is flag-off |
| A positive anchor | One anchor test, in a file of its own that never stubs the variable, runs only when the flag is on (`it.runIf(ownershipEnabled())`); the flag-on job's runner refuses unless it reports at least one pass. Only that file may use `runIf` on the flag (pinned). From PR 1c a second, runtime anchor starts the **built** server and asserts it refuses a non-owner write, so a build whose define override failed cannot pass. From PR 5, which lands the first ownership E2E spec, the job runs Playwright with a `json` reporter and the runner also refuses unless at least one ownership E2E spec passed; those specs gate on a **runtime** signal (`tandem_checkInbox`'s output schema in `tools/list` carries the `ownership` field), not on the literal |
| Each PR is green flag-off **and** flag-on | A rule for PRs 1a–5. `ownership-flag-on` is a **required check** on `master` while ownership is dark (Bryan, 2026-11-05: "ok, as you recommend"): a build step of PR 1a, done in branch protection by someone with admin access once the job has run green on `master`, and removed at PR 6. It blocks merging **any** PR (#2360's and Dependabot's included). PR 1a also adds the rule to `.github/pull_request_template.md` and to CLAUDE.md's "ships dark" entry and its required-checks list, so the reason is written where mergers look, and the rule holds in the window before the protection change lands. A test that pins dark behaviour stubs the variable to `""` for itself; each PR lists such tests under "changed tests" (§17). Unit tests that call handlers directly flag-on use the caller helper PR 1a lands with the fail-closed default (§3.1). Each PR's "changed tests" are what a flag-on run of that PR actually turned red, measured, not predicted. The E2E helper (`tests/e2e/helpers.ts`) sends one fixed `X-Tandem-Client-Id`, so every spec's client is the same `bridge:` record and a document one spec opened never refuses the next (PR 1c). Flag-off, a per-tool precedence pin keeps today's error order |
| Nothing visible while dark | `tools/list` is built per `McpServer` from the flag: no `ownership` output field, no `NOT_DOC_OWNER` text, no new codes in descriptions. Caller resolution and the fail-closed default, the hashed session ids in logs, the composer's `CTRL_ROOM` summary, the owner-field restore, the operation queue itself (handlers run their bodies directly), scope exclusion, acknowledgement scoping, the handled filter, the handover, the start-rule change, `startOrWake` and both frames are bypassed. Nothing is stamped: no owner fields on document entries, no `settles` or `superseded` on chat rows, no handle minted, no launcher config written, no `--mcp-config` or `--settings` argument, nothing added to the child's environment. **Not part of the dark surface:** the bridge setup entry and its migration (PR 2b) and the #1952 fix (PR 1b) ship live by Bryan's decision (§3.6, §11.6); they are visible before the flip on purpose |
| A required flag-on job | `ownership-flag-on` in `.github/workflows/ci.yml`. `scripts/ci/build-ownership-on.ts`, run under tsx (`tsup.config.ts` imports a `.ts` module), loads the config array and calls tsup's `build({...block, define: {...block.define, __OWNERSHIP_ENABLED__: "true"}, config: false})` once per block (without `config: false`, tsup would load the config itself and merge the passed options over every block). Then `typecheck`, `npm test` and the E2E suite with `TANDEM_OWNERSHIP=1`, and `scripts/ci/ownership-flag-on-runner.mjs` checks the anchors; the job also runs `scripts/ci/vitest-file-anchor.mjs`, so a flag-on run that loses test files cannot read green. About 17–19 runner-minutes per push, in parallel. A wiring test inside `check` pins the job, its env, both scripts, the reporter and the anchors (ADR-051; PR 1a adds the instances-table row, noting that this job is also required while ownership is dark, so its guarantees are enforced twice until the flip makes it advisory or removes it). A full flag-on E2E run is a precondition of PR 6 |
| The bound-launcher path without `claude` | The launcher tests' mocked child (as `tests/server/launcher/supervisor-turn-delivery.test.ts` builds one) reads `TANDEM_OWNER_HANDLE` from the launcher config named by its `--mcp-config` argument (route L) or from the environment it was spawned with (route E), and an in-test MCP client sends it as `X-Tandem-Owner-Handle` with the run's session id at `initialize` to the real HTTP server, or withholds it (R2.5). A bridge-level test runs `mcp-stdio` with the variable set and asserts the header on the first `initialize` and on a re-initialize after a 404 |

## 13. Probes (R5 and R4.8) — measured

Measured on Claude Code 2.1.318, Windows 11: probes 1–4 on 2026-11-04, probes 5–8 on 2026-11-05. Probes 9 and 10 are owed, as PR 3a build steps.

| # | Question | Measured | Used in | If a later build differs |
|---|---|---|---|---|
| 1 | Does a resumed child keep `CLAUDE_CODE_SESSION_ID`? | `claude -p --session-id U`, then `claude -p --resume U`: a tool subprocess saw `U` both times | The bind check's header half (§3.3); the child-id mappings (§3.1, §9.1) | Accept any header on a handle bind; a child's streams become unmapped and keep today's stream |
| 2 | Does a plugin monitor carry a session id? | A monitor (`experimental.monitors`, `when: always`) in an interactive session started with `--session-id U` saw `U` in its environment | Monitor streams map like the shim's (§9.1) | Such monitors are unmapped and keep today's stream |
| 3 | Does Claude Code hold a `GET /mcp` stream? | A direct-HTTP server under `claude -p` saw `server/discover`, `initialize`, `notifications/initialized`, then `GET /mcp` (accept `text/event-stream`) held until the process exited; no `X-Claude-Session-Id` was sent. Interactive mode was not measured; the same transport code is likely, unverified | The 2-minute return (§3.4); the direct-HTTP shim (§9.3); the stateless-era note (§3.5) | A dead terminal's documents return by the reaper bound, about 37 minutes at most |
| 4 | Can a direct-HTTP entry's headers carry the session id by `${CLAUDE_CODE_SESSION_ID}` expansion? | An `http` entry with `"X-Claude-Session-Id": "${CLAUDE_CODE_SESSION_ID:-unset}"`, under `claude -p --session-id V --strict-mcp-config`: every request (`server/discover`, `initialize`, `GET /mcp`) carried `unset`. Run from inside another Claude Code session, it carried that **parent** session's id instead of `V` | Rules out linking a direct-HTTP terminal by header (§3.1, §9.3) | If a later build sets the variable in its own process to its own id, setup could write the header and direct-HTTP terminals would become `claude` records; until then, never |
| 5 | Where does an HTTP entry's `${VAR:-default}` header expansion read from, and does it hold the session id? | An `http` entry's `headers` expanded `${VAR:-default}` from Claude Code's own process environment; `CLAUDE_CODE_SESSION_ID` is not in that environment (Claude Code gives it only to the processes it starts), so the header carried the default. Confirms probe 4 | A direct-HTTP entry can never send the session id, so setup moves Claude Code to the bridge (§3.1, §3.6, §9.3) | As probe 4 |
| 6 | Does a stdio MCP server inherit Claude Code's environment, and receive the session id? | A `stdio` entry (`command: node`) under a Claude Code started with an arbitrary `PROBE_HANDLE` set: the server process saw `PROBE_HANDLE`, and `CLAUDE_CODE_SESSION_ID` equal to the run's session id | The handle reaches the child's bridge (§3.3); a terminal's two bridges resolve to one record (§3.1) | Under route E the handle could not reach the bridge, so route L becomes required; if the id stops arriving, accept a current handle with no id (§3.3) |
| 7 | With an explicit `env` block in the entry, is the inherited environment merged or replaced? | The same, with `env: {TANDEM_URL: …}` in the entry: `PROBE_HANDLE` still arrived beside `TANDEM_URL` — merged, not replaced | The setup entry's own `env` (`TANDEM_URL`, `TANDEM_AUTH_TOKEN`) does not hide the handle (§3.3, §3.6) | Same fallback as probe 6 |
| 8 | Does a `--mcp-config` entry named `tandem` replace a same-name project-scope `.mcp.json` entry, and does its `env` reach the server? | With both present, only the `--mcp-config` entry's server spawned (a control run without the flag spawned the project one), and its `env` block arrived in the server's environment | Route L (§3.3) | Route L falls back to route E |

**Owed (PR 3a build steps, on Bryan's own terminal, e.g. with `CLAUDE_CONFIG_DIR` pointing at a scratch directory so his real config is untouched):**
- **Probe 9.** Does a `--mcp-config` entry named `tandem` replace a same-name **user-scope** entry? *If yes:* route L ships (§3.3). *If the user entry wins, or both load:* route E ships, with §11.2's wider reach filed.
- **Probe 10.** Does `claude -p --settings` with an `enabledPlugins` override that disables the Tandem plugin take effect for that run, and does the child still load the user-level skill? *If yes:* the launcher passes it. *If no:* the plugin's bridge in the child is an unbound-child transport (§3.1).

**Not probed** (each has its fallback where it is used):
- whether `claude -p` loads plugin MCP servers at all (probe 10 answers it on the way);
- a stdio MCP server under `--resume` receiving the id: probe 1 saw a tool subprocess; `src/shared/cli-runtime.ts:134` records Claude Code's changelog saying the id is forwarded on `--resume` since 2.1.163 (§3.3);
- probes 6 and 7 with `npx` as the command, which the plugin's entries use; Claude Code entries never get the `npx` floor (§3.6) until a build-step probe of it passes;
- whether the AppImage's resource dir is inside its per-run mount (a PR 2b build step, §3.6);
- whether Claude Code's debug logs record an `--mcp-config` entry's `env` or a stdio server's environment (§11.2, a PR 3a build step).

The flip's release-smoke rows re-run probes 1 and 5–10 on the release build; the pre-flip release's smoke re-runs 5–7 (§17).

## 14. Conflicts, single-session changes, Bryan's decisions and what is open

| Conflict | Where | What changes |
|---|---|---|
| ADR-011: `documentId` defaults to the active document | `docs/decisions.md` | Narrowed, not superseded: reads and range-keyed writes keep it (writes refuse rather than retarget); replies follow §7.3. ADR-054 records this |
| ADR-049 Decision 1: the inbox arbitrates between sessions | `docs/decisions.md` | Ownership arbitrates; the cursor registry stays the delivery record. Amended in ADR-054 |
| CLAUDE.md: do not key new per-client state on `Mcp-Session-Id` | CLAUDE.md, MCP / Server | `http` records key on it (§3.1 rule 3), the only identity a direct-HTTP client has. ADR-054 records the exception; PR 1a amends the line |
| ADR-045 decision 6: closing the direct-HTTP session-id gap "is a separate decision" | `docs/decisions.md:1840` | Taken: Claude Code's setup entry becomes the stdio bridge (§3.6). PR 2b amends ADR-045; ADR-054 records the decision |
| The boot sweep leaves HTTP entries alone; the user-level Claude Code config "only ever gets the HTTP shape" | `src/server/integrations/apply.ts:1706`, `:2093` | A scoped pre-`command` branch, live from PR 2b, migrates the HTTP shape Tandem wrote (§3.6); PR 2b updates both comments |
| #1952 accepted and bounded by ADR-056 | `docs/security.md:673`, ADR-056, CLAUDE.md Security | Fixed by PR 1b; each is amended (§11.6) |
| #1599's accepted config-writer race | `docs/security.md` register, `tests/docs/config-writer-set-claims.test.ts` | The migration adds no writer site, but makes the sweep's write fire on every install, with Claude Code as a concurrent writer; PR 2b amends the register entry and records the residual the mtime-and-size re-check leaves (§3.6) |
| #2196: no start "if another AI is on" | `supervisor.ts:1410`, `:1432` | Overridden for documents Tandem's Claude holds and the chat it owns (decision 10); unchanged elsewhere |
| #2330's inbox identity pin | `tests/server/inbox-cursor.test.ts:1060-1078` | Amended per §6.8 |
| `NOT_OWNED` (#2360) | annotation lifecycle | `NOT_DOC_OWNER` is answered first; #2360's in-thread acknowledgement needs an `inProgress` marker (§5.5) |
| v4.1 D5, §5.5-A, session rename, `issueHandle`, `ownerLabel` | v4.1 | Dropped or reversed (§0) |
| The plan's call that a chat on a Claude Desktop document can start Tandem's Claude | plan | Moot: §8.3 starts nothing for a document another attached record holds, Desktop included |
| Critical Rule 9 tables | `license-gate-api-coverage.test.ts`, `ai-surface-inventory-claims.test.ts` | Two route rows (§10.1); the new turn and frame writers join the inventory (§8.6) |
| CLAUDE.md's enumeration of routes that call neither gate | CLAUDE.md, `tests/docs/loopback-gate-claims.test.ts` | Unchanged: `POST /api/ownership` calls both |
| `SKILL.md`, `SERVER_INSTRUCTIONS` | `skills/tandem/SKILL.md` | Changed only at the flip (PR 6): follow a refusal's remedy; `tandem_open` a held document only when the user asked in your own conversation; reply with `replyTo`; answer comments in their thread. The flip release also bumps the plugin's pinned ref, so plugin terminals get that skill (§6.4) |

**What changes in the pre-flip release** (PR 2b's CHANGELOG; ownership is still dark):
- Claude Code's `tandem` entry becomes the stdio bridge, on a system Node where one exists: `tandem setup`, the wizard and `tandem rotate-token` write it, and the first boot rewrites an HTTP entry Tandem wrote. Each terminal runs one more Node process. Restart open terminals; until then they keep the old entry. An entry Tandem did not write is left alone and `tandem doctor` names it. Rolling back: reinstall the previous release and run its `tandem setup` (§3.6).
- "Another AI is on" no longer counts Tandem's Claude's own leftover connection, so fewer starts are refused; and its greeting is recognised exactly (§3.6).

**What changes for a single session at the flip**, for the flip's CHANGELOG. The plan's two, worded to v5's copy, then the rest:
1. Another AI client (a terminal or Claude Desktop) next to a present-but-idle Tandem's Claude is refused on Bryan's documents and on doc-less chat, and is no longer handed their items. The refusal says `tandem_open` is right only when the user asked it directly, and Claude starts for those items. (Plan; its wording "the refusal tells it to `tandem_open`" is updated to this.)
2. Tandem's Claude alone and idle-stopped is started by a new comment or a user thread reply on its documents, not only by chat. A comment on a document a terminal claimed while it was Off, and not yet taken back, does not start it. (Plan.)
3. A terminal whose `tandem` entry is still direct-HTTP (one Tandem did not write or could not migrate) has its opt-in shim's replies refused with a remedy (§9.3).
4. A post (`tandem_reply` without `replyTo`) from a terminal is refused on a document another session holds and, while Tandem's Claude is present, as doc-less chat; a post on an unowned document claims it (§7.3).
5. `tandem_switchDocument` is refused on a document another session holds; a `focusParagraph` on such a document is ignored (§5.2, §5.6).
6. `tandem_reply` with a `replyTo` and a contradicting `documentId` is refused with `INVALID_ARGUMENT` (§7.3).
7. Tandem's Claude holds documents only while it can connect its own Tandem tools (`bindable`, §8.1); when it cannot, Settings says why and it holds nothing. (The entry change itself moved to the pre-flip release.)
8. A terminal with both Tandem toolsets is one session, though it still lists the tools twice; on an unmigrated direct-HTTP entry it is two, and writing through one toolset to what it opened through the other is refused (§3.1).
9. An item a lone session answered from a push is no longer handed to it again (§6.4).
10. New visible UI: the composer's "who answers" line, and the badge and its hints wherever they say something (§10.2).
11. A terminal's `tandem_open` of a document Tandem's Claude holds — even just to read it — takes it until Release, Assign or a lapse (§4.2, decision 3).
12. A terminal beside a present Tandem's Claude still takes a "woke, found nothing" turn for each event on Tandem's Claude's documents until Phase 3 (§9.4).
13. Turning Tandem's Claude On gives it back every unowned document, and starts it when items on them, or a doc-less chat sent while it was Off, are still waiting; documents a terminal claimed while it was Off stay with that terminal until a run starts (§4.2, §7.2).
14. A chat on a document Claude Desktop holds no longer starts Tandem's Claude (§8.3).

Item 1's "your documents" means the user's: the CHANGELOG says "your documents", not a name.

**Decided by Bryan, 2026-11-05, first round** (his words quoted; each is written into the design as settled):
1. **PR 1b lands now** — "land the wakeurl fix now". It adds and reads `peerIsLoopback`, reopens #1952, and amends ADR-056, the `docs/security.md` register and CLAUDE.md's Security bullet (§11.6, §17).
2. **Two Tandem toolsets: the bridge route.** `tandem setup` writes Claude Code's user-level `tandem` entry as the stdio bridge, so a terminal's two bridges resolve to one `claude:<id>` record; the duplicate tool list stays, cosmetic, with the doctor's warning (§3.1, §3.6).
3. **The handle: option (b).** It never goes in the transcript; the child's bridge sends it and the server binds at `initialize` (§3.3, §11.2). Its route was narrowed by decision C.
4. **The owners exposure** — "wider is fine": which session holds which document, the Assign list's document names, the Settings list of bound transports, and Release being as forgeable as Assign are all filed (§11.3).
5. **Rename stays dropped** — "doc names in the assigned list is ok" (§10.3).
6. **`ownership-flag-on` becomes a required check while ownership is dark** — "ok, as you recommend" (§12).
7. **R2.6 is narrowed to the poll route** — "ok" (§15, §16).
8. **The plan-text edits** this section used to list — "ok". Applied in plan rev 8; plan rev 9 applies the second round.

**Decided by Bryan, 2026-11-05, second round:**
- **A. Migration timing** — "One release early". The bridge setup entry and its migration ship live, not behind the ownership flag, in a release before the flip; PR 2b is independent of the ownership series (§3.6, §17). Ownership still ships dark.
- **B. Which Node** — "Prefer system Node" for Claude Code terminal entries; the bundled sidecar only as a documented fallback (§3.6).
- **C. The handle's reach** — "Probe, then narrow". Probe 8 measured; the launcher's own `--mcp-config` carries the handle if probe 9 shows it overrides the user-scope entry (route L), else the environment route with its wider reach filed (route E) (§3.3, §11.2, §13).
- **D. An entry the child cannot bind through** — "Not present". Tandem's Claude counts as not present while it cannot connect a Tandem-built bridge (`bindable`, §8.1). Under route L that means the launcher could not build its config; under route E, that the user-level entry is not a Tandem-written bridge.

**Open for Bryan.** Nothing. Probes 9 and 10 decide which documented branch ships (§13); they do not reopen a decision.

**Calls made by the maintainer's session after the final review round** (recorded, not asked): refusals carry no handle guidance (§3.3); Off→On returns unowned documents (§4.2); PR 6 waits for #2360's switch (§17); `answeredChatIds`' global sweep is replaced under the flag (§5.5); each spawn re-owes its held documents' unanswered items (§8.2); unmapped streams get `ownership-changed` (§9.1); `sinceSeq` comes from the claiming pass's counter (§2).

**Calls made folding in the 2026-11-05 decisions** (recorded, not asked):
- `integrations.json`'s `claude-code` record keeps `transport: "http"`; no schema bump (§3.6).
- The migration is its own branch before the sweep's `command` check, scoped to `claude-code` and to exactly the shape Tandem wrote; it copies the entry's own bearer token into `env`, never reads the token store, runs only from an installed layout, and re-checks the file's mtime and size before writing (§3.6).
- Claude Code entries get no `npx` floor: where no absolute Node resolves they stay direct-HTTP (§3.6). npx convergence stays Claude Desktop-only.
- On a Linux AppImage, if its resources are in the per-run mount, the bridge bundle is copied once per version into app-data (§3.6).
- The bind is decided at `initialize`, never refuses the handshake, and requires `X-Claude-Session-Id` equal to the current run's id (§3.3).
- Teardown ends only its own spawn's handle, transports and launcher config (§3.3).
- `TANDEM_OWNER_HANDLE` joins `TANDEM_SECRET_ENV_KEYS` (§3.3).
- Rule 1's exception covers every id in `ownChildSessionIds`, and its records get their own `unbound-child` refusal copy (§3.1, §5.3).
- Dropped with the prompt route: the prompt builders, `ownerHandle` on four tools, `OWNER_HANDLE_CONFLICT`, `INVALID_OWNER_HANDLE`, the absorb rule, the "unbound child" refusal sentence and the argument-level handle scrub (§3.3). The log-sink redaction stays (§11.2).
- The two-toolsets refusal clause is dropped (§3.1).
- PR 1b carries `peerIsLoopback` itself, so it does not wait for 1a (§11.6).

## 15. Known limitations

- **Restart forgets** ownership, answerers, loss records, `handoverSeq` and change notices (decision 8). The handled filter still keeps answered items out of every inbox; an old notice may be handed once more.
- **A client that never holds a `GET /mcp` stream** keeps its documents up to about 37 minutes after it dies (§3.4). An `http` record evicted by the session cap, which any local process can force, becomes a new record and loses its documents after the grace.
- **A direct-HTTP entry Tandem did not migrate** (§3.6): its terminal's shim is never linked (§9.3), and beside the plugin its terminal is two records (§3.1). A terminal started before the migration is in this state until it restarts.
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
- **A run that never binds** for a reason `bindable` cannot see (a Claude Code change, a bridge that fails to start) leaves Tandem's Claude's documents waiting until Bryan sees the stale hint and Assigns (§8.7).
- **The handle is readable for the run** (§11.2): under route L from the launcher config file and its bridge's environment; under route E from every process the child starts. A same-user process can read it. It dies at teardown.
- **The migration and Claude Code share a file** (§3.6): a Claude Code write between the sweep's re-check and its rename can be lost, and a stale write-back can revert the migration until the next boot.
- **The bundled-Node fallback** (§3.6): a terminal whose entry names the desktop's bundled Node loses its Tandem tools across a desktop update until it restarts.
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
| R2.5 | §8.1, §8.7 | A child whose bridge never sends its handle; `bindable` false makes Tandem's Claude not present | 3a, 3b |
| R2.6 | §6.3 | Narrowed to the poll route (Bryan, 2026-11-05). A handover does not hand over the old owner's notices, with an old and a fresh next-owner cursor; the owner's own retry with an old cursor still gets its notices | 2 |
| R2.7 | §8.6 | Assign to a running terminal, take-back while running, a lapse while running, each answered with no new event | 3b, 5 |
| R3.1 | §6.2, §8.3, §8.5, §9.1 | Solo-held items never claim, start or wake; an Assign or Release in Solo over only Solo-held items emits no frame and starts nothing | 2, 3b, 4, 5 |
| R3.2 | §8.6 | AI-surface inventory derivations and licence seam pins | 3b, 4 |
| R3.3 | §3.1, §3.3, §9.2, §11.1 | A forged child id cannot bind, join or pre-create the child's record, or reply as Tandem's Claude; a live handle with a missing or mismatched session id does not bind, and the `initialize` still succeeds | 1a, 3a, 4 |
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
| R4.8 | §3.6, §9.3 | A migrated terminal's shim is linked; an unmigrated direct-HTTP terminal's shim reply is refused with the remedy, and its stream equals today's | 2b (the migration, pre-flip), 4 |
| R5 | §13 | Measured | 0 |

**Flag-on state between PRs.** PRs 1b and 2b are live and independent of the series; both are expected to have shipped before PR 3a, so by then terminals and a dark child carry session ids. After 1a, records exist and nothing is enforced. After 1c, writes are checked, but Tandem's Claude is never present (presence arrives in 3b), so every document is unowned or held by a terminal; the child, sending its session id through its bridge, is an unbound-child record (§3.1) and claims and answers like a terminal. After 2, the inbox is scoped. PR 3a lands the bind **inert**: the handle is minted and accepted, but transports stay on their own records until 3b's presence lands. Between 3a and 3b a child with two bridges (route E, or a plugin bridge probe 10 could not disable) is two unbound-child records, one per transport, and its model may be refused through one toolset on what it opened through the other, as before 3a. After 3b the plan's MCP behaviour is complete. After 4, push narrows; after 5, Bryan has the controls.

## 17. PR sizing

Rough sizes include tests. "Changed tests" lists existing tests whose assertions change, flag-on or flag-off.

**Order.** Two PRs are live and outside the dark series: **1b** (#1952) can merge now, and **2b** (the setup entry) must ship in a release before the flip, so it lands early enough for that release and its own smoke. The dark series is 1a → 1c → 2 → 3a → 3b → 4 → 5 → 6. 3a needs 2b only for its tests under route E; under route L the child's bridge comes from the launcher config. Against rev 7's estimate, 2b adds about 900–1,300 lines and 3a shrinks from 1,000–1,400 to 800–1,100; 1b grows slightly by carrying `peerIsLoopback`.

| PR | Files touched | Scope | Changed tests |
|---|---|---|---|
| **1a. Flag and identity** (may split into "flag and CI" then "identity") | New `src/server/ownership-flag.ts`; `src/shared/constants.ts`; `tsup.config.ts`; `scripts/ci/build-ownership-on.ts`; `scripts/ci/ownership-flag-on-runner.mjs`; `.github/workflows/ci.yml`; `.github/pull_request_template.md`; new `src/server/sessions/ownership.ts` (records, labels, kinds, `ownerByDoc`, `handoverSeq` map, `setDocOwner` with no enforcement and a no-op `startOrWake` stub, the presence seam); `src/server/sessions/context.ts`; `src/server/mcp/server.ts` (records at dispatch, the stdio `local` record, the fail-closed default, hashed session ids in its log lines); `src/server/mcp/response.ts` (caller resolution in `withErrorBoundary`) and `src/server/mcp/awareness.ts` (moving `tandem_reply`'s context read into the wrapper, so the context-getter seam test passes); the test caller helper; `src/server/mcp/transport-registry.ts` (`ownerId`, hashed log lines); `src/cli/mcp-stdio.ts` and `src/shared/cli-runtime.ts` (`X-Tandem-Client-Id`, unconditional); the default rule in the **user-side callers only** (`src/server/mcp/routes/{open,upload,scratchpad}.ts`, startup restore and `welcome.md` in `src/server/index.ts`), never in the shared `src/server/documents/open.ts` that `tandem_open` also runs; the close point in `src/server/mcp/document-service.ts`; `docs/decisions.md` (ADR-054, recording the bridge route and the handle's environment route among its decisions; ADR-051 instances row; ADR-056 checklist items); `CLAUDE.md` (ships-dark entry and merge rule, `ownership-flag-on` in the required-checks list, the `Mcp-Session-Id` line). Build step, admin: add `ownership-flag-on` to `master`'s required checks once it has run green there (§12) | Large: about 23 files, 1,400–1,900 lines | Flag-off: the `tandem_reply` tests that pin today's session-id read, which moves into the wrapper. Flag-on: the roughly 25 test files that register tools directly (`registerDocumentTools` and siblings, `InMemoryTransport` users) move onto the caller helper. The flag seam, context-getter seam, wiring and anchor tests are new |
| **1b. #1952** (live, independent; Bryan, 2026-11-05: "land the wakeurl fix now") | `src/server/sessions/context.ts` (`peerIsLoopback`, moved here from 1a so 1b does not wait for it) and `src/server/mcp/server.ts` (setting it); `src/server/mcp/wake-url.ts` (reads it through one getter, fails closed); `docs/security.md` (#1952's entry and the `:307` narrative line); `CLAUDE.md` ("thirteen" to "twelve", the bind-level findings); `docs/decisions.md` (ADR-056: the amendment, the Findings paragraph, re-enable items 3 and 7); reopen #1952 and close it from this PR | Small: about 6 files, under 300 lines | `tests/docs/security-findings-claims.test.ts`; `wakeUrl` tests for loopback, non-loopback and no-context peers |
| **1c. Enforcement** | New `src/server/sessions/doc-op-queue.ts` (flag-on only; every MCP mutation routes through it here); the tool-mode table and its pin against the registered tools (§5.1); `src/server/mcp/{document.ts, annotations.ts, list-edit.ts, docx-apply.ts, convert.ts, navigation.ts, response.ts, output-schemas.ts}` (the tool wrappers only, never the shared cores); `tests/e2e/helpers.ts` (the fixed client id); the annotation lifecycle's reply path (answered-once for threads); `src/shared/types.ts` (`NOT_DOC_OWNER`); the refusal copy module; `docs/mcp-tools.md`; the flag-on `/api`-and-autosave no-context test. May split into queue-and-placement, then copy-and-answered-once, if review wants | Large: about 14 files, 1,800–2,500 lines | `tests/docs/tool-error-codes-claims.test.ts`; `mcp-output-schemas.test.ts`; #2360's refusal-order tests; tool-description snapshots flag-on |
| **2. Inbox and replies** | `src/server/mcp/awareness.ts` (scope, scoped acknowledgement, claims decided in collection and applied at commit, the handled filter on both paths, the notice rule, `settles`, reply and post acceptance, the `ownership` field); `src/server/sessions/ownership.ts` (handover with retire and `handoverSeq`, chat handover, per-message owners); `src/server/events/delivery-state.ts` (per-document and per-message rounds); `src/server/mcp/annotations.ts` (labels); `src/shared/types.ts` (`settles`, `superseded`); `src/client/panels/chat-pickup.ts`; `docs/mcp-tools.md` | Large: about 9 files, 1,600–2,200 lines | `tests/server/inbox-cursor.test.ts` (the pin); delivery-state tests; `checkInbox` output-shape tests; multi-session inbox tests that expect both sessions to be handed an item (flag-on); chat pickup tests |
| **2b. Setup entry and migration** (live, not behind the flag, independent of the series; ships in a release **before** the flip, with its own smoke; Bryan, 2026-11-05: "One release early") | `src/server/integrations/apply.ts` (`buildMcpEntries`' `claude-code` branch; the pre-`command` migration branch, its durability gate and mtime-and-size re-check; the Node re-pick; the AppImage copy, if the build step needs it; the comments at `:1706` and `:2093`); `src/server/integrations/node-binary.ts` (the system-Node resolver); `src/cli/doctor.ts` (the direct-HTTP, unrecognised and dead-command checks; the restart sentence; the duplicate-toolset wording); the client-config home override in `detectTargets`, `vitest.config.ts`'s root `test.env` and `playwright.config.ts`'s server `env`; the wizard's copy; `docs/decisions.md` (ADR-045 decision 6); `docs/security.md` (#1599's entry); `docs/architecture.md` and `docs/gotchas.md` where they call the entry direct-HTTP; `CHANGELOG.md` (§14's pre-flip lines) | Medium-large: about 12 files, 900–1,300 lines | The migration branch's own suite (match and refuse shapes, scope, durable-layout refusal, the re-check, the token move); `tests/cli/setup.test.ts`, `run-setup-apply.test.ts`, `rotate-token.test.ts`, `tests/server/integrations/api-routes.test.ts` (the bridge shape, live); `node-binary.test.ts` (system Node first); `tests/cli/doctor.test.ts`; a wiring test that both harnesses set the home override; `isOtherMcpClientLive` and greeting-classifier tests with id-carrying child transports; `config-writer-set-claims.test.ts` stays at 9 config sites (the AppImage copy, if built, adds a `DURABLE_WRITER_FILES` count); `tests/shared/npx-entry-spec.test.ts` unchanged |
| **3a. Handle and bind (inert)** | Build steps first: probes 9 and 10 (§13). `src/server/launcher/supervisor.ts` (the per-spawn object holding the handle, its transports and the launcher config; route L's config file under app-data `launcher/` and the boot sweep of leftovers, or route E's `childEnv()` addition; `--mcp-config` and, if probe 10 passes, `--settings` in `buildClaudeArgs`; `TANDEM_OWNER_HANDLE` in `TANDEM_SECRET_ENV_KEYS`; per-spawn teardown; the child-id demotion over `ownChildSessionIds`; bind logging and the Settings list); `src/cli/mcp-stdio.ts` (read and validate `TANDEM_OWNER_HANDLE`, add the header, unconditional); `src/server/mcp/server.ts` (read the header at `onsessioninitialized`); `src/server/index.ts`; `src/server/sessions/ownership.ts` (bind check, unbound-child records); the `unbound-child` copy; the log-sink redaction; the greeting classification; the bound-transports list (a `SupervisorStatus` field, a Settings component and its testid, hidden while dark); `docs/security.md` (the handle, as the route that ships, §11.2) | Medium: about 10 files, 800–1,100 lines | Greeting tests; `buildClaudeArgs` and `childEnv` tests (flag-on: the new argument or variable; flag-off: today's); teardown of a superseded spawn leaves the current one bound; the bridge's header tests; `config-writer-set-claims.test.ts`'s `DURABLE_WRITER_FILES` gains the launcher config's write (not a Claude Code config). The prompt constants do not change |
| **3b. Presence, take-back, starts, wakes** | `src/server/launcher/supervisor.ts` (`startedThisRun`, the presence setters, microtask recompute, the at-once and 5-second announcements, take-back at the post-spawn point, the start predicate and its accumulated bit at `:1410`/`:1432`, the live Off re-check, the Solo-release check, `startOrWake`, `requestWake`); `src/server/index.ts` (wiring `startWorthyFor`, waiting, `startOrWake` and presence); `src/server/sessions/ownership.ts` (presence consumer, waiting, the bind made live); `src/server/events/wake-socket.ts` (the `ownership` frame and its licence check) | Large: about 5 source files, 1,200–1,600 lines, concurrency-heavy | The #2196 start matrix (flag-on); `tests/docs/ai-surface-inventory-claims.test.ts`; licence seam pins; `tests/server/launcher/license-refusal.test.ts` (an unlicensed `startOrWake`) |
| **4. Push and shim identity** | `src/server/events/sse.ts` (narrowing, the `ownership-changed` frame and its licence check); `src/server/mcp/channel-routes.ts`; `src/shared/sse-consumer.ts`; the shim and monitor (`src/channel/`, `src/monitor/`); `docs/security.md` (the headers) | Medium: about 7 files, 800–1,200 lines | SSE and channel-route tests that assume every stream gets every event (flag-on) |
| **5. Controls** | New `src/server/mcp/routes/ownership.ts`; `src/server/mcp/api-routes.ts`; `src/shared/api-paths.ts`; new `src/client/tabs/TabOwnerBadge.svelte`; `DocumentTabs.svelte`; `tab-context-menu.ts`; the chat composer line; `src-tauri/src/context_menu.rs`; `src/server/documents/registry.ts` (`toDocListEntry` fields, the stale tick); `playwright.config.ts` or the job (the `json` reporter); testid snapshot and manifest; the first ownership E2E specs; `docs/security.md` (the exposures, as Bryan confirms them) | Large: about 14 files, 1,300–1,800 lines incl. E2E | `license-gate-api-coverage.test.ts` (two rows); `testid-set.snap.txt` (add-only) |
| **6. Flip** | **Preconditions:** #2360's switch PR has merged (thread replies are the answered-link, decision 6), and PR 2b has shipped in an earlier release. If either slips, the flip waits; no partial skill text ships. The release-smoke rows re-run probes 1 and 5–10 on the release build. Files: `src/shared/constants.ts`; `skills/tandem/SKILL.md` (version bump); `SERVER_INSTRUCTIONS`; `.claude-plugin/plugin.json` (the ref carrying the new skill); docs; `CHANGELOG.md` (§14's flip changes; no config change); the release-smoke checklist; branch protection: `ownership-flag-on` leaves the required checks | Small in code, large in docs | Dark pins removed; skill contract hash and version |
