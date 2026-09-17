# Model-behavior / UX review (Fable)

Cites checked and correct: registry.ts:345-351, awareness.ts:485-499, mcp-stdio.ts:21-35, context.ts:82-84, transport-registry.ts:137-138, wake-socket.ts:75, observers/annotations.ts:158-180, useChatState.svelte.ts:30, App.svelte:1975.

## 1. BLOCKING — a token carried in context can only be recovered by taking over yourself
- §3.2's UNKNOWN_OWNER covers only a token the server never minted. A lost token (compaction, /clear, `claude --resume` the next morning with the server still up, a garbled string) leaves the doc owned. tandem_open then answers NOT_OWNER with ownerPresent:true, because the caller itself advanced lastSeenAt. SKILL.md:101 already documents that compaction erases session-scoped facts like this.
- Scenario: a 40-minute review hits compaction. The next edit gets NOT_OWNER, re-open gets NOT_OWNER, and the only exit is takeover:true, which wakes the model's own socket. "Take over when refused" becomes a learned reflex and voids D4 against a genuine second live session.
- Subagents make it worse: docs/workflows.md:235-247 has non-fork subagents calling tandem tools directly. They never hold the token, and one following "re-open to claim" takes the doc from its own orchestrator.
- Fix: bind ownership to something the model doesn't carry (see 3). Keep a token only as an explicit hand-off.

## 2. BLOCKING — §3.8 contradicts the supervisor: a resumed child gets no bootstrap turn
- supervisor.ts:1441-1457 sends SUPERVISOR_INITIAL_PROMPT only when !plan.resuming. On resume it sends at most SUPERVISOR_WAKE_PROMPT (contract.ts:338), which is payload-free by design.
- After every crash-restart, start-at-login resume, or child compaction, the child has no token and owns nothing, so D2's launcher claim is silently off.
- The supervisor holds the child's stdin and pid, which makes it the easiest place to bind ownership server-side.

## 3. HIGH — a materially simpler design exists (transport-attached owner record)
One ownerByDoc map keyed by a server-side owner record that is attached to a transport when one exists, and falls back to an explicit token only when none does. sessions/context.ts:69-71 already hands every handler {claudeSessionId, mcpSessionId}, and the transport registry already tracks lastSeenAt/openStreams (#1588 pinning).
- stdio bridge (Desktop, Cowork): the bridge sees the 404 and replays initialize (mcp-stdio.ts:31-35, 1136-1178). The server puts an owner handle in the initialize result `_meta`, and the bridge echoes it as a header on the replayed handshake. The model never sees it, and subagents share the bridge process so they inherit it.
- Launcher child: the supervisor mints the handle and injects it (env var, or a header on the MCP entry it writes). This fixes finding 2.
- Hand-launched direct-HTTP Claude Code: bind to Mcp-Session-Id for the session's life. When the session ends (process exit, or reap with no open stream), its docs become UNOWNED, which is the correct semantic. §3.2's "token outlives all of these" is exactly the property that produces finding 1.
- 2026-07-28 stateless clients (context.ts:52-56) and non-Claude agents: explicit token.
- Result: ownerToken becomes an optional arg on tandem_open/tandem_status for hand-off, not ~34 registrations. SERVER_INSTRUCTIONS (truncated at 2 KB, decisions.md:1869) needs one sentence, not a protocol.

## 4. HIGH — §3.7 contradicts D1
Non-owner comment/flag/suggest on any doc, plus the "first poller" for doc-less chat, is two sessions responding, which D1 forbids. The owner also gets no annotation:created for it. Either all non-owner writes refuse, or D1 is narrowed explicitly to "only the owner answers the inbox".

## 5. HIGH — the user has no action on a dead-owner doc
If a session crashes without closing, its token stays in memory forever (§3.2 never expires it). The user's chat on that doc is skipped by every other inbox, nothing wakes, and the badge offers no action. Needs transport-death release (finding 3), or a tab "Release" action. The latter is a new mutating /api route and a Critical Rule 9 row, contradicting "no new license rows".

## 6. MEDIUM — §3.3 breaks the documented cold start
SKILL.md:36 (getOutline with no id) and Session Handoff :199-203 (status → listDocuments → getOutline) run against restored, unowned docs and hit DOCUMENT_REQUIRED at step 3. The channel-shim tandem_reply (channel/run.ts:81) and the plugin monitor never claim anything. Either reads keep an activeDocId fallback, or SKILL.md v25 rewrites Workflow and Session Handoff too.

## 7. MEDIUM — D6 cwd depends on order and takeover
It changes meaning when the first doc closes or is taken over. cwd is a property of the session (the supervisor already knows it, :1049-1062), not something derivable from an owned set.

## 8. MEDIUM — per-doc sockets break the stand-down signal
SKILL.md:116 says "every wake twice → stand down". With N scoped sockets, doc-less events (Solo release) arrive N times by design, and the model stands down all its watches. Recommend 5.1 B, which also drops the cap change and the #1952 sequencing.

## 9. LOW — chat UX
Send grayed out on an empty tab, with scratchpads unresolved, may make the user's first message in a fresh window impossible. The disabled state must say why.
