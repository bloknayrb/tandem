# Push paths / launcher / ADR / phasing review (Fable)

B1 BLOCKING — Phase 1 leaves the launcher child unable to see user-opened docs (worse than today)
- §7/§8 put the supervisor token in Phase 3. §3.3 rule 2 returns DOCUMENT_REQUIRED unless the owned set has exactly one doc. §3.4 iterates annotations over the owned set only.
- The launcher prompts (contract.ts:322-325, 338) only say "Call tandem_checkInbox".
- Scenario: the user opens a doc in Tauri (unowned per §5.5-A) and comments. The child is woken, polls with an empty owned set, gets nothing, and stays silent.
- The first-poller rule covers unowned chat but not annotations — an asymmetry the draft never states.
- Fix: apply the first-poller rule to annotations on unowned docs and let that poll claim the doc, OR move the supervisor token into Phase 1.

B2 BLOCKING — there is no "resume turn"; a resumed child never gets a token, and after a server restart it loops on UNKNOWN_OWNER
- supervisor.ts:1441-1463 sends SUPERVISOR_INITIAL_PROMPT only if !plan.resuming. A resumed spawn gets at most a wake prompt, and only when wakeOwedAcrossSpawns || loginRecheckOwed. contract.ts:320-321 documents fresh-spawn-only.
- Scenario: a restart drops tokens, the launcher resumes, and the child's history holds the old token. Every call answers UNKNOWN_OWNER, and tandem_open with a stale token is unspecified (§3.2 mints only when no token is passed), so this can loop.
- Also unspecified:
  - mint per run or per spawn (per spawn breaks a same-run crash-resume)
  - what happens to a dead child's owned set on a relaunch in a new cwd (a ghost takeover)
- Fix:
  - mint once per server run at module scope (the wakeOwedAcrossSpawns pattern, :753-763)
  - carry the token on SUPERVISOR_WAKE_PROMPT, which already rides every wake for compaction reasons (contract.ts:302-308)
  - on open, an unknown token re-mints
  - release or transfer the old token's set on child exit

H3 — ownership:transferred through the queue breaks version-pinned consumers and wakes all four paths
- WakeFrame.type is TandemEvent["type"] (wake-scope.ts:46), so widening isWakeWorthy adds a union member. parseTandemEvent returns null on unknown types (shared/events/types.ts:101-124), so an installed shim or plugin monitor silently drops it. emitModeReleaseWake chose annotation:created for exactly this reason (queue.ts:473-483).
- A queue event also writes a supervisor stdin turn and a channel event_type the channel instructions don't list.
- Fix: emit the frame from wake-socket.ts only to the affected sockets, bypassing pushEvent; or reuse an existing type.

H4 — doc-less events hit N sockets per session, indistinguishable from a duplicate consumer
- With ?doc= alone there is no per-session grouping, so the Solo release and doc-less chat produce N identical notifications.
- SKILL.md:116 treats that as "you are the second consumer; TaskStop". Re-wording it removes the model's only recovery from the real plugin-monitor duplicate, whose rate the 2026-09-10 amendment says is rising.
- Fix: add ?owner=<label> and deliver doc-less events once per label; or adopt §5.1-B.

H5 — superseded ADRs and contracts missing from §4/§7
- ADR-011 (decisions.md:46-48): "defaulting to the active document… single-document scripts work unchanged". Must be marked superseded by ADR-053.
- SKILL.md:
  - :207 Multi-Document ("omitting it targets the active document")
  - :199-203 Session Handoff step 3 (bare getOutline)
  - Workflow step 2
  All return DOCUMENT_REQUIRED for a session owning nothing.
- tandem_switchDocument becoming a stub:
  - tests/docs/tool-count-drift.test.ts:39-69 — the DEPRECATED_STUBS list and the notifyDeprecatedTool requirement
  - "30 active, 3 deprecated stubs" in docs/mcp-tools.md and CLAUDE.md → 29/4
  - tests/server/document-tools.test.ts:284 "switches active document"
  - license-gate-coverage.test.ts:59-61 gates stubs "for consistency", so the row's gate changes too, not only why
- tests/server/mcp-server-instructions.test.ts:80-83 pins SERVER_INSTRUCTIONS "at most once", but its wake wording changes in Phase 3 while the draft lists it only in Phase 1.
- tests/skill-instruction-contract.test.ts:434 pins body hash + version, so Phases 1 and 3 each need a bump.
- "No new tool or route" holds; "no new surface" does not:
  - ownerToken on every inputSchema
  - takeover on tandem_open
  - three ToolErrorCodeSchema codes
  - checkInboxOutputShape (tests/server/mcp-output-schemas.test.ts:402-481)
  - ~30 parameter tables in docs/mcp-tools.md
- The Claude Desktop stdio bridge keeps a cached tools/list until re-init (mcp-stdio.ts:31-39).

M6 — hand-started single-doc regression: one doc open in Tauri, the user hand-starts Claude Code, and tandem_getOutline() returns DOCUMENT_REQUIRED. Works today. Fix: rule 2 falls through to "exactly one open doc" for reads, or the first read auto-claims a singleton unowned doc.

M7 — contradiction on launcher claiming: the §3.1 D2 row says the child claims its cwd's docs, but §3.8 defers to §5.5, and §5.5 recommends A (unowned) for Phase 1.

M8 — alreadyPushed honesty: each socket subscribes "external" (wake-socket.ts:234-250). A doc filter inside the socket callback runs after trackPayloadId, so an event gets stamped pushed when only a foreign-doc socket exists. Advisory (queue.ts:441-447), but state it in the ADR-049 amendment.

L9 — verified claims:
- getCurrentSessionId has zero callers
- cap 16 / 503 (wake-socket.ts:75, 203-214)
- DEFAULT_MAX_SESSIONS 16 / 30-min idle
- cwd-preview.ts:18-23
- resolveCwd :1049-1062
- let child :705
Unstated cost of cap 64: each per-doc arm is a separate host Monitor task with its own rate limiter — unmeasured.

L10 — restart/generationId is consistent, but the owner labels must be cleared before the bind (index.ts:593-602), or a restored-then-claimed doc reuses owner-1 for a different session.
