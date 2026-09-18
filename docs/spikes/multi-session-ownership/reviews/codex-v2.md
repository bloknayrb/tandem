# Codex review of design v2 (checked against master 33f846e1; v2 cited c6533cb0)

## Findings
1. §3.5: polling and claiming can send work to different sessions. A polls an unowned doc and marks its chat read; B then opens or writes it and becomes owner. A can no longer answer, and B never receives the already-read chat. This is the same problem as the takeover residual, but on ordinary first claim. Separate "delivered" from "handled", and make unanswered items recoverable by a new owner.
2. §3.7: a check at handler entry isn't enough. Save, open, rename and close await async work, so ownership can change after the check while the old owner's operation continues. Define how a transfer interacts with in-flight writes, and when an unsuccessful write's implicit claim is kept or rolled back.
3. §3.4/§3.10: assignment doesn't wake the new owner. It closes the old owner's sockets and records a pull-visible change, but an idle recipient doesn't learn of it until it next polls.
4. §5.1: choose one watch per session. Per-doc sockets add replacement, dedupe, reassignment and re-arm complexity, and the 8-per-label limit leaves a 9th owned doc with no specified watch.
5. §3.2: transport presence is overstated as liveness. A crashed client can keep ownership for up to the 30-min reaper plus the 2-min grace, and an idle live client may lose it. State those bounds prominently. Also, Phase 1 errors tell users to reassign via a tab menu that doesn't ship until Phase 2.
6. §3.6: the global-reply exception is ambiguous. "Resolve by §3.3" implies DOCUMENT_REQUIRED, while "with none it stays a global chat send" implies success. When replyTo points at a doc-linked message, derive or validate that doc and apply ownership.
7. Handle rebinding is incompletely specified: docs already owned by the presenting transport, concurrent requests, and handles from a previous child run.
8. The review table says "fixed" where these are only proposals.

## Codex's concrete recommendations
1. Claim an unowned doc when a poll returns actionable work on it. Claim atomically, BEFORE marking chat read or recording delivery. A poll that finds nothing claims nothing. On release or reassignment, unanswered work becomes available again: "read" must not mean "handled".
2. Serialize ownership changes with writes per document: one per-doc operation queue for MCP mutations and Release/Assign, with ownership checked inside the queue. An operation already running finishes before a reassignment takes effect; queued operations from the old owner then fail. Validate inputs and licensing before an implicit claim, so an invalid request never acquires ownership.
3. Wake the recipient on assignment with a payload-free notification to poll. Make pending work available before sending it, apply the existing Solo privacy rules, and keep ownership changes in the inbox so a missed wake is recoverable.
4. One socket per owner/session. For each event, resolve its scope from the current ownership map: owned docs, eligible unowned docs, and doc-less events. That removes the per-doc limit and most re-arm complexity. Keep a bounded socket count and explicit reconnect/replacement behavior.
5. Say "connected" or "transport attached", not "responsive". Keep the 2-min grace, but document that crash detection may take another 30 min. Ship Release/Assign together with enforcement.
6. Deterministic reply routing: with replyTo, derive the doc from the referenced message and reject a conflicting explicit documentId; without replyTo, use the explicit documentId, then the single-doc fallback; still ambiguous → DOCUMENT_REQUIRED. Keep doc-less replies only for genuinely doc-less legacy messages, and never silently turn a failed resolution into global chat.
7. Restrict handle rebinding to an unused transport: allowed only if the transport owns nothing and has no in-flight doc ops, and idempotent success if it's already bound to that owner; otherwise a clear conflict, with no silent merging of groups. Mint launcher handles per child run, invalidate them on exit, and bind before processing the entry tool. An invalid handle returns a recoverable error with no side effects; silently ignoring it could let a stale child claim docs under a new identity.
8. Status labels: "addressed in design", "decision pending", "implemented", "verified". Reserve "fixed" for implemented, checked behavior.
Priorities: claim-on-delivery, serialized transfer, recoverable unanswered work.

## Orchestrator notes (Claude)
- Adopt all eight.
- #3 constraint (push H3): the recipient wake must NOT be a new TandemEvent through the queue, because installed shim/monitor parsers drop unknown types. Emit it socket-locally on the recipient's own wake socket, and on supervisor stdin when the recipient is the launcher child, with the inbox pull as the backstop. Respect Solo.
- #7 reverses v2's "unknown handle ignored". That's safe because every supervisor wake prompt carries the current handle, so an error is recoverable and can't loop.
- #1 needs a "handled" concept. Chat has only `read` today. Define what counts as handled (e.g. a tandem_reply with replyTo, or an annotation response) and how unhandled items resurface.
