# Security review (security-reviewer)

Verified draft citations: wake-socket.ts:75, 118-140, 181; wake-scope.ts:39-41, 78-80; api-routes.ts:214-225; license-gate-coverage.test.ts:84-85.

## F1 — HIGH, BLOCKING: takeover can loop forever, and a hostile client can use it to lock out the user's session
- Takeover costs one flag. NOT_OWNER advertises `takeover: true`. §3.10 makes ownership:transferred wake-worthy. There is no rate limit, and the user has no way to control or release ownership. isWakeWorthy is shared by three consumers (wake-scope.ts:39-41), so widening it also reaches the supervisor stdin wake.
- Scenario 1: A takes over the doc, which wakes B. B's write gets NOT_OWNER, so B takes over and A is woken. The ping-pong runs unattended, including the launcher child.
- Scenario 2: a hostile or prompt-injected local MCP client lists the docs and takes over all of them. The user's session is then refused on every write, and §3.4 routes the user's chat to the attacker, which marks it read. The only recovery is another takeover, which leads back to Scenario 1. This is a new persistent, targeted lock with no release the user can trigger.
- Fix:
  - Make ownership:transferred not wake-worthy; deliver it on the owner's next pull.
  - Rate-limit takeover per doc, and refuse an immediate take-back by the previous owner.
  - Give the user an authoritative release/assign control in the browser.
  - Keep "takeover" out of the refusal text.

## F2 — MEDIUM: §6's "the token is not auth / a stolen token gains nothing" is wrong
- auth/middleware.ts:165-168 skips auth for loopback callers, so "bearer is the only auth" is false locally.
- A leaked token gives silent writes (no transfer notice) and silent inbox drains of the user's chat.
- Leak surfaces:
  - tool args in transcripts
  - the supervisor bootstrap turn on stdin
  - models copying the token into tandem_reply text; CTRL_ROOM chat is persisted to disk (session/manager.ts:614, 736) and synced to every client
- Fix:
  - Call the token a low-grade capability.
  - Refuse or scrub a live token string in chat and annotation text.
  - Record which Mcp-Session-Id minted it, and notify the owner when a different session first uses it (a hint, not a guard).

## F3 — MEDIUM: raising the wake cap to 64 while scoped sockets are never tied to document lifecycle
- The cap is sized for "a handful of sessions" (wake-socket.ts:57-74). The heartbeat (265-278) only removes dead peers, and a live Monitor never dies. The draft never closes scoped sockets on close or takeover.
- Scenario: a long session fills 64 slots with sockets for closed docs, and after that new docs get 503 and are never woken. Any page on any 127.0.0.1:<port> passes the port-wildcard origin allowlist and can fill the cap. A runaway arm loop gets four times more room.
- Fix: the server closes scoped sockets on doc close and on takeover; add a per-doc limit (e.g. 2) under the global cap.

## F4 — LOW: D4 contradicts §3.7, and /api is a working bypass
- D4 says enforcement lives in tool handlers AND /api routes; §3.7 says /api is unchanged.
- A Claude Code session with Bash that gets NOT_OWNER can curl POST /api/save, /api/apply-changes, /api/close, /api/remove-annotation or /api/annotation-reply. Origin is forgeable.
- POST /api/channel-reply (channel-routes.ts:130-142) takes a caller-chosen documentId, is exempt from the loopback rule, and bypasses §3.5.
- Fix: make D4 match §3.7, state plainly that ownership is coordination only and bypassable by any local process, and keep any mention of /api out of SKILL.md's refusal guidance.

## F5 — LOW: ?doc=<documentId> vs ADR-049 D2
- The docId is <basename-slug>-<hash>. push-liveness.ts refuses to retain one. Today nothing logs req.url (wake-socket.ts:209, 257).
- The new exposure is a server-side per-socket record of the docId.
- Fix: don't log ?doc= or expose it in diagnostics; cap its length and charset; accept an unknown id without checking it (no probe for which docs are open). Pin all three with tests.

## F6 — LOW: presence leak
- NOT_OWNER returning {ownerPresent, lastSeenAt}, plus owner labels in documentMeta, reveals when the user's other session is active, including to a remote bearer holder under Cowork. The label's registration order also reveals how many sessions have minted tokens.
- Fix: return a coarse ownerPresent boolean only, and keep the token map out of status and diagnostics.

## F7 — LOW: Cowork plus #1952
- Remote Cowork sessions can't arm the wake socket (loopback-only, wake-socket.ts:133) but can own docs. The owned-set filter then keeps that doc's chat from a woken local session, so the user's messages wait silently.
- Fix: move the #1952 fix to Phase 1, and document the unwoken-remote-owner case.

## Info
- "No new license rows" is correct. tandem_open stays ungated with its in-handler force gate (license-gate-coverage.test.ts:74-76). Make sure the ownership refusal on force-over-foreign doesn't mask license-force-open-gate.test.ts.
- The wake path still reads only remoteAddress; no Host-header regression.

Blocking: F1 only. F2 is the main non-blocking fix.
