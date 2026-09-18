# Multi-Session Document Ownership (v4.1) — User Stories

Stories against [the design](./README.md) (v4, 2026-09-16; decisions recorded in v4.1, 2026-09-17), grounded in master `cbccfefd` and the [review set](./reviews/codex-v2.md). 153 stories in 17 areas (141 from the v3 pass, re-statused, plus 11 for behaviour v4 added and 1 for session rename in v4.1); 0 are `GAP`, 0 are `decision-dependent` (the 18 that were in v4 became `covered` when Bryan decided every §5 question on 2026-09-17), 5 are `covered (known limitation)` (OWN-LCH-07, OWN-INB-10, OWN-CHAT-09, OWN-SEC-05, OWN-SEC-10), the rest `covered`. Every one of the 25 v3 GAPs is re-statused in §3 with the v4 section that closes it.

## 1. Summary

v4 closes every gap the v3 pass found, and on 2026-09-17 Bryan decided every §5 question — taking the recommended option in all twelve, which reverses his earlier choices on §5.1, §5.2 and §5.7, and adding **session rename** to §5.12 (OWN-CTL-11). Each story below names the decision it rests on. The four clusters resolve as follows. (1) **Resurfacing** is keyed on a per-item delivered-to ledger (`deliveredTo[item] = {ownerId, at, documentId | null}`, §3.5), so the batch that triggered a claim resurfaces with everything else, and doc-less and closed-document ("detached") chat is in every pass and resurfaces on record death; the one residual — items delivered before a server restart — is now a stated known limitation. (2) The **wake socket** is keyed on an unguessable per-record watch id derived from the owner id (`?watch=`, §3.10): the public label appears in no URL, a re-created record keeps its watch, a handle bind aliases the old watch to the new record, and a live socket pins its transport against the idle reaper (§5.11); the LRU-eviction residual is bounded and stated. (3) Every **refusal class is placed** relative to the queue (§3.4a table): static-state refusals (`READ_ONLY`, format-by-extension, license, handle errors) never claim; live-state refusals (`INVALID_RANGE`, `SAVE_IN_PROGRESS`, `EXTERNAL_CONFLICT`) keep the claim; `tandem_switchDocument` is owner-only outside the queue and never claims. (4) The **launcher child** is told to pass its handle on its first Tandem call, whatever it is, by both prompt builders and SKILL v25 step 1; a child that bound late is absorbed rather than refused (§5.10). Stdio mode has one process-wide record; handles are issued only on request with a stated lifetime; the Assign popover names sessions by kind and client from a loopback-only owners route (§5.12); `#1952` is closed per request. Three new §5 decisions (5.10 absorb-on-bind, 5.11 wake-socket pin, 5.12 descriptor exposure) turn eight stories decision-dependent; the recommended defaults are used throughout and named per story. Two assumptions remain `needs-human-evidence`: whether worktree-isolated subagents share the MCP client, and whether a Monitor socket closes reliably on process exit on each OS.

## 2. Coverage matrix (stories in which the actor appears; a story can list several actors)

| Actor \ Area | A Reg | B Open | C Default | D Group | E Concurrent | F Chat | G Annot | H Inbox | I Controls | J Queue | K Liveness | L Launcher | M Wake | N Security | O Upgrade | P License | Q Cross | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Bryan (Tauri / browser) | 6 | 8 | 1 | – | 2 | 7 | 7 | 6 | 11 | 3 | 1 | 4 | 1 | 2 | 1 | 2 | – | 62 |
| Hand-started, direct HTTP | 4 | 10 | 6 | 5 | 7 | 8 | 7 | 9 | 2 | 10 | 7 | – | 11 | 5 | 1 | 1 | – | 93 |
| Hand-started, stdio bridge | – | – | 2 | – | – | – | – | – | – | – | 2 | – | – | – | – | – | – | 4 |
| Launcher child (supervisor) | – | 1 | 1 | 1 | 1 | – | – | – | – | 1 | 1 | 11 | 1 | – | – | – | – | 18 |
| Claude Desktop (bridge) | – | – | – | – | – | – | – | – | – | – | 2 | – | 1 | – | – | – | 1 | 4 |
| Cowork remote (non-loopback) | – | – | – | – | – | – | – | – | 1 | – | – | – | 1 | 3 | – | – | 1 | 6 |
| Subagent | – | – | – | 2 | – | – | – | – | – | 1 | – | – | – | – | – | – | – | 3 |
| Channel-shim session | – | – | – | – | – | 1 | – | – | – | – | – | – | 1 | – | – | – | 1 | 3 |
| Plugin-monitor session | – | – | – | – | – | – | – | – | – | – | – | – | 1 | – | – | – | 1 | 2 |
| Non-Claude MCP agent | – | – | 1 | – | 1 | – | – | – | – | – | – | – | – | – | – | – | 1 | 3 |
| Hostile / prompt-injected | – | – | – | – | – | 1 | – | 1 | – | – | – | – | 1 | 7 | – | – | – | 10 |
| Upgrader (old bridge / v24 / stale tab) | 1 | – | 1 | – | – | – | – | – | – | – | – | – | 1 | – | 5 | – | – | 8 |
| **Stories per area** | 8 | 13 | 7 | 7 | 7 | 11 | 10 | 11 | 10 | 11 | 9 | 11 | 13 | 10 | 7 | 3 | 4 | **152** |

New in v4 (11 stories, marked "new in v4"): OWN-OPEN-13 (user close makes chat detached), OWN-GRP-07 (handle issuance and lifetime), OWN-CHAT-11 (reply to a detached message), OWN-CTL-09 (owners route, loopback-only), OWN-CTL-10 (assign to a detached-in-grace label), OWN-Q-11 (live-state refusals keep the claim), OWN-LCH-11 (late bind is absorbed), OWN-WAKE-11 (watch id is unguessable), OWN-WAKE-12 (live socket pins the transport), OWN-WAKE-13 (socket follows a handle bind), OWN-SEC-10 (watch id in the transcript is the accepted residual). Thin cells: the bridge-entry hand-started session and Claude Desktop are still covered mostly through the liveness stories; the stdio mode now has its own record (OWN-DEF-07).

## 3. GAP register — v4 status (v3 order kept)

Every v3 GAP, with what v3 lacked, how v4 closes it, and its v4 story status. No row is still `GAP`.

| # | Story | v3 gap (short) | v4 closure | v4 status |
|---|---|---|---|---|
| 1 | OWN-INB-08 | `timestamp ≥ since` excluded the claim-triggering batch | Per-item delivered-to ledger `deliveredTo[item] = {ownerId, at, documentId}`; resurface = entries delivered to X and not handled; earlier-run protection by construction (ledger empty at boot) — §3.5 Resurfacing | covered |
| 2 | OWN-CHAT-07 | Chat on a non-open doc in nobody's scope | "Detached chat" is in every pass like doc-less chat; first poller; claims nothing; `replyTo` reply runs no ownership check — §3.5 steps 2–3, §3.6 (1) | covered |
| 3 | OWN-SEC-05 | Published label + newest-wins = wake hijack | `?watch=<id>`, HMAC-derived per record from `ownerId`, unguessable, never published; label appears in no URL — §3.10; transcript residual accepted in §6 | covered (known limitation: transcript-reading local process) |
| 4 | OWN-WAKE-09 | Socket label drifts from record | Derived watch id is stable per `ownerId` across re-creation; `watchAlias` written on bind; live socket pins the transport against `reapIdle` (§5.11); LRU residual stated — §3.10 | covered · decided (dependent (§5.11) |
| 5 | OWN-Q-08 (+ OWN-OPEN-07) | Refusal placement unstated | Placement table: static-state refusals before the queue never claim; live-state refusals inside keep the claim — §3.4a | covered |
| 6 | OWN-LCH-09 | Child opens before binding | Both prompt builders open with the handle and say "pass it on your first Tandem call"; SKILL v25 step 1 says the same; a never-bound single-transport `mcp:` record is absorbed on bind (§5.10) — §3.8, §3.2 | covered · decided (dependent (§5.10) |
| 7 | OWN-OPEN-10 | `switchDocument` implicit-claims | Owner-only at handler entry, outside the queue, never claims; `NOT_OWNER {ownerLabel: null}` on unowned — §3.3 (4), §3.7 | covered |
| 8 | OWN-DEF-07 | Stdio mode has no identity | One process-wide `stdio:<pid>` record, attached for process life, no handle, `getCurrentOwner()` resolves it when the context is undefined — §3.2 rule 4 | covered |
| 9 | OWN-GRP-05 | Handle lifetime / revival / on-demand | Minted only on `tandem_status({issueHandle: true})`, idempotent per record; live while the record exists (attached or inside grace); inside grace re-attaches; after drop `INVALID_OWNER_HANDLE`; helper re-homed at launcher teardown — §3.2 | covered |
| 10 | OWN-CTL-06 | Opaque labels in Assign | Descriptor `{kind, client}` on doc entries and in `GET /api/ownership/owners` (loopback-only); `tandem_status` returns own `ownerLabel`, `ownerKind`, `ownedDocumentIds` — §3.11, §3.3 (3); `cwd` exposure is §5.12 | covered · decided (dependent (§5.12) |
| 11 | OWN-OPEN-08 | User tab close vs ownership | `onDocumentClosed(D)` before the registry drop: map entry removed, `ownership:released {reason: "closed"}` frame + inbox entry, queue drained `NO_DOCUMENT`; chat becomes detached, nothing resurfaces — §3.4 | covered |
| 12 | OWN-GRP-06 | Remote / isolated subagents | Assumption (own transport → own record) + fallback (idempotent bind) + SKILL v25 hand-off guidance — §3.2 Subagents | covered (`needs-human-evidence` for worktree isolation) |
| 13 | OWN-CHAT-08 | Doc-less chat never resurfaces | Per-record sweep on record death flips every unhandled entry delivered to X, doc-less and detached included — §3.5 | covered |
| 14 | OWN-INB-10 | Pre-restart delivered items lost | Stated as a known limitation with the reason re-flipping at boot is wrong — §3.5, §9 | covered (known limitation) |
| 15 | OWN-CHAT-09 | `channel-reply` cannot mark handled | Stated: route carries no identity, marks handled via `replyTo` only; §5.5-B would thread identity — §3.6 | covered (known limitation; §5.5-A decided) |
| 16 | OWN-SEC-06 | Handle-scrub tool set | Exact set enumerated, live-set comparison, watch ids included — §6 | covered |
| 17 | OWN-SEC-07 | #1952 per bind blinds local sessions | `McpRequestContext.peerIsLoopback` from `req.socket.remoteAddress`; `wakeUrlField()` suppresses per request — §3.10, §3.2, §4 | covered |
| 18 | OWN-Q-09 | `restoreBackup` list mode, `exportAnnotations` | Reads row in §3.7: open to everyone, never claim, before the queue | covered |
| 19 | OWN-OPEN-05 | `tandem_scratchpad` missing from the table | Row: creates, claims, activates (fresh open), accepts `ownerHandle` — §3.4 | covered |
| 20 | OWN-OPEN-09 | Self-owned re-open activation | Row: `claimed: false`, not activated; only fresh open and `switchDocument` activate — §3.4 | covered |
| 21 | OWN-CTL-07 | Release/Assign no-op semantics | `200 {changed: false}` for both no-ops; `404 unknown-owner`; `409 owner-detached` — §3.4 | covered |
| 22 | OWN-WAKE-08 | Unlabeled socket and ownership frames | Phase 3 keeps Phase 1 semantics for an unlabeled socket: all events + all frames — §3.4b | covered |
| 23 | OWN-LCH-06 | Bootstrap names no document | `supervisorInitialPrompt` names `tandem_listDocuments` / `isActive` / pass `documentId` — §3.8 | covered |
| 24 | OWN-UPG-06 | Phase 2 chat label field | `ChatMessage.ownerLabel?` stamped by `appendClaudeChatMessage` in Phase 1, rendered in Phase 2; not token-derived — §3.6 (4), §7, §8 | covered |
| — | OWN-GRP-04 (note) | `cwd` argument placed in no phase | Record property internal in Phase 1; optional `cwd` argument is a Phase 4 schema change — §3.1 D6, §7 | covered — §5.7-A decided 2026-09-17, note closed |

## 4. Decision register (all decided 2026-09-17)

| §5 decision | Decided | Stories | Behaviour as decided |
|---|---|---|---|
| 5.1 Multi-child now vs deferred (D2) | B — defer; first-delivered wins in Phases 1–3 | OWN-OPEN-03, OWN-CON-05, OWN-LCH-10 | User-opened docs are unowned until a session is delivered their work or responds; the always-woken child usually wins the race. Phase 4 adds directory routing behind a dated `needs-human-evidence` issue. |
| 5.2 Downgrade vs refuse (D7) | B — refuse `NOT_OWNER` | OWN-ANN-07 | Non-owner `tandem_edit` is refused naming the owner; no synthetic annotation, no wake. |
| 5.3 User-created scratchpad routing | A — unowned until delivered/responded | OWN-OPEN-06 | Ctrl+N scratchpad is "unassigned"; first delivered poll claims. |
| 5.4 D1 strict vs inbox-only | A — strict | OWN-CON-01, OWN-ANN-06 | Every non-owner write including `tandem_comment` is `NOT_OWNER`. |
| 5.5 Shim / monitor under Cowork | A — unscoped in Phases 1–3 | OWN-WAKE-07, OWN-X-01, OWN-X-02, OWN-CHAT-09 | Shim and monitor receive every doc's events; writes are server-checked; cost is tokens; `channel-reply` marks handled via `replyTo` only. |
| 5.6 MCP-side transfer | A — none | OWN-CON-01, OWN-SEC-01 | No `takeover`; a live owner cannot be displaced over MCP; dead owners release via transport death. |
| 5.7 Group cwd (D6) | A — record property | OWN-GRP-04 | Supervisor sets `cwd` for the child (Phase 1, internal); optional `cwd` argument in Phase 4; never derived from a document; never published. |
| 5.8 Detach grace | 2 min | OWN-LIVE-01 | Clean exit releases after 2 min; the 30-min reaper remains the large term in the crash bound. |
| 5.9 Assignment wake in Solo | A — not held | OWN-ANN-09 | The payload-free ownership frame is sent in Solo; the poll it provokes still withholds held records. |
| 5.10 Absorb a pre-bind record on handle bind (new; narrows Codex 7) | A — absorb | OWN-LCH-09, OWN-LCH-11, OWN-GRP-05 | A never-bound, single-transport `mcp:` record that owns documents is absorbed into the handle's record on bind; docs move, ledger entries re-key, nothing resurfaces; child exit then releases them. Any other owning record still conflicts. |
| 5.11 Live wake socket pins the transport against the idle reaper (new; touches #1588) | A — pin | OWN-WAKE-09, OWN-WAKE-12, OWN-LIVE-03 | An armed direct-HTTP session idle 30 min is not reaped while its socket is live; LRU stays pin-blind; the heartbeat bounds a stale pin. |
| 5.12 What the Assign list shows, and renaming sessions (bounds F6) | A + rename — nickname · kind · client | OWN-CTL-06, OWN-CTL-09, OWN-SEC-08, OWN-CTL-11 | Nickname (else label), kind and `clientInfo.name` on doc entries and in the loopback-only owners list, with the label always beside a nickname in the popover; Bryan renames from the popover and a session may name itself; `cwd` never published. |

---

## Conventions

- **Status:** `covered` = v4 fully answers it (a former v3 GAP says "closed in v4 by …"); `covered (known limitation)` = v4 states and bounds the behaviour without removing it; `decision-dependent` = turns on an open §5 decision — none since 2026-09-17, when every decision was made; `GAP` = v4 is silent, ambiguous or contradictory — no story carries it in this revision.
- **Phase:** 1–4 per v4 §7. Where behaviour differs by phase, each is given.
- **Test level:** unit / server integration (two `McpTestClient`s from `tests/e2e/helpers.ts`, or the in-memory MCP harness) / E2E (Playwright) / manual (`needs-human-evidence` where correctness depends on a world fact: a real Claude Code build, an OS, Bryan's hardware).
- Actor shorthand: **Bryan** (Tauri desktop or browser via npm global), **HS-http** (hand-started Claude Code, direct-HTTP entry), **HS-bridge** (hand-started Claude Code via `tandem mcp-stdio`), **Child** (auto-launched launcher child under the supervisor), **Desktop** (Claude Desktop via the stdio bridge), **Cowork** (remote session, non-loopback bind), **Sub** (subagent of an orchestrator), **Shim** (channel-shim session), **Monitor** (plugin-monitor session), **NonClaude** (non-Claude MCP agent per AGENTS.md), **Hostile** (hostile or prompt-injected local MCP client), **Upgrader** (old bridge / v24 SKILL / stale tab).
- Error codes are v4's: `NOT_OWNER`, `DOCUMENT_REQUIRED`, `INVALID_OWNER_HANDLE`, `OWNER_HANDLE_CONFLICT`; plus today's `NO_DOCUMENT`, `READ_ONLY`, `FORMAT_ERROR`, `INVALID_RANGE`, `RANGE_MOVED`, `SAVE_IN_PROGRESS`, `LICENSE_REQUIRED`, `EXTERNAL_CONFLICT`, `INVALID_ARGUMENT`, `INVALID_PATH`. Route errors are `409 busy`, `409 owner-detached`, `404 unknown-owner`. "Watch id" is the private `?watch=` value; "label" is the public `owner-xxxx` id; they are never the same string.

---

## A. Today's-behaviour regression stories (must keep working exactly as now)

#### OWN-REG-01 — One session, one document, no `documentId`
- **Actor:** HS-http
- **Story:** As a hand-started session with one document open, I want every tool to work without `documentId`, so that the single-document workflow in `SKILL.md` Workflow steps 1–8 is unchanged.
- **AC:**
  - Given exactly one document is open and unowned, When I call `tandem_getOutline()` then `tandem_edit({from,to,newText})` with no `documentId`, Then both succeed; the edit response carries `claimed: true`; `tandem_listDocuments` shows `ownedByYou: true` on that doc.
  - Given the same, When I call `tandem_checkInbox()` and `tandem_reply({text})` with no ids, Then neither returns `DOCUMENT_REQUIRED`.
- **Design refs:** §3.3 rule 2, §7 Phase 1 boundary ("singleton fallback + implicit claim = today").
- **Phase:** 1
- **Status:** covered
- **Test:** server integration; acceptance harness (`scripts/spikes/run_acceptance_tests.py`) single-doc scenario.

#### OWN-REG-02 — Notes stay private under ownership
- **Actor:** Bryan, HS-http
- **Story:** As Bryan, I want my `type: "note"` annotations to stay invisible to every Claude session regardless of who owns the document, so that ADR-027 is not weakened by the ownership check being placed before the privacy predicates.
- **AC:**
  - Given doc D owned by session A and a note N on D, When A calls `tandem_checkInbox`, `tandem_getAnnotations`, `tandem_resolveAnnotation({id: N})`, `tandem_editAnnotation({id: N})`, `tandem_removeAnnotation({id: N})`, `tandem_annotationReply({id: N})`, Then N never appears in reads and each write answers exactly what it answers today (`invalid-note` / `not-repliable` family), never a success.
  - Given the same note and a non-owner session B, When B calls any of the four writes, Then B gets `NOT_OWNER` (doc-level) and the message discloses nothing about N (not its type, not its existence).
  - Given a note is the only new item on an unowned doc, When any session polls, Then the poll returns nothing for that doc and **claims nothing** (a note is never "actionable").
- **Design refs:** §3.7 Ordering, §3.5 step 3 (`hideFromAI`, `isClaudeFacing` filtering before collection).
- **Phase:** 1
- **Status:** covered — v4 §3.5 step 3 states it ("a held record is never actionable and never claims; neither is a note, ADR-027").
- **Test:** server integration (extend `tests/server/annotation-*-seam.test.ts` family + new `checkinbox-claim-on-delivery.test.ts`).

#### OWN-REG-03 — Stale browser tab is auth-rejected after a server restart
- **Actor:** Upgrader (stale tab)
- **Story:** As Bryan with a browser tab that predates a server restart, I want that tab to be refused by `generationId` exactly as today, so that a stale tab cannot CRDT-merge stale `Y_MAP_OPEN_DOCUMENTS` entries (now carrying `ownerLabel`) into the fresh run.
- **AC:**
  - Given a tab connected before restart, When the server restarts and restores documents, Then the old tab's Hocuspocus auth is rejected, and after reload the tab shows every restored doc's badge as "unassigned" with a disconnected dot.
  - Then the generation id is still HTTP-only and never appears in any ctrl Y.Map, including the new label fields.
- **Design refs:** §3.4 Restart row, §3.8, §3.11; CLAUDE.md Y.js gotcha (generationId).
- **Phase:** 1
- **Status:** covered
- **Test:** E2E (existing stale-tab spec extended to assert badge state).

#### OWN-REG-04 — Browser edits are never ownership-gated
- **Actor:** Bryan
- **Story:** As Bryan, I want to type in a document another session owns, so that ownership coordinates Claude sessions and never blocks me.
- **AC:**
  - Given D owned by A, When Bryan types in D (Hocuspocus, `:3478`), accepts/dismisses a suggestion, edits or removes his own comment, Then every action succeeds; `connection-gate.ts` still gates on license only.
  - Given a Release lands while Bryan is mid-keystroke, Then no edit is lost and no conflict banner appears.
- **Design refs:** §3.4a last bullet, §1 D4, §6.
- **Phase:** 1
- **Status:** covered
- **Test:** E2E.

#### OWN-REG-05 — `/api` mutating routes remain the user's surface
- **Actor:** Bryan
- **Story:** As Bryan using the editor, I want Save, Close, Rename, Apply Changes, Restore, Reply and Remove to work on any tab regardless of owner, so that ownership never gates my own UI.
- **AC:** Given D owned by A, When the editor POSTs `/api/save`, `/api/close`, `/api/rename`, `/api/apply-changes`, `/api/backups/restore`, `/api/annotation-reply`, `/api/remove-annotation` for D, Then each behaves as today (no ownership check; the license gate rows in `license-gate-api-coverage.test.ts` are unchanged).
- **Design refs:** §3.7 last row, §6, §4 License tables row.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + `tests/server/license-gate-api-coverage.test.ts` (assert exactly two new rows, `API_OWNERSHIP` and `API_OWNERSHIP_OWNERS`, both `ungated`).

#### OWN-REG-06 — Rename and Save-As keep the ownership key
- **Actor:** HS-http, Bryan
- **Story:** As the owner of D, I want D to stay mine after I `tandem_rename` it or after Bryan Save-As-promotes an upload, so that a filename change does not silently release the document.
- **AC:**
  - Given D owned by A, When A calls `tandem_rename({documentId: D, newName})`, Then D's id is unchanged (`open.ts:359-371`: the doc stays registered under its original path-hash id), `ownerByDoc` still maps D→A, and the badge is unchanged.
  - Given an upload owned by A, When Bryan uses Save As, Then the promoted doc keeps the upload-derived id and A still owns it.
- **Design refs:** §3.4a composition table (rename); grounded in `documents/open.ts` realpath fallback.
- **Phase:** 1
- **Status:** covered (by construction — v4, like v3, does not state it; ids are path-hash and rename-stable per `open.ts:359-371`, and the §3.4a composition table's rename row runs inside the op under the same id; a one-line note in §3.4a would make it explicit).
- **Test:** server integration.

#### OWN-REG-07 — Solo hold on the pull path is unchanged
- **Actor:** Bryan, HS-http
- **Story:** As Bryan in Solo, I want my comments withheld from every session and released on the flip, so that ownership adds nothing the hold does not already cover.
- **AC:**
  - Given mode = solo and a user comment on D (owned or unowned), When any session polls, Then the comment is absent and `mode: "solo"` is reported; nothing is claimed by it.
  - Given Bryan flips to Tandem (`POST /api/mode/release`, `mode-toggle` testid), Then `emitModeReleaseWake` fires once, every attached socket and the supervisor receive one wake, and the first poll that returns the released comment claims D if it was unowned.
- **Design refs:** §3.5 Solo, §3.9.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + E2E (`mode-solo-btn`, `mode-toggle`).

#### OWN-REG-08 — Chat is never Solo-held and still routes through the inbox
- **Actor:** Bryan
- **Story:** As Bryan in Solo, I want my chat message answered, so that Solo holds annotations and not conversation.
- **AC:** Given mode = solo and a chat message on unowned D, When a session polls, Then the message is delivered, D is claimed by that poll, and `mode: "solo"` is still reported so the session holds annotations.
- **Design refs:** §3.5 Solo ("chat is not held and does"), `shouldForwardExternally`.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

---

## B. Opening

#### OWN-OPEN-01 — Claude opens a closed file
- **Actor:** HS-http
- **Story:** As a session, I want `tandem_open` of a file not yet open to open, claim and activate it, so that the existing open UX is unchanged and I am its owner.
- **AC:** Given `f.md` is not open, When I call `tandem_open({filePath})`, Then the response carries `documentId`, `ownerLabel` (mine), `claimed: true`, `wakeUrl` (HTTP mode, loopback bind); the tab is activated in the editor; `tab-owner-badge` on that tab shows my label with a connected dot.
- **Design refs:** §3.4 row 1, §3.11.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + E2E.

#### OWN-OPEN-02 — Claude re-opens an already-open, unowned document: claim without activating
- **Actor:** HS-http, Bryan
- **Story:** As Bryan reading tab X, I do not want a session's `tandem_open` of background tab Y to steal my focus, so that a claim is invisible until I look at the badge.
- **AC:** Given Y open, unowned, and X active, When a session calls `tandem_open({filePath: Y})`, Then the response has `claimed: true`, `ownerLabel`, the active tab remains X (`Y_MAP_ACTIVE_DOCUMENT_ID` and epoch unchanged), and Y's badge updates.
- **Design refs:** §3.4 row 2, §4 "Re-open flips the user's tab" row.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`open-no-activate.test.ts`) + E2E.

#### OWN-OPEN-03 — Bryan opens a file from the editor: unowned until someone responds
- **Actor:** Bryan
- **Story:** As Bryan opening a file via the `+` menu, drag-drop or Recent Files, I want it to show "unassigned" until a session engages it, so that I can see nobody is on it yet.
- **AC:** Given `POST /api/open`, Then the new tab's badge reads "unassigned"; `tandem_listDocuments` reports `ownerLabel: null`; no session is woken by the open (`document:opened` is not wake-worthy).
- **Design refs:** §3.1 D2, §3.4.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.1-B: unowned in Phases 1–3; directory routing is Phase 4).
- **Test:** E2E.

#### OWN-OPEN-04 — OS file association / cold start
- **Actor:** Bryan
- **Story:** As Bryan double-clicking a `.md` with Tandem closed, I want the document opened unowned and the launcher child (if enabled) to pick it up when I comment, so that the cold-start path behaves like any user open.
- **AC:**
  - Given Tandem is not running, When the OS opens `report.md`, Then the sidecar starts, `validate_open_candidate` passes, `POST /api/open` opens it unowned, the badge reads "unassigned".
  - Given the launcher spawns, Then the bootstrap turn carries the child's handle; the child's `tandem_checkInbox({ownerHandle})` returns nothing actionable and claims nothing; the child's next `tandem_getOutline()` resolves via the singleton fallback (one doc open).
  - Given Bryan then comments, Then the supervisor wakes the child, the poll delivers the comment and claims `report.md` on delivery.
- **Design refs:** §3.8 "Phase 1 does not pre-claim", §3.3 rule 2, §3.5 step 4.
- **Phase:** 1
- **Status:** covered — see OWN-LCH-06 for the multi-doc-restore variant.
- **Test:** manual (`needs-human-evidence`: OS association + real launcher).

#### OWN-OPEN-05 — Claude creates a scratchpad
- **Actor:** HS-http
- **Story:** As a session, I want `tandem_scratchpad` to create a document I own, so that my drafting tab is mine.
- **AC:** Given I call `tandem_scratchpad({content?})` (optionally with `ownerHandle`), Then the new doc is owned by my record, the response carries `ownerLabel`, `claimed: true`, `wakeUrl`; the tab is activated (a fresh open); the badge shows my label; `content` containing a live handle or watch id is refused `INVALID_ARGUMENT`.
- **Design refs:** §3.2 (entry tool), §3.10 (`WAKE_URL_PRODUCERS`), §3.4 `tandem_scratchpad` row, §6 scrub set.
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.4 row (creates, claims, activates as a fresh open).
- **Test:** server integration.

#### OWN-OPEN-06 — Bryan creates a scratchpad (Ctrl+N / palette)
- **Actor:** Bryan
- **Story:** As Bryan pressing Ctrl+N, I want to know who will answer chat on my new scratchpad, so that the enabled Send button is honest.
- **AC:** Given `palette-item-new-scratchpad` or `POST /api/scratchpad`, Then the tab has a `documentId`, `chat-send-btn` is enabled (Phase 2), the badge reads "unassigned"; When Bryan sends chat, Then the first session delivered it claims the scratchpad.
- **Design refs:** §3.1 D5, §5.3.
- **Phase:** 1 (routing), 2 (send gating)
- **Status:** covered — decided 2026-09-17 (§5.3-A: unowned until delivered/responded).
- **Test:** E2E + server integration.

#### OWN-OPEN-07 — Read-only documents: uploads and CHANGELOG
- **Actor:** HS-http, Bryan
- **Story:** As a session, I want a read-only document (an `upload://`, an `.html`, the on-upgrade `CHANGELOG.md`) to be annotatable by its owner and refused for content writes exactly as today, so that read-only and ownership compose.
- **AC:**
  - Given an unowned read-only doc R, When I call `tandem_comment` on R, Then R is claimed and the comment is created (annotations are the surface for read-only docs).
  - When I call `tandem_edit` on R, Then I get `READ_ONLY` **and R stays unowned** — `READ_ONLY` is a static-state refusal that runs before the queue (`docState.readOnly` is fixed at open).
  - When I call `tandem_save` on R, Then `saved: false` (session-only, a success) **and R is claimed** — the save ran inside the op.
  - Given R owned by A, When B calls `tandem_comment` on R, Then `NOT_OWNER`.
- **Design refs:** §3.7, §3.4a placement table; `document.ts:727`, `:1127`, `:1266`, `:1354-1385`.
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.4a placement table (with OWN-Q-08).
- **Test:** server integration.

#### OWN-OPEN-08 — Bryan closes a tab that a session owns
- **Actor:** Bryan, HS-http
- **Story:** As the owner of D, I want to learn that Bryan closed D, so that I stop working on a document that no longer exists.
- **AC:** Given D owned by A, When Bryan closes the tab (`POST /api/close`), Then `onDocumentClosed(D)` runs just before the registry drop (`document-service.ts:1805`): D leaves A's owned set; A's socket gets `ownership:released` (Phase 1: every socket); A's next `tandem_checkInbox` shows D under `ownership.released` with `reason: "closed"`; every op queued on D fails `NO_DOCUMENT`; a running op finishes as today; nothing resurfaces; `document:closed` stays non-wake-worthy.
- **Design refs:** §3.4 user-close row, §3.4b, §3.5 output shape.
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.4 "You close the tab" row.
- **Test:** server integration.

#### OWN-OPEN-09 — Re-open of a document I already own
- **Actor:** HS-http
- **Story:** As the owner of D, I want `tandem_open(D)` again (e.g. after compaction, to re-orient) to be a harmless no-op, so that re-orienting does not surprise Bryan.
- **AC:** Given D owned by me, When I call `tandem_open({filePath: D})`, Then `claimed: false`, `ownerLabel` mine, no ownership entry is written, and the tab is **not** activated — only a fresh open and `tandem_switchDocument` activate.
- **Design refs:** §3.4 "already owns" row, §4 "Re-open flips the user's tab".
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.4 row (no-op, not activated).
- **Test:** server integration.

#### OWN-OPEN-10 — `tandem_switchDocument` on an unowned document
- **Actor:** HS-http
- **Story:** As a session that only wants to bring a tab to the front for Bryan, I want to know whether doing so makes me its owner, so that a UI nudge does not silently commit me to a document.
- **AC:** Given D open, unowned, and E owned by me, When I call `tandem_switchDocument({documentId: D})`, Then `NOT_OWNER {ownerLabel: null}` with "this document has no owner — open or write it first"; D stays unowned; the tab does not move. Given E, When I switch to E, Then E's tab is activated, no queue turn is taken, no `claimed` field. Given F owned by B, Then `NOT_OWNER {ownerLabel: B, ownerConnected}` at handler entry.
- **Design refs:** §3.1 D1 (switchDocument excluded from the queued set), §3.3 (4), §3.7 `switchDocument` row.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.3 (4): owner-only, outside the queue, never claims.
- **Test:** server integration.

#### OWN-OPEN-11 — `force: true` on a foreign-owned document
- **Actor:** HS-http
- **Story:** As a non-owner, I must not be able to force-reload a document another live session is working on, so that its in-memory annotations are not cleared under it (#1813).
- **AC:**
  - Given D owned by live A, When B calls `tandem_open({filePath: D, force: true})`, Then `NOT_OWNER {ownerLabel, ownerConnected: true}`; D's annotations, awareness and content are untouched.
  - Given the license gate reads restricted, When anyone calls force-open, Then `LICENSE_REQUIRED` is returned **before** the queue and nothing is claimed; `license-force-open-gate.test.ts` passes unchanged.
- **Design refs:** §3.4 force row, §3.4a "A failing request never claims".
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (existing `license-force-open-gate.test.ts` + new).

#### OWN-OPEN-12 — Same file opened by Claude and then by Bryan (or the reverse)
- **Actor:** Bryan, HS-http
- **Story:** As Bryan opening a file a session has already opened, I want the existing tab focused and ownership unchanged, so that two routes to one file never make two owners.
- **AC:** Given A opened `f.md` (owner A), When Bryan opens `f.md` via file association or `+`, Then no second tab appears, A still owns it, the badge shows A. Given the reverse order, When A calls `tandem_open`, Then A claims the existing tab without activating (OWN-OPEN-02).
- **Design refs:** §3.4; `openFromDisk` already-open path.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-OPEN-13 — After a user close, the owner's unanswered chat becomes detached (new in v4)
- **Actor:** Bryan, HS-http
- **Story:** As the owner of D who was delivered Bryan's question on D and then saw Bryan close D, I want to still be able to answer it, so that a tab close does not lose the question or hand it to someone else.
- **AC:** Given M on D delivered to A (`deliveredTo[M.id] = {ownerId: A, documentId: D}`), When Bryan closes D, Then M's ledger entry is unchanged (not resurfaced); A's `tandem_reply({replyTo: M.id})` succeeds with no ownership check (D is not open) and M is handled; When instead A's record dies with M unanswered, Then the per-record sweep sets M `read: false` and the next poller receives it as detached.
- **Design refs:** §3.4 user-close row ("nothing resurfaces… becomes detached chat"), §3.5 Resurfacing ("Not on user close"), §3.6 (1).
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`user-close-release.test.ts`).

---

## C. Default `documentId`, singleton fallback, `DOCUMENT_REQUIRED`

#### OWN-DEF-01 — Omitted `documentId` targets my single owned document
- **Actor:** HS-http
- **Story:** As a session owning exactly one of several open documents, I want tools without `documentId` to target mine, so that I need not repeat the id on every call.
- **AC:** Given docs D (mine), E, F open, When I call `tandem_getTextContent()` / `tandem_edit(...)` / `tandem_reply({text})` with no id, Then all target D. When I also claim E, Then the next id-less call answers `DOCUMENT_REQUIRED` with `ownedDocumentIds: [D, E]` and `openDocumentIds: [D, E, F]`.
- **Design refs:** §3.3 rules 1–2.
- **Phase:** 1
- **Status:** covered
- **Test:** unit (resolver) + server integration.

#### OWN-DEF-02 — Cold start with one restored document: reads and writes work id-less
- **Actor:** HS-http, HS-bridge
- **Story:** As a session starting against a server that restored one document, I want `tandem_status → tandem_listDocuments → tandem_getOutline()` (SKILL Session Handoff) to work, so that the documented handoff is not broken (push M6).
- **AC:** Given one restored, unowned doc, When I run the handoff sequence, Then `tandem_getOutline()` and `tandem_getAnnotations()` succeed via the singleton fallback and **claim nothing** (reads never claim); my first write claims.
- **Design refs:** §3.3 rule 2, §9 push M6 / model-ux 6.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration; acceptance harness.

#### OWN-DEF-03 — Cold start with several restored documents: `DOCUMENT_REQUIRED` on reads
- **Actor:** HS-http, Upgrader (v24 SKILL)
- **Story:** As a session against two restored docs, I want a bare `tandem_getOutline()` to tell me which ids exist, so that I can pick one rather than silently reading the "active" tab.
- **AC:** Given D and E restored, unowned, and I own nothing, When I call `tandem_getOutline()`, Then `DOCUMENT_REQUIRED {ownedDocumentIds: [], openDocumentIds: [D, E]}`; `tandem_status`, `tandem_listDocuments`, `tandem_diagnostics`, `tandem_checkInbox` still succeed with no id.
  - Given a v24 `SKILL.md` session ("omitting it targets the active document"), Then the same error; the message must be self-explanatory enough that a v24 session recovers by passing an id.
- **Design refs:** §3.3 rules 2–3, §4 ADR-011 and SKILL rows.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + acceptance harness (v24 baseline via `git show v0.21.0`).

#### OWN-DEF-04 — `activeDocId` survives as UI state only
- **Actor:** Bryan, HS-http
- **Story:** As Bryan clicking between tabs, I want my tab choice to stop redirecting Claude's id-less calls, so that a tool call cannot land on a document I merely glanced at.
- **AC:** Given A owns D and Bryan activates E, When A calls `tandem_edit` with no id, Then the edit lands on D. `tandem_listDocuments` still reports `isActive` for E; `activeDocumentId` still names E.
- **Design refs:** §3.3 (4), §4 "`activeDocId` as MCP default" row.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (the three direct `?? getActiveDocId()` sites and `getCurrentDoc` fallback are gone — pin with a source grep test).

#### OWN-DEF-05 — Explicit `documentId` for a read on a foreign-owned document
- **Actor:** HS-http
- **Story:** As a non-owner, I want to read any open document, so that cross-referencing (docs/workflows.md "Cross-Referencing an Invoice") still works when another session owns one of the files.
- **AC:** Given E owned by B, When A calls `tandem_getTextContent({documentId: E})`, `tandem_search`, `tandem_resolveRange`, `tandem_getContext`, `tandem_getOutline`, `tandem_getAnnotations`, `tandem_exportAnnotations`, Then each succeeds and E stays B's.
- **Design refs:** §3.3 rule 1 ("Reads stay open to everyone").
- **Phase:** 1
- **Status:** covered — v4 §3.7 lists `tandem_exportAnnotations` in the reads row (open to everyone, never claims).
- **Test:** server integration.

#### OWN-DEF-06 — `tandem_checkInbox` for a caller owning nothing is never `DOCUMENT_REQUIRED`
- **Actor:** Child, HS-http
- **Story:** As a session owning nothing, I want `tandem_checkInbox()` to cover every unowned document, so that I can be the first poller (annotation 6, push B1).
- **AC:** Given D, E unowned and F owned by B, When I poll with no id, Then scope = {D, E}; items on F are absent; a comment on D is delivered and D is claimed.
- **Design refs:** §3.5 step 2.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-DEF-07 — Stdio transport mode has no transport identity
- **Actor:** NonClaude, HS-bridge (a client configured against `tandem --stdio`)
- **Story:** As a client speaking to Tandem's stdio MCP transport (no `Mcp-Session-Id`, no registry entry), I want a defined owner identity, so that every write does not fail or claim under `mcp:undefined`.
- **AC:** Given `transportMode === "stdio"` (`index.ts:111`, `startMcpServerStdio` at `server.ts:522-533`), Then one record `stdio:<pid>` of kind `stdio` exists from start, attached until process exit; `getMcpContext()` is undefined in every handler and `getCurrentOwner()` resolves the stdio record; When the single client calls `tandem_edit` with one doc open, Then the singleton fallback claims it under that record; `tandem_status({issueHandle: true})` never returns a handle in stdio mode; `wakeUrl` is absent as today; `tandem_listDocuments` shows `ownerKind: "stdio"`.
- **Design refs:** §3.2 rule 4, §2 Transport (corrected), §4 Stdio-mode row.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.2 rule 4 (process-wide `stdio` record).
- **Test:** server integration (stdio harness).

---

## D. Groups: several documents in one session; the group's cwd

#### OWN-GRP-01 — One session owns several documents
- **Actor:** HS-http
- **Story:** As a session cross-referencing two files, I want to own both and be delivered both documents' work, so that a multi-doc review stays with one responder.
- **AC:** Given A `tandem_open`s D and E, Then `tandem_listDocuments` shows `ownedByYou: true` on both; a user comment on E is delivered only to A's poll; both badges show A's label; id-less calls answer `DOCUMENT_REQUIRED` listing both.
- **Design refs:** §1 D2/D6, §2 Owned set, §3.5 step 2.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-GRP-02 — Groups die with the server run
- **Actor:** HS-http
- **Story:** As a session, I accept that a server restart forgets my group, so that no stale ownership survives into a run whose records are empty.
- **AC:** Given A owns D and E, When the server restarts and restores both, Then both are unowned and badged "unassigned"; A's next call (after its transport re-initializes) re-claims by writing or by delivery.
- **Design refs:** §1, §3.4 Restart row, §3.8.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (restart harness) + manual for the live-client reconnect (see OWN-LIVE-08).

#### OWN-GRP-03 — Subagents inherit the orchestrator's record
- **Actor:** Sub
- **Story:** As a subagent spawned by the orchestrator's `Agent` tool, I want my `tandem_comment` to be accepted on the orchestrator's documents, so that docs/workflows.md's Multi-Model Workflow keeps working.
- **AC:** Given orchestrator O owns D, When subagent S (same process, same MCP client) calls `tandem_comment` on D, Then success under O's record — no `NOT_OWNER`, no second record, no new label. S still never calls `tandem_checkInbox` (Hard Rule 7) and never arms a watch.
- **Design refs:** §3.2 Subagents.
- **Phase:** 1
- **Status:** covered for in-process subagents; the claim that they present the same transport is a Claude Code world fact — verify once on a real build.
- **Test:** manual (`needs-human-evidence`), then server integration with two logical callers on one transport.

#### OWN-GRP-04 — The group's cwd
- **Actor:** Child, HS-http
- **Story:** As a launcher child, I want my record to carry the cwd I was spawned in, so that Phase 4 directory routing has something to route on.
- **AC:** Given the supervisor spawns with `plan.cwd`, Then the pinned `handle` record has `cwd = plan.cwd` (Phase 1, internal; never on a doc entry, never in `tandem_status`). Given Phase 4 and a hand-started session passes `cwd` on `tandem_status`/`tandem_open`, Then its record stores it; otherwise `cwd` is unknown. `cwd` is never derived from the first-opened doc, never changes on close or reassignment, and is never published (§5.12).
- **Design refs:** §3.1 D6, §5.7, §5.12, §7 Phase 4 ("optional `cwd` argument").
- **Phase:** 1 (record property), 4 (argument and use)
- **Status:** covered — decided 2026-09-17 (§5.7 — A). The v3 note is closed: v4 places the optional `cwd` argument in Phase 4 (§7, `mcp-output-schemas.test.ts` for the argument).
- **Test:** unit (supervisor) + `mcp-output-schemas.test.ts`.

#### OWN-GRP-05 — Handing a document to a separately launched process
- **Actor:** HS-http (orchestrator), a second process it launches
- **Story:** As an orchestrator that launches a helper process with its own MCP transport, I want to hand it my documents via `ownerHandle`, so that the helper works under my record rather than fighting me for ownership.
- **AC:**
  - Given O calls `tandem_status({issueHandle: true})` and receives `ownerHandle` (a plain `tandem_status()` carries none), When the helper H (fresh transport, owning nothing, no in-flight ops) calls `tandem_checkInbox({ownerHandle})`, Then H's transport moves to O's record; the body runs under it; O and H are one owner with one label; H's once-armed socket, if any, follows via `watchAlias` (OWN-WAKE-13).
  - When H presents the handle a second time, Then idempotent success.
  - When H has first `tandem_open`ed something under its own fresh `mcp:` record (single transport, never bound), Then under §5.10 A the bind **absorbs** H's claims into O's record (OWN-LCH-11); When H's record has two transports, was itself bound from a handle, or is not `mcp:` kind, Then `OWNER_HANDLE_CONFLICT`, no side effects, no merge.
  - When H presents a garbled string, Then `INVALID_OWNER_HANDLE`, no side effects, body does not run.
- **Design refs:** §3.2 Handles: issuance and lifetime; §3.2 Hand-off and rebinding table; §5.10.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.2 (issuance only on `issueHandle: true`, lifetime = record lifetime; see OWN-GRP-07 for the lifetime cases). The absorb row was decided 2026-09-17 (§5.10 — A).
- **Test:** server integration (`handle-rebind.test.ts`).

#### OWN-GRP-06 — Remote or worktree-isolated subagents
- **Actor:** Sub (`isolation: "remote"` / a separate `claude` process)
- **Story:** As an orchestrator dispatching a remote subagent, I want to know it does **not** share my transport, so that I hand it a handle instead of watching it get `NOT_OWNER` against me.
- **AC:** Given O owns D, When a remote subagent with its own MCP connection calls `tandem_comment` on D without a handle, Then `NOT_OWNER {ownerLabel: O's}`; With O's `ownerHandle` on its first entry tool, Then it works under O's record (OWN-GRP-05).
- **Design refs:** §3.2 Subagents (assumption, fallback, SKILL v25 "Document ownership" hand-off guidance).
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.2 Subagents: *assumption* — a separately spawned `claude` process has its own transport and record; SKILL v25 tells the orchestrator to `tandem_status({issueHandle: true})` and pass the handle in the agent's prompt; *fallback* if the agent shares the client — the handle lands on a transport already bound to that record (idempotent row), so the guidance is harmless either way. Whether worktree-isolated agents share the MCP client stays `needs-human-evidence`.
- **Test:** manual, then server integration with two transports.

#### OWN-GRP-07 — Handle issuance and lifetime (new in v4)
- **Actor:** HS-http (orchestrator O), a helper process H
- **Story:** As an orchestrator, I want a handle only when I ask for one, and I want to know exactly when it stops working, so that a hand-off across my own reconnect is predictable and my transcript carries no capability I did not request.
- **AC:**
  - Given O calls `tandem_status()`, Then no `ownerHandle` is in the response; Given `tandem_status({issueHandle: true})` twice, Then the same handle both times (one per record).
  - Given O's last transport drops and the grace is running, When H presents O's handle, Then H attaches to O's record with its documents intact and the record no longer detaches while H stays attached.
  - Given O's record was dropped at grace expiry, When H presents the handle, Then `INVALID_OWNER_HANDLE`; nothing is revived.
  - Given a helper transport bound to the launcher child's record, When the child exits (`teardownTurnDelivery`), Then the helper's transport is re-homed to a fresh `mcp:` record owning nothing; its next call works; the child's docs were released.
  - In stdio mode, `issueHandle: true` returns no handle.
- **Design refs:** §3.2 "Handles: issuance and lifetime", §6 bullet 1.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`handle-rebind.test.ts`, lifetime cases).

---

## E. Two or more concurrent sessions: contention, refusals, what each sees

#### OWN-CON-01 — The second session is refused, not double-responding
- **Actor:** HS-http ×2
- **Story:** As Bryan running two terminals, I want only one of them to edit and answer a document, so that I never get two replies or two competing edits.
- **AC:** Given A owns D, When B calls `tandem_edit`/`tandem_comment`/`tandem_appendContent`/`tandem_editList`/`tandem_save`/`tandem_rename`/`tandem_close`/`tandem_applyChanges`/`tandem_restoreBackup` (restore mode)/`tandem_convertToMarkdown`/`tandem_open force` on D, Then each answers `NOT_OWNER {ownerLabel: A, ownerConnected: true}` at the op's turn, and `tandem_switchDocument` answers it at handler entry; the message names the badge and Assign as the remedy and never `/api`; no `takeover` field exists in any schema.
- **Design refs:** §3.7 table, §3.4 rows 4, §5.6.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.4 strict D1 — A; under B `tandem_comment` would be allowed) and §5.6 (no MCP transfer — A).
- **Test:** server integration (two `McpTestClient`s).

#### OWN-CON-02 — What each session sees in `tandem_listDocuments`
- **Actor:** HS-http ×2
- **Story:** As session B, I want to see who owns what before I try, so that I can tell Bryan rather than hit `NOT_OWNER`.
- **AC:** Given A owns D, B owns E, F unowned, When B calls `tandem_listDocuments`, Then D: `{ownerLabel: "owner-…", ownerConnected: true, ownedByYou: false}`, E: `{…, ownedByYou: true}`, F: `{ownerLabel: null, ownerConnected: false, ownedByYou: false}`; no handle, no `lastSeenAt`, no session id appears.
- **Design refs:** §3.3 (3), §6 Presence.
- **Phase:** 1
- **Status:** covered
- **Test:** `mcp-output-schemas.test.ts` + server integration.

#### OWN-CON-03 — Two sessions race to claim an unowned document by writing
- **Actor:** HS-http ×2
- **Story:** As two sessions that both try `tandem_open(D)` at once, I want exactly one to win, so that the queue and not timing decides.
- **AC:** Given D unowned, When A and B call `tandem_open(D)` concurrently, Then exactly one response has `claimed: true`; the other has `NOT_OWNER` naming the winner; the loser was refused at its queue turn (not at handler entry).
- **Design refs:** §3.4a.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`doc-op-queue.test.ts`, deterministic interleave).

#### OWN-CON-04 — Reads on a foreign-owned document, then a write after Bryan reassigns
- **Actor:** HS-http ×2, Bryan
- **Story:** As session B told `NOT_OWNER`, I want to keep reading D and succeed once Bryan assigns D to me, so that the refusal is recoverable without restarting anything.
- **AC:** Given D owned by A, B reads D (allowed), Bryan clicks `tab-owner-assign-<B's label>`, Then B receives `ownership:assigned`; B's next poll lists D under `ownership.assigned`; B's next write succeeds; A's next write answers `NOT_OWNER {ownerLabel: B}` and A's poll lists D under `ownership.released`.
- **Design refs:** §3.4, §3.4b, §3.5 output shape.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + E2E.

#### OWN-CON-05 — Hand-started session vs the launcher child on a user-opened document
- **Actor:** Bryan, Child, HS-http
- **Story:** As Bryan who opened a doc in Tauri, commented, and also started Claude Code in a terminal to work on it, I want a predictable answer to "who got it", so that I know to Assign rather than wonder why the terminal says `NOT_OWNER`.
- **AC:** Given D unowned, Bryan comments, the supervisor wakes the child, the child polls and claims D on delivery; When the terminal session then calls `tandem_open(D)`, Then `NOT_OWNER {ownerLabel: child's}`; the badge shows the child's label; Bryan's Assign to the terminal's label moves D and resurfaces anything the child did not answer.
  - Reverse order: the terminal `tandem_open`s D first (claims); Bryan comments; the child is woken (Phase 1 wakes on everything), polls, D is out of scope, nothing claimed, wasted turn.
- **Design refs:** §3.1 D2 interim, §3.8, §7 Phase 1 boundary.
- **Phase:** 1–3 (Phase 4 routes by directory)
- **Status:** covered — decided 2026-09-17 (§5.1 — B: first-delivered wins). Note the interim cost: the always-woken child usually wins the race for any user-opened doc, so the session Bryan *intends* to use is the one refused.
- **Test:** manual (`needs-human-evidence`: real launcher) + server integration for the ordering.

#### OWN-CON-06 — Read-only orientation never claims; the first responder wins
- **Actor:** HS-http ×2
- **Story:** As a session that did the SKILL handoff reads on D and then paused, I accept that another session delivered D's first comment becomes its owner, so that ownership follows response rather than attention.
- **AC:** Given A ran `status/listDocuments/getOutline/getAnnotations` on unowned D, When Bryan comments and B polls first, Then B owns D; A's later `tandem_comment` on D answers `NOT_OWNER`.
- **Design refs:** §3.3 rule 1, §3.5 step 4.
- **Phase:** 1
- **Status:** covered — v4 §3.3 (2) and the §4 SKILL row put "reading does not reserve" in SKILL v25.
- **Test:** server integration.

#### OWN-CON-07 — Non-Claude MCP agent alongside a Claude session
- **Actor:** NonClaude, HS-http
- **Story:** As a non-Claude agent with no `SKILL.md`, I want the tool descriptions and error messages alone to explain `NOT_OWNER` and `DOCUMENT_REQUIRED`, so that I can recover without Claude-specific guidance.
- **AC:** Given the agent sends no `X-Claude-Session-Id`, Then it binds as `mcp:<Mcp-Session-Id>`; its `tools/list` descriptions for the mutating tools and for `tandem_checkInbox`/`tandem_reply` mention ownership and the two codes; each error's `message` states the remedy; `docs/mcp-tools.md` parameter tables document `ownerHandle` on the four entry tools and the new fields.
- **Design refs:** §3.2 rule 3, §4 Error vocabulary row, `SERVER_INSTRUCTIONS` sentence.
- **Phase:** 1
- **Status:** covered
- **Test:** `tests/server/mcp-server-instructions.test.ts` + docs test for `docs/mcp-tools.md` tables.

---

## F. Chat: send gating, routing, `replyTo`, doc-less legacy, interleaving

#### OWN-CHAT-01 — Send is disabled on an empty tab, with a reason
- **Actor:** Bryan
- **Story:** As Bryan with no tab open, I want the Send button disabled and to be told why, so that I do not write a message nobody can be routed.
- **AC:** Given `yjsSync.activeTabId` is null, Then `chat-send-btn` is disabled with `title`/`aria-label` "Open a document to chat — messages go to the session working on that document"; When a tab opens, Then it enables; a scratchpad tab counts as a tab.
- **Design refs:** §3.1 D5, §3.6 Send.
- **Phase:** 2 (Phase 1: send stays enabled and a doc-less message is a legacy doc-less item)
- **Status:** covered
- **Test:** E2E.

#### OWN-CHAT-02 — A chat message is routed to the document it was sent on
- **Actor:** Bryan, HS-http ×2
- **Story:** As Bryan chatting while tab D is active, I want the session that owns D to answer, so that the reply comes from whoever is actually working on D.
- **AC:** Given D owned by A and E owned by B, When Bryan sends a message on D, Then A's poll returns it (with `documentId: D`) and B's does not; Then only A's wake socket / stdin receives the `chat:message` wake (Phase 3; Phase 1 wakes everyone).
- **Design refs:** §3.5 step 3, §3.10.
- **Phase:** 1 (routing), 3 (wake scoping)
- **Status:** covered
- **Test:** server integration + E2E.

#### OWN-CHAT-03 — `tandem_reply` with `replyTo` derives the document
- **Actor:** HS-http
- **Story:** As the owner of D answering message M, I want `replyTo: M.id` to route and mark M handled, so that M does not resurface to anyone later.
- **AC:**
  - Given M on D, When I call `tandem_reply({text, replyTo: M.id})`, Then the reply is stamped `documentId: D`, runs as a write on D (queue, `NOT_OWNER` if D is foreign-owned, claim if unowned), and M is handled.
  - When I pass `replyTo: M.id, documentId: E` (E ≠ D), Then `INVALID_ARGUMENT` "replyTo belongs to another document".
  - When `replyTo` names an unknown id, Then `INVALID_ARGUMENT`.
- **Design refs:** §3.6 Reply (1).
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`reply-routing.test.ts`).

#### OWN-CHAT-04 — `tandem_reply` without `replyTo`
- **Actor:** HS-http
- **Story:** As a session answering three questions in one message, I want an id-less reply to resolve deterministically and never become a silent global send, so that the resurface predicate stays correct.
- **AC:**
  - Given I own only D, When `tandem_reply({text})`, Then it lands on D and every message on D delivered to me before now is handled (`handledChat`).
  - Given I own D and E, Then `DOCUMENT_REQUIRED` — no message is sent.
  - Given I own nothing and two docs are open, Then `DOCUMENT_REQUIRED`.
  - Given `documentId: E` explicit and E owned by B, Then `NOT_OWNER`.
- **Design refs:** §3.6 (2)–(3).
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-CHAT-05 — Doc-less legacy messages
- **Actor:** Bryan (pre-Phase-2 client), HS-http
- **Story:** As a session, I want a chat message with no `documentId` (sent before Phase 2, or by an old client) to be answerable, so that legacy chat is not stranded.
- **AC:** Given a `read: false` message with no `documentId`, When any session polls (any scope), Then it is delivered, marked read and recorded in the ledger with `documentId: null` (first-poller arbitration, claims nothing); When the session replies with `replyTo` and no `documentId`, Then the reply is a doc-less send with no ownership check and the message is handled; with an explicit `documentId` the ownership rule applies.
- **Design refs:** §3.5 step 3 and handled table row 2, §3.6 (1) detached / doc-less branch.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-CHAT-06 — Two owners interleave in one thread
- **Actor:** Bryan
- **Story:** As Bryan with A on D and B on E, I want to tell which session wrote which bubble, so that a shared global thread stays readable.
- **AC:** Given replies from A (on D) and B (on E), Then the ChatPanel shows #1264's document label on each; Phase 2 adds the owner label beside it; ordering is by timestamp.
- **Design refs:** §3.6 last bullet, §7 Phase 2.
- **Phase:** 1 (document label), 2 (owner label)
- **Status:** covered — the field is `ChatMessage.ownerLabel`, stamped in Phase 1 (OWN-UPG-06).
- **Test:** E2E.

#### OWN-CHAT-07 — Chat on a document that is no longer open
- **Actor:** Bryan, HS-http
- **Story:** As Bryan who sent a message on D and then closed D (or D was a scratchpad now gone, or D failed to restore after a restart), I want my message still to reach a session, so that a tab close does not swallow a question.
- **AC:** Given a `read: false` user message with `documentId: D` and D **not** in the open-doc registry, When any session polls (any scope, even `documentId: E`), Then the message is delivered as a *detached* item (`documentOpen: false`), marked read, recorded in the ledger with `documentId: D`, and claims nothing; When D is later re-opened, Then the ledger entry is unchanged (the item is handled or not by the same rules).
- **Design refs:** §3.5 step 2 ("plus doc-less chat and detached chat in every pass"), step 3, handled table row 2, §2 Detached chat.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.5 "detached chat" (in every pass like doc-less chat).
- **Test:** server integration.

#### OWN-CHAT-08 — Doc-less chat drained by a session that dies
- **Actor:** Bryan, HS-http
- **Story:** As Bryan whose doc-less message was read by a session that then crashed, I want it to reach the next session, so that resurfacing covers legacy items too.
- **AC:** Given a doc-less (or detached) message delivered to A (`deliveredTo[M.id] = {ownerId: A, documentId: null}`), When A's record dies (detach expiry or launcher teardown), Then the per-record sweep sets M back to `read: false` (`withInternal`) and the next poller receives it; When instead Bryan Releases one of A's documents, Then M is **not** resurfaced (the per-document sweep touches only that document's entries).
- **Design refs:** §3.5 Resurfacing (per-record sweep on record death).
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.5 per-record sweep.
- **Test:** server integration.

#### OWN-CHAT-09 — Shim reply path does not mark handled
- **Actor:** Shim
- **Story:** As a channel-shim session answering chat through `POST /api/channel-reply`, I want my answer to count as "handled", so that the message is not resurfaced to the next owner as unanswered.
- **AC:** Given M on D delivered to shim session S (which owns D), When S answers via `channel-reply {text, documentId: D, replyTo: M.id}`, Then M is handled; on S's release M does not resurface.
- **Design refs:** §3.6 (`channel-reply` "carries no record identity, so it stamps no `ownerLabel` and marks a message handled only through `replyTo`"), §5.5.
- **Phase:** 1
- **Status:** covered (known limitation) — v4 §3.6 states it: handled via `replyTo` only; a shim reply without `replyTo` leaves M unhandled and it resurfaces on release. Decision-dependent on §5.5 (B would thread identity through the route).
- **Test:** server integration.

#### OWN-CHAT-10 — Handle text is refused in chat
- **Actor:** HS-http, Hostile
- **Story:** As the server, I refuse a `tandem_reply` whose text contains a live handle, so that a capability never lands in the persisted, synced CTRL_ROOM chat.
- **AC:** Given a live handle H or a live watch id W, When `tandem_reply({text: "…H…"})` or `{text: "…W…"}`, Then `INVALID_ARGUMENT` and nothing is appended; an expired/unknown handle-shaped or id-shaped string is **not** refused (no oracle); `log-sanitize.ts` redacts both in logs.
- **Design refs:** §3.6 (4), §6 scrub set.
- **Phase:** 1
- **Status:** covered — the full tool set is OWN-SEC-06.
- **Test:** unit + server integration.

#### OWN-CHAT-11 — Reply to a detached message runs no ownership check (new in v4)
- **Actor:** Bryan, HS-http
- **Story:** As a session that was delivered a detached message (its document is closed), I want `tandem_reply({replyTo})` to just work, so that I am not refused for a document nobody can own.
- **AC:** Given M with `documentId: D`, D not open, delivered to A, When A calls `tandem_reply({text, replyTo: M.id})`, Then the reply is appended stamped with `documentId: D` and A's `ownerLabel`, no queue turn is taken, no `NOT_OWNER` is possible, and M is handled; When A passes `documentId: E ≠ D` explicitly, Then `INVALID_ARGUMENT` ("replyTo belongs to another document"); When B (not the deliverer) replies with `replyTo: M.id`, Then it also succeeds — there is no owner to check — and M is handled.
- **Design refs:** §3.6 (1) detached branch, §3.5 handled table row 2.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`detached-chat.test.ts`, `reply-routing.test.ts`).

---

## G. Annotations, notes privacy, Solo/Tandem

#### OWN-ANN-01 — User comment on an owned document reaches only the owner
- **Actor:** Bryan, HS-http ×2
- **Story:** As Bryan commenting on D (owned by A), I want A and only A to get it, so that B never answers a question addressed to A's work.
- **AC:** Given D owned by A, When Bryan creates a comment, Then A's poll returns it in `userActions` and B's poll does not; the `surfacedIds` entry is written by A's poll only.
- **Design refs:** §3.5 steps 2–5.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + E2E.

#### OWN-ANN-02 — User reply on a Claude thread
- **Actor:** Bryan
- **Story:** As Bryan replying on a Claude comment thread on D, I want the reply to reach D's owner, so that thread follow-ups are routed like comments.
- **AC:** Given D owned by A, When Bryan replies (`reply-send-btn-{*}`), Then A's `userReplies` carries it; handled once A replies on the thread later via `tandem_annotationReply`.
- **Design refs:** §3.5 table rows 3.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + E2E.

#### OWN-ANN-03 — Accept / dismiss is handled on delivery
- **Actor:** Bryan
- **Story:** As Bryan accepting a suggestion, I want the owner told once and nothing to resurface, so that an acknowledgement never becomes a re-asked question.
- **AC:** Given D owned by A, When Bryan accepts (`accept-btn-{*}`) A's suggestion, Then A's next poll shows it in `userResponses`; on any later release of D it is **not** resurfaced.
- **Design refs:** §3.5 table row 4, Resurfacing.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-ANN-04 — Claude suggestions and comments by the owner
- **Actor:** HS-http
- **Story:** As the owner of D, I want `tandem_comment` with `suggestedText`, `tandem_editAnnotation`, `tandem_annotationReply`, `tandem_resolveAnnotation({action:"dismiss"})` and `tandem_removeAnnotation` to behave as today, so that ownership adds a doc-level gate and nothing else.
- **AC:** Given D owned by me, Then each call obeys today's rules: dismiss works on user comments (`lifecycle.ts:950-953`), `removeForClaude` needs no author check, edit/reply refuse non-Claude authors with `NOT_OWNED`; `ACCEPT_REFUSED` on my own suggestion; no per-record owner attribution is stored in any Y.Map.
- **Design refs:** §3.7 rows 3–4 and Ordering.
- **Phase:** 1
- **Status:** covered
- **Test:** existing lifecycle suites + server integration.

#### OWN-ANN-05 — A later owner can edit a previous owner's annotations
- **Actor:** HS-http ×2, Bryan
- **Story:** As session B assigned D after A left, I want to edit or withdraw A's pending suggestions, so that a document is not stuck with cards nobody can touch.
- **AC:** Given A created suggestion S on D and D is now B's, When B calls `tandem_editAnnotation({id: S})` or `tandem_resolveAnnotation({id: S, action: "dismiss"})`, Then success (author is `"claude"`, no per-session attribution).
- **Design refs:** §3.7 ("No per-record authorship is stored"), §9 annotation 2.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-ANN-06 — Non-owner cannot annotate
- **Actor:** HS-http ×2
- **Story:** As session B, I am refused `tandem_comment` on A's document, so that D1 is strict and the owner never misses a card it was not told about.
- **AC:** Given D owned by live A, When B calls `tandem_comment` (or the deprecated `flag`/`suggest` stubs), Then `NOT_OWNER`; the stubs still call `notifyDeprecatedTool` and the tool-count test is unchanged.
- **Design refs:** §3.7 row 2, §5.4.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.4 — A strict).
- **Test:** server integration.

#### OWN-ANN-07 — D7: non-owner `tandem_edit` is refused, not downgraded
- **Actor:** HS-http ×2
- **Story:** As session B told `NOT_OWNER` on a `tandem_edit`, I get a refusal naming the owner rather than a suggestion created in my name, so that no synthetic `annotation:created` enters the queue as a fake user ask.
- **AC:** Given D owned by A, When B calls `tandem_edit`, Then `NOT_OWNER`; no annotation is created; `/health` `delivery.state` does not move to `awaiting-poll`; no wake fires.
- **Design refs:** §3.7 last paragraph, §5.2.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.2-B refuse; A is unbuildable as described).
- **Test:** server integration.

#### OWN-ANN-08 — Solo hold and claim: held items never claim
- **Actor:** Bryan, HS-http
- **Story:** As Bryan in Solo commenting on an unowned doc, I want no session to claim it until I release, so that Solo holds ownership as well as content.
- **AC:** Given mode = solo, D unowned, a Solo-held comment on D, When A polls, Then nothing for D is returned and D stays unowned. When Bryan flips to Tandem, Then everyone is woken once; the first poll that returns the comment claims D.
- **Design refs:** §3.5 Solo, §3.9.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-ANN-09 — Release while in Solo, then flip
- **Actor:** Bryan
- **Story:** As Bryan in Solo who Releases D from the badge, I want the held items to go to whoever picks D up after the flip, so that Release and Solo compose.
- **AC:** Given D owned by A, mode solo, held comment C on D, When Bryan Releases D (still Solo), Then D is unowned, C stays held; the `ownership:available` frame is sent (payload-free, not held); no poll returns C. When Bryan flips to Tandem, Then the release wake fires and the first poller claims D with C.
- **Design refs:** §3.4b Solo, §3.5 Solo, §5.9.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.9 — A: the ownership frame is not held).
- **Test:** server integration.

#### OWN-ANN-10 — Imported Word comments (private notes) under ownership
- **Actor:** Bryan, HS-http
- **Story:** As Bryan opening a `.docx` with Word comments, I want the imports to stay invisible until I promote them and then reach D's owner, so that the `.docx` workflow is unchanged.
- **AC:** Given a `.docx` opened by A (owner), Then `tandem_getAnnotations({author:"import"})` returns `[]` with `notesExcluded: N`; When Bryan promotes them, Then A's poll delivers them and, if D were unowned, that poll would claim D; the imported replies stay `private: true` forever.
- **Design refs:** §3.5, §9 annotation 10.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (existing docx fixtures).

---

## H. Inbox: claim-on-delivery, handled vs read, resurfacing

#### OWN-INB-01 — A poll that returns work claims the document, before any write
- **Actor:** HS-http
- **Story:** As the first session to poll an unowned doc with a pending comment, I become its owner atomically, so that the session that marked the item delivered is the session that owns it.
- **AC:** Given D unowned with comment C, When A polls, Then in one synchronous pass: scope resolved → C collected (dry) → `tryClaimNow(D, A)` succeeds → ledger entry written → `read`/surfaced stamps written → `resolveDeliveryRound([D])`; the response lists D under `ownership.claimed` and C under `userActions`.
- **Design refs:** §3.5 pass steps 1–7.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`checkinbox-claim-on-delivery.test.ts`); unit test asserting no `await` between steps 2 and 6 (source-shape pin).

#### OWN-INB-02 — An empty poll claims nothing
- **Actor:** HS-http, Hostile
- **Story:** As a session polling routinely, I must not acquire documents I have nothing to do on, so that polling is not a land-grab.
- **AC:** Given D, E unowned with no pending items, When A polls, Then both stay unowned; `ownership.claimed` is empty.
- **Design refs:** §3.5 step 4.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-INB-03 — Poll vs in-flight write on the same unowned doc
- **Actor:** HS-http ×2
- **Story:** As session A polling while B's `tandem_open(D)` is mid-queue, I want D's items left unmarked for B, so that Codex 1's split (A reads, B owns) cannot happen.
- **AC:** Given D unowned, B's op enqueued and running, When A polls, Then `tryClaimNow(D, A)` fails (queue not idle), D's items are dropped from A's pass unmarked; B claims at its turn; B's next poll delivers them.
- **Design refs:** §3.5 step 4.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (deterministic interleave).

#### OWN-INB-04 — `tandem_checkInbox({documentId})` on a foreign-owned document
- **Actor:** HS-http ×2
- **Story:** As session B, I am refused a poll scoped to A's document before any ledger write, so that I cannot drain A's items.
- **AC:** Given D owned by A, When B calls `tandem_checkInbox({documentId: D})`, Then `NOT_OWNER` and no `read: true`, no ledger entry, no delivery-round close for D; `recordInboxPoll()` still stamped.
- **Design refs:** §3.5 step 2, §9 annotation 3.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-INB-05 — Delivered but unanswered items resurface on release
- **Actor:** Bryan, HS-http ×2
- **Story:** As Bryan whose comment A read but never answered before A's transport died, I want the next owner to see it, so that "read" never means "handled".
- **AC:** Given comment C and chat M on D delivered to A, A never replied, When A's record is released (detach expiry or Bryan's Release), Then C's ledger entry is deleted and M is set `read: false` (`withInternal`, no `chat:message` event, no visual change); the next owner's poll returns both.
- **Design refs:** §3.5 Resurfacing.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`delivered-ledger-resurface.test.ts`).

#### OWN-INB-06 — Handled items do not resurface
- **Actor:** Bryan, HS-http ×2
- **Story:** As Bryan, I do not want the new owner to re-answer a question A already answered, so that reassignment does not duplicate replies.
- **AC:** Given M answered by A with `replyTo`, and comment C answered by A on-thread (reply timestamp ≥ C's `editedAt`), and accept/dismiss R delivered, When D moves to B, Then none of M, C, R resurfaces; a comment resolved/removed by Bryan does not resurface either.
- **Design refs:** §3.5 handled table.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-INB-07 — An edited comment after a reply resurfaces
- **Actor:** Bryan
- **Story:** As Bryan who edited my comment after A replied, I want the edit treated as unanswered, so that a stale answer does not count.
- **AC:** Given A replied at t1 and Bryan edits C at t2 > t1, Then C is delivered to A again with `edited: true` (today's rule) and is unhandled for resurfacing purposes until a reply with timestamp ≥ t2 exists.
- **Design refs:** §3.5 handled table row 2.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-INB-08 — The message that triggered the claim is itself resurfaced
- **Actor:** Bryan, HS-http ×2
- **Story:** As Bryan whose chat message M caused A to claim D on delivery, I want M resurfaced if A dies without answering, so that the very item that started A's tenure is not the one that is lost.
- **AC:** Given M sent at t0 on unowned D, A polls at t1 > t0 and claims D, the pass writes `deliveredTo[M.id] = {ownerId: A, at: t1, documentId: D}`, A never answers, When D is released, Then the per-document sweep finds M's entry (owner A, doc D, not handled), sets `read: false`, and M reaches the next owner. Given a message M0 with `read: true` from an earlier server run (no ledger entry), Then M0 is never resurfaced.
- **Design refs:** §3.5 Resurfacing (per-item delivered-to ledger; "this includes the item that triggered X's claim, because it was delivered under X"; earlier-run protection by construction).
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.5 delivered-to ledger; `since` is display-only.
- **Test:** server integration — still the first test to write (`delivered-ledger-resurface.test.ts`, first case).

#### OWN-INB-09 — Per-document delivery rounds
- **Actor:** HS-http ×2, Bryan (reading `/health`)
- **Story:** As an operator reading `/health`, I want B's poll not to close a round only A can collect, so that `awaiting-poll` stays trustworthy with two sessions.
- **AC:** Given a comment on D (owned by A) recorded as a forward, When B polls (scope excludes D), Then D's round stays open; `/health` reports the oldest open round; A's poll closes it. Doc-less events use the `"*"` key and close on any full pass.
- **Design refs:** §3.5 Delivery rounds.
- **Phase:** 1
- **Status:** covered
- **Test:** unit (`delivery-rounds-per-doc.test.ts`).

#### OWN-INB-10 — Items delivered before a server restart
- **Actor:** Bryan
- **Story:** As Bryan whose message was read but unanswered when the server restarted, I want to know whether it comes back, so that I know to re-ask.
- **AC:** Given M `read: true` (persisted in CTRL_ROOM), unanswered, When the server restarts, Then all records are gone, D is unowned, the delivered-to ledger and `handledChat` are empty — M is never resurfaced (as today); the server does **not** re-flip every unanswered `read: true` message at boot.
- **Design refs:** §3.5 "Restart residual (known limitation)", §9 story-gaps row.
- **Phase:** 1
- **Status:** covered (known limitation) — v4 §3.5 states the residual and why the boot re-flip is wrong (it would re-deliver every message ever answered without `replyTo`).
- **Test:** server integration (documented expectation).

#### OWN-INB-11 — `ownership` field in the inbox
- **Actor:** HS-http
- **Story:** As a session, I want every ownership change affecting me since my last poll in the response, so that a missed wake costs latency, never correctness.
- **AC:** Given assigns/releases/claims since my last poll, Then `ownership: {released: [{documentId, reason}], assigned: […], claimed: […]}` lists them once; the next poll lists them no more; `checkInboxOutputShape` and `mcp-output-schemas.test.ts:403,451,482` are updated.
- **Design refs:** §3.5 Output shape, §3.4b.
- **Phase:** 1
- **Status:** covered
- **Test:** `mcp-output-schemas.test.ts` + server integration.

---

## I. Release / Assign from the badge popover and the Tauri native menu; `409 busy`; the owners route

#### OWN-CTL-01 — Owner badge on every tab
- **Actor:** Bryan
- **Story:** As Bryan, I want each tab to show who owns it and whether that owner is connected, so that I can see the state before acting.
- **AC:** Given tabs D (A, connected), E (B, detached inside grace), F (unowned), Then `tab-owner-badge` on D shows A's label, its kind word (`terminal` / `bridge` / `auto-launched` / `stdio`) + connected dot; E shows B's label + disconnected dot; F shows "unassigned". `ownerLabel`, `ownerConnected`, `ownerKind`, `ownerClient` arrive on `Y_MAP_OPEN_DOCUMENTS` entries via `toDocListEntry`; `npm run audit:ymap-keys` reports no new key.
- **Design refs:** §3.11, §2 Attached.
- **Phase:** 1
- **Status:** covered
- **Test:** E2E + `audit:ymap-keys`.

#### OWN-CTL-02 — Release from the badge popover (both runtimes)
- **Actor:** Bryan (Tauri and browser)
- **Story:** As Bryan, I want to release a document from a session that is stuck or gone, so that another session can pick it up.
- **AC:** Given D owned by A, When Bryan clicks `tab-owner-badge` → `tab-owner-menu` → `tab-owner-release`, Then `POST /api/ownership {documentId: D, action: "release"}` (loopback-only, `assertOriginAllowlisted`), D becomes unowned, the badge reads "unassigned", unhandled work resurfaces, A gets `ownership:released`, every other socket and the child get `ownership:available` (if work resurfaced).
- **Design refs:** §3.4 User control row, §3.4b, §3.11.
- **Phase:** 1
- **Status:** covered
- **Test:** E2E (both runtimes) + server integration for the route.

#### OWN-CTL-03 — Assign from the popover
- **Actor:** Bryan
- **Story:** As Bryan, I want to hand D to a specific session, so that the one I am talking to in the terminal gets it.
- **AC:** Given attached records A, B (B owns nothing), When Bryan clicks `tab-owner-assign-<B>`, Then `POST /api/ownership {documentId, action: "assign", ownerLabel: B}`; D moves to B; B is woken (`ownership:assigned` frame; `supervisor.requestWake()` if B is the child); the popover fetched `GET /api/ownership/owners` on open and listed every attached record as "label · kind · client" including B though it owned nothing; a detached-inside-grace record is not listed.
- **Design refs:** §3.4, §3.4b, §3.11.
- **Phase:** 1
- **Status:** covered
- **Test:** E2E + server integration.

#### OWN-CTL-04 — Tauri native context menu leaves
- **Actor:** Bryan (Tauri)
- **Story:** As Bryan right-clicking a tab in the desktop app, I want Release / Assign in the native menu as a convenience, so that the desktop path matches its other tab actions.
- **AC:** Given the native tab menu (`show_tab_context_menu`), Then `ctx:tab:release` and `ctx:tab:assign` leaves exist (added to `TAB_CONTEXT_MENU_ACTION_IDS` and `context_menu.rs`); Release dispatches `POST /api/ownership` directly; Assign opens the badge popover (one data path for the owners list); a `409 busy` is surfaced inline on the badge exactly as the popover surfaces it.
- **Design refs:** §3.11, §4 "Tab context menu is Tauri-only" row.
- **Phase:** 1
- **Status:** covered — v4 §3.11 decides it: the Assign leaf opens the popover.
- **Test:** manual (Tauri) + unit for `buildTabMenuContext`.

#### OWN-CTL-05 — `409 busy` during a long operation
- **Actor:** Bryan, HS-http
- **Story:** As Bryan clicking Release while a `.docx` `tandem_applyChanges` is running, I want a clear "try again" rather than a silently queued change, so that nothing happens behind my back.
- **AC:** Given A's op holds D's queue > `OWNERSHIP_WAIT_MS` (10 s), When Bryan clicks Release, Then the route waits up to 10 s, answers `409 busy`, the change is **not** queued, the badge shows "an operation is in progress — try again"; When the op ends and Bryan retries, Then it succeeds.
- **Design refs:** §3.4 User control row, §3.4a bullet 4.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (slow op stub) + E2E.

#### OWN-CTL-06 — Telling labels apart
- **Actor:** Bryan
- **Story:** As Bryan looking at `tab-owner-assign-owner-k7qx` and `…-owner-p2zt`, I want to know which is my terminal and which is the launcher child, so that Assign is usable.
- **AC:** Given two attached records, When Bryan opens the popover, Then each entry reads "owner-k7qx · terminal · claude-code" / "owner-p2zt · auto-launched" (label · kind · sanitized `clientInfo.name`, from `GET /api/ownership/owners`); no `cwd`, no `lastSeenAt`; When Bryan asks a session, Then `tandem_status()` returns `ownerLabel`, `ownerKind`, `ownedDocumentIds` so it can say "I am owner-k7qx, the terminal one".
- **Design refs:** §3.11, §3.3 (3), §3.2 Descriptor (`getClientVersion()`, `server/index.js:262`, `:280-281`), §5.12, §6 Presence and the descriptor.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.11 / §3.3 (3); §5.12 decided 2026-09-17: no cwd; two sessions are told apart by nickname (OWN-CTL-11).
- **Test:** E2E + `mcp-output-schemas.test.ts`.

#### OWN-CTL-07 — Release / Assign on an unowned document, or assign to the current owner
- **Actor:** Bryan
- **Story:** As Bryan, I want a Release on an already-unowned tab and an Assign to the current owner to be harmless, so that a double click never errors or resurfaces work twice.
- **AC:** Given D unowned, When `release`, Then `200 {changed: false}`, no `setDocOwner`, no frames, nothing resurfaced; Given D owned by A, When `assign A`, Then `200 {changed: false}`, idempotent, nothing resurfaced; When `assign` names an unknown label, Then `404 {error: "unknown-owner"}`.
- **Design refs:** §3.4 User control row ("No-op semantics").
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.4 no-op table (see OWN-CTL-10 for the detached-in-grace case).
- **Test:** server integration.

#### OWN-CTL-08 — Two editor windows both control ownership
- **Actor:** Bryan (Tauri + browser tab)
- **Story:** As Bryan with the desktop window and a browser tab open, I want both badges to agree and both to be able to Release, so that the control is not window-bound.
- **AC:** Given a Release from the browser tab, Then the desktop badge updates within one broadcast; a concurrent Assign from the other window is serialized by D's queue and the second answers per OWN-CTL-07.
- **Design refs:** §3.4 (`broadcastOpenDocs`), §3.4a.
- **Phase:** 1
- **Status:** covered
- **Test:** E2E (two pages).

#### OWN-CTL-09 — The owners route is loopback-only in-handler and lists attached records (new in v4)
- **Actor:** Bryan, Cowork (remote bearer holder)
- **Story:** As the user, I want the Assign list to come from one route that never crosses the LAN, so that the session enumeration is not exposed under a non-loopback bind even though GET is outside the path-wide loopback invariant.
- **AC:** Given attached records A (`terminal`, `claude-code`, owns 2), B (`auto-launched`, owns 0) and C detached inside the grace, When the popover calls `GET /api/ownership/owners` from loopback, Then `[{label: A, kind: "terminal", client: "claude-code", ownsCount: 2}, {label: B, kind: "auto-launched", ownsCount: 0}]` — C absent, no `cwd`, no timing fields; When a non-loopback peer calls it (bearer valid), Then 403 from the in-handler `isLoopback(req.socket.remoteAddress)` check; `NON_LOOPBACK_ALLOWED` is unchanged; `license-gate-api-coverage.test.ts` carries its `ungated` row ("read of coordination state; loopback-only in-handler") and the registrar sweep sees `routes/ownership.ts`.
- **Design refs:** §3.4 `GET /api/ownership/owners` row, §3.11, §6 "Presence and the descriptor", §5.12.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.12: nickname, kind and client, no cwd; the route also returns `nickname`).
- **Test:** server integration (loopback and non-loopback peers) + coverage test.

#### OWN-CTL-10 — Assign to a label whose record is detached inside the grace (new in v4)
- **Actor:** Bryan
- **Story:** As Bryan, I want Assign to refuse a session that just disconnected, so that I never hand a document to a record about to be dropped.
- **AC:** Given B's last transport dropped 30 s ago (grace running), When Bryan POSTs `{action: "assign", ownerLabel: B}` (e.g. from a stale popover), Then `409 {error: "owner-detached"}`, D unchanged, no frames; the popover shows "that session just disconnected — pick another or Release"; When B re-attaches inside the grace and Bryan retries, Then it succeeds.
- **Design refs:** §3.4 User control row (no-op table), §3.11.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + E2E.

---

#### OWN-CTL-11 — Renaming a session (new in v4.1)
- **Actor:** Bryan, HS-http
- **Story:** As Bryan with two terminal sessions in different repos, I want to give each one a name, so that I can tell them apart in Assign without the project directory being published.
- **AC:** Given attached records A and B, both `terminal · claude-code`, When Bryan clicks `tab-owner-rename-<A>` and enters "docs cleanup", Then `POST /api/ownership {action: "rename", ownerLabel: A, nickname: "docs cleanup"}` answers 200; the badge on A's tabs reads "docs cleanup · terminal"; the popover lists "docs cleanup (owner-k7qx) · terminal · claude-code"; Assign still posts the label. Given a session Bryan has not named, When it calls `tandem_status({nickname: "release notes"})`, Then its nickname becomes that with `nicknameSetBy: "session"`; When Bryan renames it and the session calls again, Then Bryan's name stays, is returned with `nicknameSetBy: "user"`, and is not an error. When a name is over 40 characters, matches `owner-xxxx`, or contains a live handle or watch id, Then the route answers `400 invalid-nickname` and the tool `INVALID_ARGUMENT`; control, bidi-override and zero-width characters are stripped first; an empty name clears it; the same name answers `200 {changed: false}`; an unknown label `404 unknown-owner`. When the server restarts or the record dies, Then the nickname is gone; when a late handle bind absorbs a pre-bind record (§5.10), the handle's record keeps its own nickname and takes the absorbed one only if it had none.
- **Design refs:** §2 Nickname, §3.3 (3), §3.4 user control row (rename), §3.11, §5.12, §6 Presence and the descriptor.
- **Phase:** 1
- **Status:** covered — added in v4.1 after Bryan decided on 2026-09-17 to allow renaming sessions.
- **Test:** server integration (sanitize, label-pattern refusal, user-set wins, absorb) + E2E (popover rename).

## J. The per-document op queue

#### OWN-Q-01 — Ownership is checked at the op's turn, after validation and license
- **Actor:** HS-http
- **Story:** As a session sending a malformed request, I must not acquire ownership as a side effect, so that a failing request never claims.
- **AC:** Given D unowned, When A calls `tandem_edit({documentId: D, from: "x"})` (bad args), or with the license restricted, or `documentId` of a closed doc, Then the error (`INVALID_ARGUMENT` / `LICENSE_REQUIRED` / `NO_DOCUMENT`) is returned and D stays unowned.
- **Design refs:** §3.4a steps 1–3, "A failing request never claims".
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-Q-02 — A failure inside the op keeps the claim
- **Actor:** HS-http
- **Story:** As a session whose edit hit `RANGE_MOVED` on an unowned doc, I want to remain the owner for my retry, so that a second session cannot race the retry.
- **AC:** Given D unowned, When A's `tandem_edit` passes validation, claims at its turn, then fails `INVALID_RANGE` / `RANGE_MOVED` / `SAVE_IN_PROGRESS` / disk error, Then the response carries `claimed: true` alongside the error and D is A's.
- **Design refs:** §3.4a "A failure inside the op keeps the claim".
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-Q-03 — Reassignment waits for the running op and pre-empts the queued ones
- **Actor:** HS-http, Bryan
- **Story:** As Bryan reassigning D while A has one op running and two queued, I want the running one to finish and the queued ones refused, so that no half-applied write straddles the change.
- **AC:** Given A's op1 running, op2/op3 queued, When `assign B` is enqueued, Then op1 completes normally; `setDocOwner` runs; op2 and op3 reach their turns and answer `NOT_OWNER` — including a queued `tandem_save` and a queued `tandem_close` (the tab stays open).
- **Design refs:** §3.4a bullet 3.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`doc-op-queue.test.ts`).

#### OWN-Q-04 — Save and the save lock
- **Actor:** HS-http
- **Story:** As the owner saving D while autosave is mid-write, I want `SAVE_IN_PROGRESS` as today and no deadlock, so that the queue and the `savingDocs` set compose.
- **AC:** Given autosave holds `savingDocs` for D, When A's `tandem_save` reaches its turn, Then `SAVE_IN_PROGRESS` (non-blocking check), the op settles, the queue advances; `recordSelfWrite` precedes `rearmWatch` inside the op unchanged (`document-write-rearm.test.ts` passes).
- **Design refs:** §3.4a composition table rows 1 and 4.
- **Phase:** 1
- **Status:** covered
- **Test:** existing `document-write-rearm.test.ts` + server integration.

#### OWN-Q-05 — `tandem_applyChanges` and the watcher reload outside the queue
- **Actor:** HS-http, Bryan
- **Story:** As the owner applying tracked changes to a `.docx`, I want the op to hold the queue only for the write and the reload to land later via the watcher as today, so that a Release inside the window either waits or answers BUSY.
- **AC:** Given A's `tandem_applyChanges` runs, Then the backup + rewrite are inside the op; the reload arrives through `fs.watch` (not fingerprinted, no `rearmWatch`, `docx-apply.ts` contains no `rearmWatch`); a Release clicked mid-op waits ≤ 10 s or answers `409 busy`; a new owner's first edit after the reload may see `RANGE_MOVED` (existing class).
- **Design refs:** §3.4a bullet 4, composition table (reload family outside).
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + `document-write-rearm.test.ts` site table.

#### OWN-Q-06 — `tandem_restoreBackup`, `tandem_rename`, `tandem_close` inside the queue
- **Actor:** HS-http
- **Story:** As the owner, I want restore, rename and close serialized with everything else on D, so that a reassignment cannot interleave them.
- **AC:** Given each is enqueued behind an Assign, Then each answers `NOT_OWNER` at its turn; given no Assign, each behaves as today (rename keeps the id; close releases D and drops it from my owned set).
- **Design refs:** §3.4a, §3.7 table.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-Q-07 — In-flight ops block a handle bind
- **Actor:** HS-http, Sub
- **Story:** As an orchestrator whose subagent has an edit in flight, I want `bindHandle` to refuse rather than race, so that the in-flight op is not re-attributed mid-run.
- **AC:** Given `inFlightByTransport[T] > 0`, When T presents a handle, Then `OWNER_HANDLE_CONFLICT`, no side effects; once the op settles (counter 0) and T owns nothing, the bind succeeds.
- **Design refs:** §3.2 table row 3 and the synchronous-bind paragraph.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

#### OWN-Q-08 — Where document-state refusals sit (`READ_ONLY`, `FORMAT_ERROR`, `EXTERNAL_CONFLICT`)
- **Actor:** HS-http
- **Story:** As a session that calls `tandem_edit` on the read-only `CHANGELOG.md` or an `upload://`, I want to know whether that refusal makes me its owner, so that a refused write does not silently commit me (or, if it does, that it is deliberate).
- **AC:** Given R read-only and unowned, When A calls `tandem_edit` on R, Then `READ_ONLY` and R stays **unowned** (static-state refusal, before the queue); Given `.docx` D unowned, When A calls `tandem_appendContent` on D, Then `FORMAT_ERROR` ("markdown documents only", by extension, `document.ts:1273`) and D stays unowned; Given D unowned with a pending external conflict, When A calls `tandem_save`, Then `EXTERNAL_CONFLICT` and D **is** claimed by A (live disk state read at save time, inside the op — the session that tried to save resolves it); `LICENSE_REQUIRED`, `NO_DOCUMENT`, `DOCUMENT_REQUIRED`, `INVALID_ARGUMENT`, `INVALID_PATH`, `INVALID_OWNER_HANDLE`, `OWNER_HANDLE_CONFLICT` never claim.
- **Design refs:** §3.4a placement table and its rule ("facts fixed since the document was opened, or the arguments alone → before the queue; the live Y.Doc, the disk or the lock set at write time → inside").
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.4a placement table (see OWN-Q-11 for the inside-the-op half).
- **Test:** server integration.

#### OWN-Q-09 — Reads that live in mutating tools, and tools in neither table
- **Actor:** HS-http
- **Story:** As a session listing backups (`tandem_restoreBackup` with no `backup`) or exporting annotations, I want those not to claim, so that a read-shaped call does not acquire a document.
- **AC:** Given D unowned, When A calls `tandem_restoreBackup({documentId: D})` (list mode) or `tandem_exportAnnotations({documentId: D})`, Then D stays unowned; `tandem_restoreBackup({backup})` (restore mode) claims.
- **Design refs:** §3.7 reads row (`tandem_restoreBackup` with no `backup` — `docx-apply.ts:569-573`; `tandem_exportAnnotations` — `annotations.ts:704-737`, sidecar only), §3.4a composition table (reload family row).
- **Phase:** 1
- **Status:** covered — closed in v4 by the §3.7 reads row (open to everyone, never claim, before the queue).
- **Test:** server integration.

#### OWN-Q-10 — No deadlock across the supervisor lock and the queue
- **Actor:** Child, Bryan
- **Story:** As Bryan relaunching Claude while the child has an op mid-queue, I want stop/relaunch never to wait on the doc queue, so that the launcher cannot wedge.
- **AC:** Given the child's `tandem_save` running on D, When Bryan relaunches, Then `teardownTurnDelivery` releases the record synchronously (map mutation), the running op finishes and its result is discarded by the dead child, the queue advances, the relaunch completes without awaiting the queue.
- **Design refs:** §3.4a composition table (supervisor lock), §3.8.
- **Phase:** 1
- **Status:** covered
- **Test:** unit (supervisor with a fake queue) + manual.

#### OWN-Q-11 — Live-state refusals inside the op keep the claim (new in v4)
- **Actor:** HS-http
- **Story:** As a session whose first edit on an unowned document fails on a stale range, I want to own the document anyway, so that the retry I am about to make cannot be raced by a second session.
- **AC:** Given D unowned, When A calls `tandem_edit` with a range that fails `INVALID_RANGE` (any reason, incl. heading overlap) or `RANGE_MOVED` against the live text, Then the error is returned with `claimed: true` and D is owned by A; same for `SAVE_IN_PROGRESS` / `RENAME_IN_PROGRESS` (a save was mid-flight), `EXTERNAL_CONFLICT` on `tandem_save`, a serializer `FORMAT_ERROR` mid-write (`document.ts:1174`), and a disk I/O failure; When B then writes on D, Then `NOT_OWNER`.
- **Design refs:** §3.4a placement table (right column), bullet "A failure inside the op keeps the claim".
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (`refusal-placement.test.ts`, inside-the-op half).

---

## K. Liveness: clean exit, crash, idle reap, bridge reconnect, compaction, `/clear`, `--resume`, restart

#### OWN-LIVE-01 — Clean client shutdown releases after the grace
- **Actor:** HS-http
- **Story:** As Bryan whose terminal session exited cleanly, I want its documents released two minutes later, so that the next session can pick them up without my intervention.
- **AC:** Given A owns D and sends `DELETE /mcp`, Then A's record detaches at once; badge dot goes disconnected; after `DETACH_GRACE_MS` D is unowned, unhandled work resurfaces, the badge reads "unassigned".
- **Design refs:** §3.2 Liveness bullets, §5.8.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.8 grace — 2 min).
- **Test:** server integration (injectable clock).

#### OWN-LIVE-02 — Crash with no `GET /mcp` stream: the ≈32-minute bound
- **Actor:** HS-http
- **Story:** As Bryan whose session was SIGKILLed, I want to know the document stays owned for up to ~32 minutes and that Release is the remedy, so that I do not wait.
- **AC:** Given A (no open GET stream) owns D and dies, Then D stays A's until the idle reaper (30 min, `transport-registry.ts:138`) evicts the entry (`onEvicted "idle"`) and the 2-min grace passes; the badge shows A connected throughout (attached ≠ responsive); Bryan's Release ends it immediately.
- **Design refs:** §3.2 Bounds callout.
- **Phase:** 1
- **Status:** covered (a bounded known limitation)
- **Test:** server integration with a clock; manual to confirm whether current Claude Code holds a GET stream (`needs-human-evidence` — `Reaping idle MCP session` in `tandem.log`).

#### OWN-LIVE-03 — Idle live client is reaped and loses ownership while alive
- **Actor:** HS-http (direct HTTP, no GET stream)
- **Story:** As a session idle for 30 minutes, I want my next call to work and to get my documents back if nobody else took them, so that the reap costs me a re-initialize and not my work.
- **AC:** Given A idle 30 min with no stream, Then A is reaped, detached, released after grace, badge "unassigned"; When A's next call re-initializes under a new `Mcp-Session-Id` (new `mcp:` record, new label), Then the singleton fallback / implicit claim returns D if still unowned; the response carries `claimed: true`; if B claimed D meanwhile, A gets `NOT_OWNER`.
- **Design refs:** §3.2 Bounds bullet 4.
- **Phase:** 1
- **Status:** covered for Phase 1. From Phase 3 an *armed* session is not in this case at all: its live socket pins the transport against `reapIdle` (§5.11, OWN-WAKE-12); an unarmed one still is, and the singleton fallback recovers as stated. Decision-dependent on §5.11 for the armed half.
- **Test:** server integration + manual (`needs-human-evidence`: does Claude Code's HTTP client re-initialize on 404?).

#### OWN-LIVE-04 — Bridge 404 reconnect inside the grace keeps the docs
- **Actor:** Desktop, HS-bridge
- **Story:** As Claude Desktop whose bridge got a 404 and replayed the handshake, I want my documents intact, so that a server-side eviction is invisible to me.
- **AC:** Given `bridge:<X-Tandem-Client-Id>` owns D, When the transport is evicted (LRU) and the bridge replays `initialize` within 2 min with the same header, Then the new transport re-attaches to the same record; D never became unowned; no resurfacing; badge dot flickers at most.
- **Design refs:** §3.2 rule 2 and Liveness bullet 2.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (two transports, same header) + `tests/cli` bridge test asserting the header is minted once per process.

#### OWN-LIVE-05 — Bridge reconnect after the grace
- **Actor:** Desktop
- **Story:** As Claude Desktop reconnecting after a long server hiccup, I accept that my documents were released and re-claim by working, so that no ghost owner survives.
- **AC:** Given release happened, When the bridge re-initializes with the same `X-Tandem-Client-Id`, Then a record for that `ownerId` exists again with no docs; the first write or delivered poll re-claims.
- **Design refs:** §3.2.
- **Phase:** 1
- **Status:** covered — the re-created record has the same `ownerId` and therefore the same derived watch id, so a once-armed socket keeps working (OWN-WAKE-09); the public label is minted fresh, which changes only the badge text.
- **Test:** server integration.

#### OWN-LIVE-06 — Compaction
- **Actor:** HS-http, HS-bridge, Child
- **Story:** As a session whose context was compacted mid-review, I want ownership to survive, so that nothing in my transcript is load-bearing.
- **AC:** Given A owns D, When A's context compacts, Then A's next `tandem_edit` succeeds — identity is the transport (http), the header (bridge) or the handle re-delivered on the next wake (child); no `NOT_OWNER`, no need for any handle in context.
- **Design refs:** §3.2 (model-ux 1), §3.8.
- **Phase:** 1
- **Status:** covered
- **Test:** manual (`needs-human-evidence`).

#### OWN-LIVE-07 — `/clear` and `claude --resume` the next day
- **Actor:** HS-http, HS-bridge
- **Story:** As Bryan running `/clear` or resuming yesterday's session, I want a predictable ownership outcome, so that I know whether to re-open.
- **AC:**
  - `/clear` in the same process: the MCP transport (and, for the bridge, the process) survives → same record → still owner. World fact to confirm.
  - `claude --resume` next day, direct HTTP: new process → new `mcp:` record; yesterday's record long released; re-claim by working.
  - `claude --resume` via bridge: `X-Claude-Session-Id` is the same id (forwarded on `--resume`) → same `ownerId`, fresh record with no docs → re-claim by working.
- **Design refs:** §3.2 rule 1 ("stable across… `claude --resume` next morning"), Liveness.
- **Phase:** 1
- **Status:** covered; `/clear` transport survival is `needs-human-evidence`.
- **Test:** manual.

#### OWN-LIVE-08 — Server restart with a live client and session restore
- **Actor:** HS-http, Bryan
- **Story:** As a session whose server restarted, I want to reconnect and find my documents restored but unowned, so that restart is "all unowned, as today".
- **AC:** Given restart, Then `restoreOpenDocuments` claims nothing; the record store is empty; every badge "unassigned"; A's next request gets `404 -32001`, re-initializes, and re-claims by writing; a stale tab is auth-rejected (OWN-REG-03).
- **Design refs:** §3.4 Restart row, §3.8, §9 push L10.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration + manual.

#### OWN-LIVE-09 — Sockets survive detach; the record is not the socket
- **Actor:** HS-http (with Monitor)
- **Story:** As a session whose MCP transport was reaped but whose Monitor socket is still open, I want to keep receiving unowned-doc and doc-less wakes, so that I can re-claim by polling.
- **AC:** Given A's transport reaped and record released, Then A's `?watch=<A's id>` socket stays open (resolving to no record), receives events on unowned docs and doc-less events, and receives nothing for docs owned by others; When A re-initializes under the same `ownerId`, Then the same watch id resolves to the new record with no re-arm.
- **Design refs:** §3.10 ("sockets are not closed on detach expiry").
- **Phase:** 3
- **Status:** covered
- **Test:** server integration.

---

## L. Launcher: fresh spawn, resume, crash-resume, relaunch, handles, start-at-login

#### OWN-LCH-01 — Fresh spawn: handle on the bootstrap turn
- **Actor:** Child
- **Story:** As the launcher child on a fresh spawn, I want the bootstrap turn to carry my handle, so that my first poll runs under the pinned record.
- **AC:** Given `spawnOnce` with `!plan.resuming`, Then a `handle` record is registered `{kind: "handle", cwd: plan.cwd}` pinned to `spawned`; `supervisorInitialPrompt(handle)` ends "Call `tandem_checkInbox({ ownerHandle: "…" })`" and still contains `SUPERVISOR_NO_ARM_CLAUSE`; the child's poll binds first, then runs the pass under that record; `launcher-session.json` never contains the handle.
- **Design refs:** §3.8 bullets 1–2, §4 Supervisor prompt row.
- **Phase:** 1
- **Status:** covered
- **Test:** unit (`tests/server/launcher/{supervisor,stream-json-protocol,supervisor-turn-delivery}.test.ts` moved to builders).

#### OWN-LCH-02 — Resume: no bootstrap turn, handle on every wake
- **Actor:** Child
- **Story:** As a resumed child (`plan.resuming`), I want the wake prompt to carry the current handle, so that a session with no bootstrap turn still binds (push B2 / model-ux 2).
- **AC:** Given a resumed spawn, Then no initial prompt is written; `supervisorWakePrompt(handle)` is written on the owed wake (`wakeOwedAcrossSpawns || loginRecheckOwed`) and on every event wake and deferred wake; each carries the **current** run's handle.
- **Design refs:** §3.8 bullet 3 (the four writes).
- **Phase:** 1
- **Status:** covered
- **Test:** unit.

#### OWN-LCH-03 — Crash-resume gets a new handle; the old one errors once
- **Actor:** Child
- **Story:** As a child restarted after a crash, I want a stale handle in my history to fail loudly and recover on the next turn, so that no ghost owner and no loop.
- **AC:** Given run 1's handle H1 released in `teardownTurnDelivery` on `exit`, run 2 minted H2, When the child presents H1, Then `INVALID_OWNER_HANDLE` with the "not live… use the handle from your most recent Tandem turn" message and no side effects; When it presents H2 (from the wake prompt that started this turn), Then success.
- **Design refs:** §3.8 bullets 2–3, §3.2 table row 1.
- **Phase:** 1
- **Status:** covered
- **Test:** unit + server integration.

#### OWN-LCH-04 — Child exit releases its documents immediately
- **Actor:** Child, Bryan
- **Story:** As Bryan whose auto-launched Claude crashed, I want its documents released at once (not after 32 minutes), so that the launcher is the exception to the crash bound.
- **AC:** Given the child owns D, When the process exits / errors / `stop()` / relaunch, Then `teardownTurnDelivery` releases the record synchronously; D is unowned; unhandled work resurfaces; the badge reads "unassigned"; an idle-reaped child **transport** does not release (the record is pinned to the process).
- **Design refs:** §3.2 Liveness bullet 3, §3.8.
- **Phase:** 1
- **Status:** covered
- **Test:** unit + manual.

#### OWN-LCH-05 — Relaunch in a new cwd
- **Actor:** Bryan, Child
- **Story:** As Bryan running "Relaunch Claude in this folder", I want the old child's documents released and the new child to start clean with the new cwd on its record, so that a ghost group from the old cwd cannot linger.
- **AC:** Given relaunch(newCwd), Then old record released (resurfacing), new `handle` record with `cwd = newCwd`; the new bootstrap turn carries the new handle; `cwd-preview` unchanged.
- **Design refs:** §3.8, §3.1 D6.
- **Phase:** 1
- **Status:** covered
- **Test:** unit + manual.

#### OWN-LCH-06 — Bootstrap turn on a multi-document restore
- **Actor:** Child
- **Story:** As a fresh child told "A document has been opened", I want to know which one when several are open, so that my first read does not hit `DOCUMENT_REQUIRED`.
- **AC:** Given D, E restored and F just opened by Bryan, When the child follows the bootstrap turn, Then the prompt text says "Tandem has documents open for review. `tandem_listDocuments` lists them; `isActive` marks the one in front of the user. Pass `documentId` explicitly whenever more than one is open."; `tandem_checkInbox({ownerHandle})` (global) works; a bare `tandem_getOutline()` answers `DOCUMENT_REQUIRED` with the three ids; `tandem_listDocuments` `isActive` identifies F.
- **Design refs:** §3.8 "The bootstrap turn names the document", `supervisorInitialPrompt(handle)` replacing `contract.ts:323-324`.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.8 (bootstrap builder names `tandem_listDocuments` / `isActive`).
- **Test:** acceptance harness.

#### OWN-LCH-07 — A child that drops its handle
- **Actor:** Child
- **Story:** As the server, I cannot tell a launcher child that calls with no handle from any other direct-HTTP client, so that this is surfaced rather than prevented.
- **AC:** Given the child answers `INVALID_OWNER_HANDLE` by calling `tandem_checkInbox()` with no handle, Then it runs as an ordinary `mcp:` record and may claim unowned docs under it; those docs are **not** released on child exit (only on transport death); the error text tells it to use the current handle instead.
- **Design refs:** §3.8 Known limitation, §9 C7.
- **Phase:** 1
- **Status:** covered (known limitation)
- **Test:** server integration.

#### OWN-LCH-08 — Start-at-login and the deferred launcher
- **Actor:** Bryan, Child
- **Story:** As Bryan with start-at-login, I want the deferred launcher, when promoted by `POST /api/launcher/start`, to spawn with a handle like any other spawn, so that the deferred path is not a second identity path.
- **AC:** Given `deferred-autostart`, When Bryan opens the window and the launcher starts, Then `spawnOnce` mints a handle exactly as OWN-LCH-01/02; a resumed spawn after login relies on `loginRecheckOwed` to send a wake carrying the handle.
- **Design refs:** §3.8, supervisor `loginRecheckOwed`.
- **Phase:** 1
- **Status:** covered
- **Test:** manual (`needs-human-evidence`: Windows start-at-login).

#### OWN-LCH-09 — SKILL Workflow step 1 vs the supervisor prompt: who binds first
- **Actor:** Child
- **Story:** As a launcher child that also loaded `SKILL.md` (Workflow step 1 says `tandem_status` first), I want my first tool call, whatever it is, to bind my handle, so that I never split into two identities.
- **AC:** Given the bootstrap turn opens with "Your Tandem owner handle for this run is `th_…`. Pass it as `ownerHandle` on your **first** Tandem call this turn, whichever tool that is" and SKILL v25 step 1 says "if the turn that started you named an `ownerHandle`, pass it here — and on whichever Tandem call you make first", When the child calls `tandem_status({ownerHandle})` first, Then it is bound there and every later call runs under the pinned record. When the child instead calls `tandem_status()` **without** the handle, then `tandem_open(D)` (claims D under a fresh `mcp:` record), then `tandem_checkInbox({ownerHandle})`, Then under §5.10 A the bind **absorbs** D into the handle's record (OWN-LCH-11) and child exit releases it; under §5.10 B it is `OWNER_HANDLE_CONFLICT` as in v3.
- **Design refs:** §3.8 "The handle rides the first call, whatever it is", §3.2 absorb row, §4 SKILL row (Workflow step 1), §5.10.
- **Phase:** 1
- **Status:** covered — closed in v4 by §3.8 (handle-first prompts + SKILL v25 step 1). The late-bind outcome was decided 2026-09-17 (§5.10 — A, absorb).
- **Test:** acceptance harness (real child transcript) + server integration.

#### OWN-LCH-10 — Multi-child supervisor (Phase 4)
- **Actor:** Bryan, Child ×N
- **Story:** As Bryan with documents in two repos, I want a headless session per directory, so that project-scoped Claude tools apply to each.
- **AC:** Given Phase 4 lands, Then N children, a multi-slot session file, directory routing of user-opened docs to the child whose `cwd` contains them; off by default until the dated `needs-human-evidence` issue closes.
- **Design refs:** §5.1, §7 Phase 4.
- **Phase:** 4
- **Status:** covered — decided 2026-09-17 (§5.1 — B: defer; D2 remains the design).
- **Test:** manual (`needs-human-evidence`: what N concurrent `--resume` sessions do).

#### OWN-LCH-11 — A child that bound late is absorbed, not refused (new in v4)
- **Actor:** Child
- **Story:** As a launcher child that opened a document before presenting my handle, I want my first bind to take that document with me, so that it is released when I exit like everything else I own.
- **AC:** Given the child's fresh `mcp:` record (single transport, never bound) owns D after `tandem_open(D)`, When it calls `tandem_checkInbox({ownerHandle})`, Then under §5.10 A: `setDocOwner(D, R, "bind")` runs at D's queue turn, D's badge changes to R's label, no `ownership:released` frame, no resurfacing, D's delivered entries are re-keyed to R, the transport moves to R, the inbox body runs under R; When the child exits, Then D is released by `teardownTurnDelivery`. Given the child's record has an op in flight, Then `OWNER_HANDLE_CONFLICT` and the child retries after it settles. Given Bryan had assigned E to the child's pre-bind label, Then E moves too. Under §5.10 B: `OWNER_HANDLE_CONFLICT`, D stays on the unpinned record (v3 behaviour).
- **Design refs:** §3.2 absorb row and its concurrency note, §3.8, §5.10, §9 C7 row (narrowed).
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.10 — A: absorb).
- **Test:** server integration (`handle-rebind.test.ts`, absorb cases incl. the in-flight refusal).

---

## M. Wake: one watch per session, scope, cap, reconnect, stand-down, fallbacks

#### OWN-WAKE-01 — One watch per session, armed once
- **Actor:** HS-http (with Monitor)
- **Story:** As a hand-started session, I want to arm one watch on the first `wakeUrl` I see and never re-arm, so that a newly assigned document is covered without any action from me.
- **AC:** Given `tandem_open` returns `wakeUrl: ws://127.0.0.1:<port>/api/wake?watch=<my watch id>` (never my label), When I arm `Monitor({ws:{url}, persistent:true})` once, Then a later Assign of E to me delivers E's events on that socket with no re-arm; `SKILL.md` "arm at most once per session" (`:99`, pinned at `skill-instruction-contract.test.ts:159/245`) is unchanged in meaning.
- **Design refs:** §3.10, §4 SKILL row.
- **Phase:** 3 (Phase 1: unlabeled URL, everything delivered)
- **Status:** covered
- **Test:** server integration (`no re-arm on assign` test) + acceptance harness.

#### OWN-WAKE-02 — Scope is resolved per event from the live map
- **Actor:** HS-http ×2
- **Story:** As session A with a labeled socket, I want exactly one wake per event I can act on and none for B's documents, so that turns are not wasted.
- **AC:** Given A owns D, B owns E, F unowned, Then A's socket receives: D events, F events, doc-less events (Solo release); not E events. The socket's record is resolved at dispatch (`records.get(watchAlias.get(watch) ?? ownerIdByWatch.get(watch))`). A socket with no `?watch=` receives everything.
- **Design refs:** §3.10 Self-armed row.
- **Phase:** 3
- **Status:** covered
- **Test:** server integration (`scope from live map`).

#### OWN-WAKE-03 — The assignment wake
- **Actor:** HS-http, Child
- **Story:** As the session Bryan just assigned D to, I want a payload-free nudge on my own socket (and on stdin if I am the child), so that I poll now rather than at my next routine cadence.
- **AC:** Given Assign D → R, Then `{id, type: "ownership:assigned", timestamp}` is written to R's newest live socket only; if R is the child, `supervisor.requestWake()` writes `supervisorWakePrompt(handle)` through the existing coalescing; the frame never enters `pushEvent`, never reaches `/api/events`, the shim, the monitor or `isWakeWorthy`; `/health` delivery state is untouched. Phase 1: the frame goes to every attached socket.
- **Design refs:** §3.4b.
- **Phase:** 1 (broadcast to all sockets), 3 (socket-local)
- **Status:** covered
- **Test:** server integration (assert `parseTandemEvent` never sees the type; SSE stream silent).

#### OWN-WAKE-04 — Doubled-wake stand-down heuristic keeps its meaning
- **Actor:** HS-http, Monitor
- **Story:** As a session that sees every wake twice, I want that still to mean "a second consumer (the plugin monitor) exists", so that `SKILL.md:116`'s stand-down rule stays correct.
- **AC:** Given one labeled socket and the plugin monitor both attached, Then each event yields one socket frame + one monitor wake line (doubled); Given two sockets of the same label (reconnect overlap), Then only the newest receives — not doubled.
- **Design refs:** §3.10 ("Each event is delivered to the newest live socket of a watch id only"), `SKILL.md:116`.
- **Phase:** 3
- **Status:** covered
- **Test:** server integration (`newest-wins`).

#### OWN-WAKE-05 — Per-watch-id bound and Monitor reconnect
- **Actor:** HS-http
- **Story:** As a session whose Monitor reconnected, I want the new socket to take over and the old to be reaped, so that a reconnect costs nothing.
- **AC:** Given watch id W has socket s1, When s2 arms with `?watch=W`, Then s2 receives, s1 idles until the heartbeat reaps it or a third arm closes it with code 4000 reason `replaced`; `MAX_SOCKETS_PER_WATCH = 2`; the global cap stays 16 (`503` beyond it).
- **Design refs:** §3.10, §4 Wake cap row.
- **Phase:** 3
- **Status:** covered
- **Test:** server integration (`per-watch bound`).

#### OWN-WAKE-06 — Solo release under one-watch-per-session
- **Actor:** Bryan, HS-http ×2
- **Story:** As Bryan flipping to Tandem, I want each session woken once, so that the doc-less release wake is not N-fold.
- **AC:** Given A and B each with one labeled socket plus the child, When `emitModeReleaseWake` fires, Then A's socket 1 frame, B's socket 1 frame, the child 1 stdin turn.
- **Design refs:** §3.9, §3.10.
- **Phase:** 3
- **Status:** covered
- **Test:** server integration.

#### OWN-WAKE-07 — No watch available: stock Windows without Git Bash, or no Monitor tool
- **Actor:** HS-http (Windows), Shim
- **Story:** As a session on a stock Windows box, I want the fallbacks to keep working under ownership, so that pull and the channel shim cover me.
- **AC:** Given no `Monitor` tool, Then the session keeps polling every 2–3 calls; ownership changes still appear in `ownership` on every poll; Given the channel shim, Then it receives full-payload `/api/events` unscoped (all docs) and the session's tool calls are ownership-checked server-side; Given `?filter=wake` via `curl` on macOS/Linux, Then the SSE stream carries no `?watch=` scoping (unscoped, as today).
- **Design refs:** §3.10 Channel shim / plugin monitor / SSE rows, §5.5, ADR-049 amendment 2026-08-09.
- **Phase:** 1–3
- **Status:** covered — decided 2026-09-17 (§5.5 — A: unscoped shim/monitor). The v3 note is closed: v4 §3.10 has an SSE row stating it gains no `?watch=`.
- **Test:** manual (`needs-human-evidence`) + server integration for the SSE path.

#### OWN-WAKE-08 — Unlabeled socket and the ownership frames in Phase 3
- **Actor:** Upgrader (v25 SKILL under a Phase 3 server)
- **Story:** As a v25 session holding an unlabeled socket, I want to know whether I receive `ownership:*` frames, so that Assign still nudges me.
- **AC:** Given R armed with no `?watch=`, When Bryan assigns D to R (or releases, or closes a tab), Then R's socket receives every ownership frame, broadcast, exactly as in Phase 1 — plus every wake-worthy event; only a socket that presented a `?watch=` is scoped; pull still shows it.
- **Design refs:** §3.4b ("Sockets with no `?watch=`… Phase 3 keeps exactly that for an unlabeled socket"), §3.10.
- **Phase:** 3
- **Status:** covered — closed in v4 by §3.4b (one rule, no third mode).
- **Test:** server integration.

#### OWN-WAKE-09 — Socket label drifts from the record label
- **Actor:** HS-http, Desktop
- **Story:** As a session whose record was re-created (idle reap re-init, bridge reconnect after the grace, or a handle bind after arming), I want my existing socket to keep receiving wakes for the documents I now own, so that "arm once per session" does not silently blind me.
- **AC:**
  - Given a `bridge:` or `claude:` record A armed `?watch=W`, A's record is dropped after the grace and re-created for the same `ownerId`, and A re-claims D, When Bryan comments on D, Then A's socket receives the wake — W is derived from `ownerId` and is the same id.
  - Given A armed with W and then binds a handle moving its transport to record R which owns E, When an event on E fires, Then A's socket receives it — `watchAlias[W] = R.ownerId` was written before A's old record was dropped (OWN-WAKE-13).
  - Given a direct-HTTP record A armed with W and idle for 30 minutes, Then A's transport is **not** reaped (`isPinned(entry)` answers true while W's socket is live) and nothing drifts (OWN-WAKE-12).
  - Given the same A evicted by the **LRU** cap instead, Then A re-initializes under a new `ownerId`; its socket keeps receiving unowned-doc and doc-less events but is dropped for the docs it re-claims until it re-arms — the stated residual, bounded by `DEFAULT_MAX_SESSIONS` and the pull path.
- **Design refs:** §3.10 "Label stability and socket follow-through" (paths 1–3), §5.11, §2 Watch id.
- **Phase:** 3
- **Status:** covered — closed in v4 by §3.10: derived watch id (path 1), `watchAlias` on bind (path 2), reaper pin (path 3, decided 2026-09-17 on §5.11-A). The LRU case is a stated known limitation.
- **Test:** server integration (four sequences) + transport-registry pin test.

#### OWN-WAKE-10 — Cowork remote session cannot arm and gets no `wakeUrl`
- **Actor:** Cowork
- **Story:** As a remote Cowork session under a non-loopback bind, I want no `wakeUrl` at all rather than one naming my own loopback, so that I do not sit on an unrelated service believing I am armed (#1952).
- **AC:** Given `TANDEM_BIND_HOST` non-loopback, Then `tandem_status`/`tandem_open`/`tandem_scratchpad` responses omit `wakeUrl` entirely (absent, not undefined); `verifyWakeUpgrade` still rejects the remote peer; the remote session can own documents; its items wait for its own poll; the badge shows its label and Bryan can Release.
- **Design refs:** §4 #1952 row, §6 Cowork.
- **Phase:** 1
- **Status:** covered — and see OWN-SEC-07.
- **Test:** unit (`wakeUrlField` with bind stub) + manual (Cowork bind).

#### OWN-WAKE-11 — The watch id is unguessable and the label appears in no URL (new in v4)
- **Actor:** Hostile, HS-http
- **Story:** As the server, I want the wake-scope key to be a per-record secret rather than the published label, so that nothing a client can read from Tandem lets it arm another session's watch.
- **AC:** Given record A with `ownerId`, Then `wakeUrl` is `ws://127.0.0.1:<port>/api/wake?watch=<base64url(HMAC-SHA256(runSecret, ownerId))[0..22)>`; `runSecret` is random per server run; A's label never appears in any URL; `tandem_listDocuments`, `Y_MAP_OPEN_DOCUMENTS`, the owners route, `tandem_status` of another session and `tandem_diagnostics` never carry a watch id; When H arms `?watch=<A's label>` or any value not derived with the secret, Then the socket resolves to no record (no error, no log line, no oracle) and receives only unowned-doc and doc-less events; `log-sanitize.ts` redacts the id pattern.
- **Design refs:** §3.10 Self-armed row (derivation, hygiene), §2 Watch id, §6.
- **Phase:** 3
- **Status:** covered
- **Test:** server integration (unknown id owns nothing; label-as-watch owns nothing) + unit (derivation is stable per `ownerId` and differs per run).

#### OWN-WAKE-12 — A live wake socket pins its transport against the idle reaper (new in v4)
- **Actor:** HS-http (direct HTTP, armed, no GET stream)
- **Story:** As an armed direct-HTTP session idle for 30 minutes, I want to keep my documents and my identity, so that arming a watch is never what costs me ownership.
- **AC:** Given A armed `?watch=W` and idle 30 min with no `GET /mcp` stream, Then `reapIdle` skips A's transport (`isPinned(entry)` true while W resolves to A's record and W has a live socket) and logs it on the existing pinned-skip line; When W's socket closes (process exit, or heartbeat reap), Then the next reaper pass treats A as unpinned and the ≈32-minute crash bound applies; Given A is instead evicted by the LRU cap (17th session), Then the eviction proceeds pin-blind as today.
- **Design refs:** §3.10 path 3, §5.11, §4 #1588 row, `transport-registry.ts:240-241`, `:251-259`.
- **Phase:** 3
- **Status:** covered — decided 2026-09-17 (§5.11 — A: pin). Whether a Monitor socket closes reliably on process exit on each OS is `needs-human-evidence`.
- **Test:** transport-registry pin test + server integration (reap skipped while socket live; reaped after close) + manual.

#### OWN-WAKE-13 — A once-armed socket follows a handle bind (new in v4)
- **Actor:** HS-http (helper H)
- **Story:** As a helper that armed its watch before presenting a handle, I want my socket to receive wakes for the orchestrator's documents after the bind, so that "arm once per session" holds across a hand-off.
- **AC:** Given H armed `?watch=WH` under its fresh record, When H binds O's handle (the "otherwise" or absorb row), Then `watchAlias[WH] = O.ownerId` is written before H's old record is dropped; events on O's documents reach H's socket; O's own socket (`WO`) is unaffected; When O's record is a launcher record and is torn down, Then the alias dies with it and H's socket falls back to owning nothing until H re-homes and re-arms.
- **Design refs:** §3.10 path 2, §3.2 rebinding table.
- **Phase:** 3
- **Status:** covered
- **Test:** server integration (`alias follows bind`).

---

## N. Security and abuse

#### OWN-SEC-01 — A hostile client cannot displace a live owner
- **Actor:** Hostile
- **Story:** As the user, I want a prompt-injected local MCP client to be unable to take my session's document, so that no MCP-side takeover exists (security F1).
- **AC:** Given D owned by live A, When H calls `tandem_open(D)`, `tandem_open({force:true})`, `tandem_close(D)`, `tandem_checkInbox({documentId: D})`, Then each answers `NOT_OWNER`; no tool has a `takeover` argument; no `ownership:*` frame reaches A from H's calls.
- **Design refs:** §3.4, §5.6, §6.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.6 — A: no MCP transfer).
- **Test:** server integration + schema test (no `takeover` in any `inputSchema`).

#### OWN-SEC-02 — A hostile client can claim unowned documents; Assign is the remedy, not Release
- **Actor:** Hostile, Bryan
- **Story:** As Bryan whose unowned documents were grabbed by a rogue client that polls or opens aggressively, I want to hand them to my real session in one step, so that a Release does not just hand them back to the rogue.
- **AC:** Given H claims D on delivery the instant Bryan comments, When Bryan Releases D, Then H (woken by `ownership:available`) can re-claim; When Bryan instead `assign`s D to A's label, Then D is A's and H's writes answer `NOT_OWNER` for as long as A is attached.
- **Design refs:** §6 Takeover and lockout, §3.4b Release fan-out.
- **Phase:** 1
- **Status:** covered — v4 §6 states that Release alone re-opens the first-poller race; the `NOT_OWNER` text (§3.4) and the Release hint ("next session to respond gets it", §3.11) steer to Assign.
- **Test:** server integration.

#### OWN-SEC-03 — Handles are low-grade capabilities: leak surfaces
- **Actor:** Hostile, HS-http
- **Story:** As the server, I want a leaked handle to gain a local caller nothing beyond what any local caller already has, so that the F2 reframing holds.
- **AC:** Given H obtains A's live handle (from a transcript), When H binds it (owning nothing, no in-flight), Then H acts as A — the same as binding its own record and claiming, minus displacing a live owner; handles appear redacted in `tandem.log` (`log-sanitize.ts`); never in `tandem_status` of another session, `tandem_diagnostics`, `/health`, or any Y.Map.
- **Design refs:** §6 bullet 1.
- **Phase:** 1
- **Status:** covered
- **Test:** unit (`log-sanitize`) + server integration.

#### OWN-SEC-04 — `/api` bypass is stated, not prevented
- **Actor:** Hostile, HS-http (with Bash)
- **Story:** As a refused session holding Bash, I could `curl` `POST /api/save` etc.; the design says so plainly and `SKILL.md` never points me there, so that the coordination-not-security framing is honest.
- **AC:** Given `NOT_OWNER`, Then the error message and SKILL v25 name the badge only; `POST /api/save`, `/api/apply-changes`, `/api/close`, `/api/remove-annotation`, `/api/annotation-reply`, `/api/channel-reply` remain ungated by ownership; `NON_LOOPBACK_ALLOWED` is unchanged; `tests/docs/loopback-gate-claims.test.ts` still passes (the six-route enumeration is unchanged: `/api/ownership` carries `assertOriginAllowlisted`).
- **Design refs:** §6 Bypasses, §4 `NON_LOOPBACK_ALLOWED` row.
- **Phase:** 1
- **Status:** covered
- **Test:** docs tests + grep test on SKILL for `/api`.

#### OWN-SEC-05 — `?watch=` probing and wake hijack via a published label
- **Actor:** Hostile (local MCP client, or any page on an allowlisted `127.0.0.1:<port>` origin)
- **Story:** As the user, I want no local caller to be able to silence another session's wakes from what Tandem publishes, so that a "quiet" session is not a hijacked one.
- **AC:**
  - Given an unknown watch id, When a socket arms with it, Then accepted, treated as owning nothing, never logged, not in diagnostics beyond counts (three pinned tests).
  - Given A's label L is visible to H (via `tandem_listDocuments` / `Y_MAP_OPEN_DOCUMENTS` / the owners route), When H tries to arm with L or with anything derived from L, Then H's socket resolves to no record and receives only unowned-doc and doc-less events; A's socket is untouched (the 2-per-watch bound is keyed on A's private id, which H does not hold).
  - Given H reads A's transcript and obtains A's watch id, When H arms two sockets with it, Then H can close A's socket (`replaced`) and absorb A's wakes — the accepted residual (OWN-SEC-10).
- **Design refs:** §3.10 (watch id derivation, "newest-wins is no longer a hijack primitive", hygiene), §6 "The watch id is a second capability of the same class".
- **Phase:** 3
- **Status:** covered (known limitation) — closed in v4 by the unguessable `?watch=` id; the transcript-reading residual is recorded in §6 as accepted-by-design with the argument (a transcript-reading process is local and already holds every write).
- **Test:** server integration (attacker socket armed from the published label + victim socket).

#### OWN-SEC-06 — Handle scrub scope
- **Actor:** HS-http, Hostile
- **Story:** As the server, I want a live handle refused in every text that is persisted or synced — chat, annotation text, `suggestedText`, replies, and document content via `tandem_edit`/`appendContent` — so that a handle cannot be laundered into the user's file or the annotation envelope.
- **AC:** Given live handle H or live watch id W, When any of `tandem_reply.text`, `tandem_comment` (`text` and `suggestedText`), `tandem_editAnnotation`, `tandem_annotationReply`, `tandem_edit.newText`, `tandem_appendContent`, `tandem_editList`, `tandem_scratchpad.content`, `tandem_rename.newName`, `tandem_status.text` carries H or W, Then `INVALID_ARGUMENT`; the comparison is against the live set only (an expired value is not refused).
- **Design refs:** §6 "Handle-scrub tool set", §3.6 (4).
- **Phase:** 1
- **Status:** covered — closed in v4 by the §6 enumerated set.
- **Test:** server integration table test.

#### OWN-SEC-07 — #1952 suppression also blinds local sessions on a non-loopback bind
- **Actor:** HS-http (local, under a Cowork bind), Cowork
- **Story:** As Bryan running a Cowork (non-loopback) bind, I want to know that my **local** hand-started session also stops receiving `wakeUrl`, so that I choose the channel shim for it rather than wonder why it never arms.
- **AC:** Given a non-loopback bind, When a **loopback** session calls `tandem_open`, Then `wakeUrl` is present (`getMcpContext().peerIsLoopback === true`, populated in `dispatchToSession` from `req.socket.remoteAddress`); When a **remote** session calls it, Then `wakeUrl` is absent; in stdio mode `getWakeEndpoint()` is null as today. The `docs/security.md` #1952 sentence "per-request loopback detection is not available inside a tool handler" is corrected in the sequenced edit.
- **Design refs:** §3.10 "#1952, per request", §3.2 `peerIsLoopback`, §4 #1952 row, §8 sequenced edits.
- **Phase:** 1
- **Status:** covered — closed in v4 by per-request suppression; the local session under a Cowork bind loses nothing.
- **Test:** unit.

#### OWN-SEC-08 — Presence is a coarse boolean
- **Actor:** Cowork (remote bearer holder), Hostile
- **Story:** As the user, I want a remote or hostile caller to learn no more than "owned / attached", so that ownership is not a presence oracle (F6).
- **AC:** Given `NOT_OWNER`, `tandem_listDocuments`, `tandem_status`, `tandem_diagnostics`, `/health`, Then only `ownerLabel` (random, non-ordinal), `ownerConnected: boolean`, and the static `ownerKind` / `ownerClient` words appear; never `lastSeenAt`, `since`, `cwd`, transport id, watch id, handle, or record counts beyond a total; `tandem_status` returns the caller's own record only; the attached-session enumeration exists only behind `GET /api/ownership/owners` (403 off-loopback).
- **Design refs:** §6 "Presence and the descriptor", §5.12.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.12: nickname, kind and client, no cwd; a nickname changes only on rename, so it adds no timing). Reconciled with OWN-CTL-06 in v4: the descriptor is static and adds no timing.
- **Test:** `mcp-output-schemas.test.ts` + diagnostics scrub test.

#### OWN-SEC-09 — Loopback rules unchanged
- **Actor:** Cowork, Bryan
- **Story:** As the maintainer, I want `/api/ownership` to inherit the path-wide loopback invariant and the wake upgrade to keep its `remoteAddress` check, so that no new LAN-reachable mutation appears.
- **AC:** Given a non-loopback POST to `/api/ownership`, Then 403 by `enforceLoopbackMutation`; `NON_LOOPBACK_ALLOWED` has no new entry; `verifyWakeUpgrade` unchanged; `license-gate-api-coverage.test.ts` gains exactly two rows (`API_OWNERSHIP` POST and `API_OWNERSHIP_OWNERS` GET, both `ungated`, with the §3.4 reasons) and its whole-registrar sweep sees `routes/ownership.ts`; the GET, being outside the non-GET invariant, checks `isLoopback(req.socket.remoteAddress)` in-handler (OWN-CTL-09).
- **Design refs:** §6 Loopback rules, §3.4 User control row.
- **Phase:** 1
- **Status:** covered
- **Test:** existing coverage tests + server integration.

#### OWN-SEC-10 — The watch id in the transcript is the accepted residual (new in v4)
- **Actor:** Hostile (transcript-reading local process), HS-http
- **Story:** As the maintainer, I want the one remaining way to silence a session's wakes stated and bounded, so that nobody reads "unguessable" as "unobtainable".
- **AC:** Given A's transcript (or the `Monitor` tool's arguments) contains A's `wakeUrl`, When a local process reads it and arms two sockets with A's watch id, Then A's socket is closed (`replaced`) and the attacker receives A's wakes — accepted: a process that reads Bryan's transcript files is local and already holds every write via the loopback auth bypass (`auth/middleware.ts:164-165`); a page on an allowlisted `127.0.0.1:<port>` origin cannot read a transcript and so cannot reach this; pull stays authoritative; the id gates wakes only, never reads, writes or the inbox. The case is recorded in §6, not in the `docs/security.md` register (sequenced edit), and is strictly narrower than v3's published-label hijack.
- **Design refs:** §6 "The watch id is a second capability of the same class"; §8 sequenced edits.
- **Phase:** 3
- **Status:** covered (known limitation)
- **Test:** none automatable beyond OWN-SEC-05's attacker test; documented expectation.

---

## O. Upgrade and compatibility across the phase boundaries

#### OWN-UPG-01 — Old bridge without `X-Tandem-Client-Id` against a Phase 1 server
- **Actor:** Upgrader (Desktop with an old `tandem mcp-stdio`)
- **Story:** As Claude Desktop running last release's bridge, I want to keep working under ownership, so that a bridge upgrade is not a prerequisite.
- **AC:** Given no client-id header and no `X-Claude-Session-Id`, Then the record is `mcp:<Mcp-Session-Id>`; a 404 re-init yields a new record; the old record's docs are released after the grace; implicit claim recovers them if unclaimed; no error the old bridge cannot forward.
- **Design refs:** §3.2 rule 3, §7 Phase 1 boundary ("Old bridge without the header").
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (transport without the header).

#### OWN-UPG-02 — v24 `SKILL.md` session against a Phase 1 server
- **Actor:** Upgrader (v24 skill)
- **Story:** As a session that loaded the old skill (server-side refresh has not run: HTTP mode only, `>=` version check), I want the new errors to be recoverable from their messages alone, so that a stale skill degrades rather than breaks.
- **AC:** Given v24 text ("omitting it targets the active document"; Session Handoff step 3 bare `getOutline`), When two docs are open, Then `DOCUMENT_REQUIRED` lists the ids and the session passes one; When it hits `NOT_OWNER`, Then the message tells it to inform the user about the badge; the arm-once wording is unchanged so v24's watch behaviour is still right.
- **Design refs:** §4 SKILL row, §7 Phase 1 boundary.
- **Phase:** 1
- **Status:** covered
- **Test:** acceptance harness against the v24 baseline (`git show v0.21.0` per the harness) — note the harness baseline is v9, so a v24 fixture must be added.

#### OWN-UPG-03 — Phase 1 server without Phase 3: unlabeled `wakeUrl`
- **Actor:** HS-http
- **Story:** As a session on a Phase 1 build, I want `wakeUrl` unchanged (no `?watch=`) and every event delivered, so that Phase 1 is "no state worse than today" for push.
- **AC:** Given Phase 1, Then `wakeUrl` has no query; sockets receive every wake-worthy event; ownership frames are broadcast to all sockets; the supervisor wakes the child on everything.
- **Design refs:** §7 Phase 1 vs 3.
- **Phase:** 1
- **Status:** covered
- **Test:** server integration (phase-gated expectations).

#### OWN-UPG-04 — Phase 3 server with a v25 skill (unlabeled socket)
- **Actor:** Upgrader (v25 skill under Phase 3)
- **Story:** As a v25 session, I want an unlabeled socket to still receive everything, so that Phase 3 only narrows for sessions that opted into a label by reading the new `wakeUrl`.
- **AC:** Given a socket armed without `?watch=`, Then it receives every wake-worthy event and every ownership frame as today; a v26 session armed with `?watch=` is scoped.
- **Design refs:** §3.10, §7 Phase 3 boundary.
- **Phase:** 3
- **Status:** covered — see OWN-WAKE-08 for ownership frames on that socket.
- **Test:** server integration.

#### OWN-UPG-05 — Bridge upgraded before the server (new header, old server)
- **Actor:** Upgrader
- **Story:** As a user who updated the npm CLI (new bridge) against a still-running old server, I want the extra header ignored, so that mixed versions do not break.
- **AC:** Given an old server receives `X-Tandem-Client-Id`, Then it is ignored (no CORS impact: native client); the bridge's fail-closed check is on the server **name** only, so a version change is adopted (#1759).
- **Design refs:** §3.2 rule 2, `mcp-stdio.ts` header comment.
- **Phase:** 1
- **Status:** covered
- **Test:** `tests/cli` bridge test.

#### OWN-UPG-06 — Phase 2 chat label needs a stored field
- **Actor:** Bryan
- **Story:** As Bryan in Phase 2, I want the owner label beside each Claude bubble, so that two owners' replies are distinguishable.
- **AC:** Given replies from A and B, Then each Claude `ChatMessage` carries the label of the record that sent it and the ChatPanel renders it; a legacy message without the field renders as today.
- **Design refs:** §3.6 (4) (`ChatMessage.ownerLabel?`, stamped by `appendClaudeChatMessage`, `withMcp`, `Y_MAP_CHAT` from constants, Phase 1), §7 Phase 2 (rendered), §8 Phase 1 (`types.ts (ChatMessage.ownerLabel)`), §4 `ChatMessage` row.
- **Phase:** 1 (stamp), 2 (render)
- **Status:** covered — closed in v4 by §3.6 (4): the field is stamped server-side in Phase 1 and is a public per-run id, not token-derived, so §3.7's rule holds; `channel-reply` messages carry no label (OWN-CHAT-09).
- **Test:** unit + E2E.

#### OWN-UPG-07 — Stale tab after an upgrade shows the new badge
- **Actor:** Upgrader (stale browser tab)
- **Story:** As Bryan reloading a tab that predates the upgrade, I want the badge to appear without a hard refresh beyond the generation rejection, so that the client bundle and server agree.
- **AC:** Given the old client bundle with a new server, Then unknown entry fields (`ownerLabel`, `ownerConnected`) are ignored by the old bundle; after reload the new bundle renders them; no client error on unknown fields.
- **Design refs:** §3.11, §3.4 Restart row.
- **Phase:** 1
- **Status:** covered
- **Test:** E2E.

---

## P. Licensing dark gate (only what touches the new route or tools)

#### OWN-LIC-01 — Byte-identical while dark
- **Actor:** Bryan (maintainer)
- **Story:** As the maintainer, I want ownership to add no behaviour to the dark license gate, so that `LICENSE_GATE_ENABLED = false` stays byte-identical in effect.
- **AC:** Given the gate is dark, Then `gatedTool` is a no-op before every ownership check; `POST /api/ownership` carries no `licenseGateMiddleware` and no in-handler `licenseGate()`; `license-gate-coverage.test.ts` asserts the MCP table unchanged (no new tool, `why` strings unchanged); `license-gate-api-coverage.test.ts` gains the two `ungated` rows with the §3.4 reasons; `tests/docs/license-flip-consts.test.ts` unaffected.
- **Design refs:** §3.4 User control row, §4 License tables row, §7 Phase 1 contracts.
- **Phase:** 1
- **Status:** covered
- **Test:** existing coverage tests.

#### OWN-LIC-02 — Restricted license refuses before any claim
- **Actor:** HS-http (gate active, `status: restricted`)
- **Story:** As a restricted session, I want `LICENSE_REQUIRED` on every gated tool before the queue, so that a refused caller never becomes an owner.
- **AC:** Given `TANDEM_LICENSE_GATE=1` and restricted, When A calls `tandem_edit`/`tandem_comment`/`tandem_scratchpad`/`tandem_open({force:true})` on unowned D, Then `LICENSE_REQUIRED`, D unowned; ungated tools (`tandem_save`, `tandem_open` plain, `tandem_reply`, `tandem_checkInbox`, `tandem_close`, `tandem_rename`, `tandem_convertToMarkdown`) still run the ownership check and **can** claim; `tandem_switchDocument` is ungated but never claims (OWN-OPEN-10).
- **Design refs:** §3.4a step 1 and the paragraph after the placement table ("A restricted-license session can still own a document through the ungated tools"), §3.7 Ordering.
- **Phase:** 1
- **Status:** covered — v4 §3.4a states the consequence.
- **Test:** server integration with the env fallback flag.

#### OWN-LIC-03 — Release/Assign stays available to a restricted user
- **Actor:** Bryan (restricted)
- **Story:** As a restricted user, I want to still Release and Assign, so that coordination state is not locked behind a license.
- **AC:** Given restricted, When Bryan uses the popover, Then `POST /api/ownership` succeeds (ungated); Surface A read-only is unaffected (the route writes no document content and no annotation store).
- **Design refs:** §3.4 User control row (Critical Rule 9 row reason).
- **Phase:** 1
- **Status:** covered
- **Test:** server integration.

---

## Q. Cross-actor stories not covered above

#### OWN-X-01 — Plugin-monitor session hits `NOT_OWNER` on foreign events
- **Actor:** Monitor
- **Story:** As a session woken by the plugin monitor for an event on a document another session owns, I want a clean `NOT_OWNER` (or an empty poll) rather than a double response, so that the unscoped monitor costs tokens, not correctness.
- **AC:** Given D owned by A and monitor-session M woken by D's event, When M polls, Then D is out of scope (empty); When M tries a write on D, Then `NOT_OWNER`; M's monitor wake line still parses (no new event types on `/api/events`).
- **Design refs:** §3.10 Plugin monitor row, §5.5.
- **Phase:** 1–3
- **Status:** covered — decided 2026-09-17 (§5.5-A).
- **Test:** `tests/monitor` + server integration.

#### OWN-X-02 — Channel-shim session under Cowork owning a document
- **Actor:** Shim, Cowork
- **Story:** As a remote Cowork session with the channel shim, I want my writes ownership-checked and my chat answers accepted through `channel-reply`, so that the shim path works remotely without a `NON_LOOPBACK_ALLOWED` change.
- **AC:** Given remote S owns D, Then S's MCP writes on D succeed; `POST /api/channel-reply {documentId: D}` (carve-out) succeeds and stamps `replyTo` when given; the shim's `/api/events` stream carries every doc's events (unscoped); Bryan sees S's label and can Release.
- **Design refs:** §3.6, §3.10, §5.5, §6 Cowork.
- **Phase:** 1
- **Status:** covered — decided 2026-09-17 (§5.5-A) — and see OWN-CHAT-09.
- **Test:** manual (`needs-human-evidence`: Cowork).

#### OWN-X-03 — Claude Desktop (bridge) all-day session
- **Actor:** Desktop
- **Story:** As Claude Desktop with one bridge alive all day and an open GET stream, I want to keep my documents across server-side session churn, so that the #1588 pin and ownership agree.
- **AC:** Given the GET stream pins the entry, Then the record is never idle-reaped; a LRU eviction triggers the bridge's 404 replay under the same `X-Tandem-Client-Id` inside the grace (OWN-LIVE-04); Desktop quit closes the stream and the reaper's TTL then bounds release at ≈32 min.
- **Design refs:** §3.2 rule 2, Bounds.
- **Phase:** 1
- **Status:** covered
- **Test:** manual (`needs-human-evidence`: Claude Desktop) + server integration for the eviction path.

#### OWN-X-04 — Non-Claude agent hands off with a handle
- **Actor:** NonClaude
- **Story:** As a non-Claude orchestrator, I want `ownerHandle` documented on the four entry tools in `tools/list`, so that I can hand a document to my own worker process.
- **AC:** Given `tools/list`, Then `tandem_status`, `tandem_open`, `tandem_scratchpad`, `tandem_checkInbox` declare `ownerHandle?: string` with a description naming the three outcomes; no other tool declares it.
- **Design refs:** §3.2, §4 Error vocabulary row.
- **Phase:** 1
- **Status:** covered
- **Test:** schema test.

<!-- END -->
