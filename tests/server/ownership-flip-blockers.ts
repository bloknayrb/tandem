/**
 * What the ownership flip must not land without (#2358, ADR-054).
 *
 * **The one list.** The PRs of the dark series leave gaps open on purpose,
 * each to be closed by a later PR or by a decision of Bryan's, or accepted by
 * him for the flip (below). They used to be held in prose (the plan's flip
 * row, ADR amendments) and in memory. Each is a row here, and
 * `tests/server/ownership-flag.test.ts` fails when the release literal
 * `OWNERSHIP_ENABLED` is `true` while a row without `acceptedFor` remains.
 * The plan's flip row (`docs/plans/2358-ownership.md`, PR 6) points here.
 *
 * **To close a row:** land what `closedBy` names, then delete the row in that
 * same PR. A row is never closed by editing its text; the one sanctioned edit
 * to a standing row is adding `acceptedFor`, which records a pick of Bryan's
 * and does not close it. The flip PR may set the literal only once every
 * remaining row carries `acceptedFor`.
 *
 * **An accepted row** stays in the list, still open, and does not stop the
 * flip. Adding `acceptedFor` records a pick of Bryan's, cited in ADR-054;
 * removing it re-blocks the flip. Accepting is not closing: what `closedBy`
 * names is still owed. `ownership-flag.test.ts` pins the accepted rows' full
 * text, so a new acceptance, or any edit to an accepted row, edits a named pin.
 *
 * Closed, kept for the record: *the setup-entry change shipped in an earlier
 * release than the flip* (the plan's flip row waited for it). It shipped in
 * v0.31.0 (CHANGELOG, 2026-11-11: "Claude Code now reaches Tandem through
 * Tandem's bridge"), so it is not a row.
 *
 * Not a test file: no `.test.` in its name, so vitest does not collect it.
 */

export interface FlipBlocker {
  /** What is open, in a sentence a reader of this file alone can act on. */
  readonly gap: string;
  /** The test, PR or decision that closes it. */
  readonly closedBy: string;
  /**
   * Set only when Bryan accepted the gap for the flip: his pick, quoted as
   * option text, with the issue tracking it. The row stays open and does not
   * stop the flip (header). Must name an issue (`#n`) that ADR-054 names.
   */
  readonly acceptedFor?: string;
}

export const OWNERSHIP_FLIP_BLOCKERS: readonly FlipBlocker[] = [
  {
    gap:
      "The posts PR drops CTRL-doc update data left pending after a browser tab's update " +
      "(security review H1), on the reasoned but unmeasured premise that a real tab never " +
      "leaves anything pending (CTRL is a star: a tab's update depends only on what the " +
      "server sent it or it sent first). If a real tab can, its chat or mode write would be " +
      "dropped silently.",
    closedBy:
      "A measurement with real browser tabs (reconnect, offline edits, two tabs) showing no " +
      "pending data after a tab's update, or a narrower drop.",
  },
  {
    gap:
      "The handled filter for comment threads (design §6.4's first two bullets), together with the " +
      "stripping of client-written Claude replies: without the filter an answered comment or reply " +
      "is re-owed by every handover (handover gap (c)); without the stripping a browser client " +
      "could hide a comment from every inbox.",
    closedBy:
      "The PR that lets Claude reply on a user's comment thread (#2360), after its 'later reply' " +
      "rule is reworked (as designed it would lose a user reply written during Solo).",
  },
  {
    gap:
      "tandem_checkInbox's description and the shipped skill say things that are false flag-on " +
      "once the scope PR lands. The description: 'once a poll of yours has read a document, " +
      "another session's polls never hide its items from you' (with inbox scope, only the " +
      "document's holder reads it); 'each item repeats on every poll until you pass a cursor from " +
      "a response that held it' (after a handover an acknowledged item is handed again, " +
      "unmarked; and since the notice-rule PR an accept or dismiss notice is not repeated once " +
      "its document has left the holder that was handed it, even to that holder's own retry " +
      "with an old cursor, so 'Items repeat until acknowledged ... recovered by polling again " +
      "with the same cursor' is false for it); 'Omit `documentId` to cover every open document'; and the summary's 'The cursor " +
      "was not recognised ... returns everything not yet acknowledged' (only what is in scope). " +
      "The `documentId` input: 'Omit it to poll every open document'. skills/tandem/SKILL.md: " +
      "'polls every open document', and its contract that a summary with no document read means " +
      "nothing is open (flag-on, it can mean nothing open is yours to answer). docs/mcp-tools.md's " +
      "tandem_checkInbox section says the same things; it carries a 'ships dark' paragraph listing " +
      "what changes flag-on, and the flip PR rewrites the section. Since the chat owners PR " +
      "also: tandem_checkInbox's '`chatMessages` spans every document', 'each item repeats on " +
      "every poll until you pass a cursor from a response that held it' and 'a chat message you " +
      "answered with tandem_reply `replyTo` is not repeated' (chat is scoped by owner); " +
      "CHAT_ACK_DIRECTIVE (said to every poll that hands chat, though a refused reply is now " +
      "possible); and tandem_reply's `documentId` input 'defaults to active document' (a reply " +
      "to a message is stamped with the message's document; since the posts PR, a post with no " +
      "`documentId` from a session that does not hold the active document is stamped with no " +
      "document, and one from a session that may not post doc-less is refused `post`).",
    closedBy:
      "The flip PR: the flag-off text cannot change while dark, and the skill ships live, so it " +
      "changes at the flip together with the plugin ref bump.",
  },
  {
    gap:
      "The lone-session re-hand. With one session attached, a close and reopen of a tab it holds, " +
      "a lapse (a laptop asleep past the grace, a Claude Code restart, the detached-record cap, or " +
      "a session whose stream dropped while it keeps making requests: it is detached, each request " +
      "re-arms the two-minute grace, an idle spell past it lapses it, its next write claims the " +
      "document again with no handover, and the next idle lapse hands over again, so it is " +
      "re-handed on every write-then-idle cycle; how often a dropped stream with live requests " +
      "happens is unverified) or " +
      "any other handover hands it again every pending user comment on that document, answered or " +
      "not, every resolved comment that was ever edited, and every user reply on a Claude-facing " +
      "thread, resolved long ago or not, so the re-hand grows with the document's history until the " +
      "handled filter lands; and a comment edited since it was seen arrives without `edited: true`. " +
      "On master a close and reopen re-hands nothing. Since the notice-rule PR, each lapse also " +
      "settles the accept and dismiss notices from any response that session lost (#2294): in " +
      "the write-then-idle cycle a lost response's notices go to nobody, the session included. " +
      "(A restart that returns under the same owner " +
      "id inside the two-minute grace is no handover: its fresh cursor counts what its earlier " +
      "incarnation acknowledged as seen, as on master, so the outcome turns on the grace.) Since " +
      "the scope PR a detached record also claims a document again on a poll that yields it " +
      "something, so the write-then-idle cycle is also a poll-then-idle cycle.",
    closedBy: "Bryan's answer to it (PR of the handover, 'Needs Bryan').",
    acceptedFor:
      "Bryan picked 'Accept (Recommended)' for the lone-session re-hand, picked from options, " +
      "2026-11-23 (#2360's handled filter shrinks it); tracked as #2358.",
  },
  {
    gap:
      "`ownership.notYours` in tandem_checkInbox tells any local MCP client that a document is " +
      "not its to answer (the named one, or on a default poll every open document it left out) (design §11.3's holder exposure, accepted by Bryan 2026-11-05, " +
      "decision 4). Since the change-notice PR, `ownership.changed` and the summary's loss " +
      "sentence also tell it that another session's open took a document it held, without " +
      "identifying that session: where `notYours` says only that another session 'may' be " +
      "answering, `changed` says it definitely, and to within one poll interval. A " +
      "'its tab was closed' entry tells it that some local actor (the user, or any process " +
      "through POST /api/close) closed a tab it held. And anything presenting the same identity " +
      "shares one queue, so any local process presenting a session's identity can drain the " +
      "explanations meant for that session (a destructive read; `holding` is unaffected; within " +
      "D4, coordination not security). It is not yet in docs/security.md's register.",
    closedBy: "PR 5's owners entry in docs/security.md (design §11.3).",
  },
  {
    gap:
      "Flag on, a message's delivery round that no poll will ever hand and no reply will name " +
      "stays open, so the stall banner reports it: until a restart for a user row a client " +
      "deleted whose undo failed (the row is gone, so Clear chat, which drops the rounds of the " +
      "rows it finds, never drops it); until Clear chat for a client-added user row under a key " +
      "that a Claude reply already handles, and for a carried-over key re-added after such a " +
      "delete. Each needs client-written rows. Kept open with no fix in the delivery-rounds PR " +
      "(the reviewing session's ruling); Bryan decides whether to accept it or have the inbox's " +
      "'never handed' answer key such a forward as no round.",
    closedBy: "Bryan's decision, before the flip.",
    acceptedFor:
      "Bryan picked 'Accept (Recommended)', picked from options, 2026-11-23 (it needs " +
      "client-written rows the server undoes); tracked as #2358.",
  },
  {
    gap:
      "Flag on, the stall banner's wording ('Your message is queued — it'll be seen the next " +
      "time Claude checks in') and its lack of a dismiss have not been reviewed against keyed " +
      "rounds: with two sessions, a session idle at its prompt that holds a document keeps the " +
      "banner up while another session polls and is never handed that document's item.",
    closedBy:
      "Bryan's review of the banner against keyed rounds, in PR 3b (once its wakes open rounds, " +
      "which changes when the banner shows; 3b-2b1c-a's start-or-wake opens none).",
  },
  {
    gap:
      "A lapse to unowned wakes no session that is reached only by a push stream (the channel " +
      "shim, the plugin monitor): since 3b-2d the `ownership` frame on /api/wake wakes an armed " +
      "watch, and 3b-2b2's start rules Tandem's Claude, but nothing nudges /api/events, so " +
      "such a session waits for its next poll for a document that went unowned with work on it.",
    closedBy:
      "PR 4a (the payload-free `ownership-changed` event on every push stream, ownership " +
      "design §8.6, §9.1). Presence, the /api/wake frame (3b-2d) and the start rules of 3b-2b2 " +
      "have landed.",
  },
  {
    gap:
      "Push paths (/api/events, /api/wake, the channel shim, the plugin monitor) still deliver " +
      "every user chat:message to every consumer, so a session can be pushed chat it may not " +
      "answer (the chat owners PR scoped the inbox and the reply, not pushes).",
    closedBy: "PR 4 (push scope, design §9.1).",
  },
  {
    gap:
      "A live acknowledger that never answers: since the posts PR an acknowledgement counts for " +
      "nothing, so an acknowledged message is re-owed at any change of its owner, but while the " +
      "acknowledger's record lives and owns the message (a doc-less or closed-document message, " +
      "or Ruling 4's arm) nobody else is handed it, and the pickup row reads 'working'.",
    closedBy: "PR 5's control on the message (Release from its pickup row).",
  },
  {
    gap:
      "/api/channel-reply appends Claude rows with replyTo, answers and acknowledgements " +
      "(inProgress) alike, with no ownership check, sets no owner, and calls markUserChatRead. " +
      "A channel-reply final reply handles its message (an unmapped shim session can answer a " +
      "message another session owns), and settles only its target. A channel-reply " +
      "acknowledgement handles nothing and sets no owner, but it still stamps `read`, so on a " +
      "message a re-owe made unread it hides the message from its owner's polls (cursor and " +
      "cursor-less) until the next re-owe (the posts PR, R0.5). A message is handled only by a " +
      "final reply or `settles` (Ruling 11). With no re-owe after it, such an acknowledgement " +
      "takes the message out of waiting for good.",
    closedBy: "PR 4 (the shim's permit, design §9.2).",
  },
  {
    gap:
      "The pickup and stall clock still counts from the message's arrival, not its last change " +
      "of owner (design §6.5's sentence, deferred), so a re-owed message older than the stall " +
      "threshold reads 'still waiting' at once and may show the Claude Code offer, though a " +
      "session started from that offer is not handed it while another session holds the " +
      "document (the chat owners PR, R8.1, R8.3).",
    closedBy: "PR 5 (the clock carried to the client).",
  },
  {
    gap:
      "After a tab close, chat stays with the closing holder even when the document is reopened " +
      "and claimed by another session (R6.3); and a message whose per-message owner never " +
      "answers reads 'still waiting' with the Claude Code offer, and a session started from " +
      "that offer is not handed it (R8.2).",
    closedBy: "PR 5's controls (Assign and Release of a document and of a message).",
  },
  {
    gap:
      "A document claimed by a poll whose items its holder then never answers: the holder keeps " +
      "it, and no other session is handed its items until a lapse, a close or a take moves it " +
      "(design §8.5's 'waiting' is what would start or wake the holder; until then nothing does). " +
      "Since the chat owners PR the same holds for a message owned per message that its owner " +
      "never answers: nobody else is handed it while that owner's record exists. An unhandled " +
      "one (an acknowledged one included: since the posts PR an acknowledgement handles nothing) " +
      "is re-owed at the owner's lapse; a handled one (by a final reply or `settles`) is never " +
      "re-owed, and stays the owner's until its record is deleted.",
    closedBy:
      "PR 3b for Tandem's Claude (3b-2b1c-a forwards a change of owner only, not a holder that " +
      "keeps an item unanswered), or Bryan's answer for terminals.",
    acceptedFor:
      "Bryan picked 'Accept, use Release/Assign (Recommended)', picked from options, 2026-11-23 " +
      "(PR 5's controls are the remedy); tracked as #2358.",
  },
  {
    gap:
      "Output schemas across the flip: an MCP client caches tool output schemas from tools/list, " +
      "and the stdio bridge's re-initialize after a 404 never lists again, so a session (Claude " +
      "Desktop through the bridge, say) that lives across the upgrade from a dark build to the " +
      "flipped one keeps tandem_checkInbox's and tandem_status's dark schemas, which have no " +
      "`ownership` / `owner` field, and its SDK rejects every response that carries one " +
      "(additionalProperties: false).",
    closedBy:
      "The flip PR: a remedy for cached schemas (a tools/list_changed notification, a re-list on " +
      "the bridge's replay, or a documented restart), decided there.",
  },
  {
    gap:
      "Queue wait bound, the uncovered half (the plan's flip row, gate (a), recorded by 1c's " +
      "review 2026-11-11): the stdio bridge signals cancellation (`notifications/cancelled`) on " +
      "every path where it answers a request for the server (its request timer, a session swap, " +
      "an unreachable upstream).",
    closedBy:
      "That bridge change (the bridge ships live, so it is its own change, not part of the dark " +
      "series), or Bryan accepts that a bridge call can run up to 20 seconds after the bridge " +
      "reported it failed, so a retry can land twice.",
  },
  {
    gap:
      "Change-notice causes PR 5 owes (R7.2): lost by Release and by Assign, gained by Assign, " +
      "each a past-tense fact with no instruction (Ruling 10); a released session is told only " +
      "that the document was released, never that the user chose it (design §11.3). Until then " +
      "such a change is told only through `holding`.",
    closedBy: "PR 5: the causes, with tests through their production paths.",
  },
  {
    gap:
      "Whether Claude Code shows output-schema descriptions to a model is unverified (the " +
      "change-notice PR): if it does not, a model sees only `changed`'s bare cause words and the " +
      "summary sentence, not the description saying `holding` is the truth and `changed` may be " +
      "incomplete.",
    closedBy:
      "A hand test on a real Claude Code session before the flip, recorded on #2358; if the " +
      "descriptions are not shown, a decision on where that sentence goes.",
  },
  {
    gap:
      "#2360's switch has not merged (decisions 5 and 6: comment-thread replies are the " +
      "answered-link, and the switch lands immediately before the flip, in the same release).",
    closedBy: "#2360's switch PR merged.",
  },
  {
    gap: "The Settings list of bound transports (Ruling C) is not built.",
    closedBy: "PR 3b.",
  },
  {
    gap:
      "The greeting classification is still keyed on the reply's session id, and a " +
      "`/api/channel-reply` reply can still be the greeting.",
    closedBy:
      "PR 3b (classify by bound transport; a channel reply is never the greeting), moved there " +
      "from the 'chat, rounds and the greeting' PR by the delivery-rounds PR's brief.",
  },
  {
    gap:
      "PR 3a's assumptions the 2026-11-17 smoke left unmeasured (Windows 11, Claude Code " +
      "2.1.325, one sample, run contained): whether `--settings` disables a plugin beside " +
      "`--mcp-config`; a project-scope `.mcp.json` `tandem` entry and the user's own Tandem " +
      "entry and skill being replaced; missing or invalid run files; a `--settings` re-read; " +
      "macOS, Linux and the bundled Node; whether a not-signed-in child's bridge binds before " +
      "its refusal.",
    closedBy: "A further smoke measuring them, or Bryan's acceptance of each.",
  },
  {
    gap:
      "Project settings `env` against the run config: measured for one key (`TANDEM_URL`) in " +
      "one file (`.claude/settings.json`), in a hand run, with Tandem's value reaching the " +
      "bridge; not measured for `settings.local.json`, the other keys the run config sets or " +
      "clears (`TANDEM_OWNER_HANDLE`, `TANDEM_OWNER_HANDLE_URL`, " +
      "`CLAUDE_PLUGIN_OPTION_SERVER_URL`, `NODE_OPTIONS`, `NODE_DEBUG`), the launcher's own " +
      "invocation, or hook timing under `-p` before the first bind.",
    closedBy:
      "The remaining cases measured with Tandem's value winning in each, or a guard that " +
      "refuses the run files on such a file; a measurement showing a project value wins does " +
      "not close it.",
  },
  {
    gap:
      "An auth failure that is not 'Not logged in' (an expired token, a revoked key) is " +
      "unmeasured: if it returns an ordinary `result`, such a child stays present though it " +
      "cannot answer.",
    closedBy:
      "A measured list of auth-failure results, and the not-signed-in pattern widened to it.",
  },
  {
    gap:
      "Resumes the smoke did not exercise: a stale or doomed resume (`shouldClearSession`), a " +
      "resume across a server restart, a resume after a crash.",
    closedBy: "A smoke run of each, or Bryan's acceptance.",
  },
  {
    gap:
      "Flag-on suites that drive ownership but read no delivery-round state run with the " +
      "delivery-round seam unwired, so their polls run master's one global round, which no " +
      "flag-on server runs: ownership-chat, ownership-posts and ownership-change-notices mock " +
      "delivery-state.js with a pass-through that makes resolveDeliveryRound throw on demand; " +
      "health-route injects its own getDeliveryState; and the same holds for every other " +
      "suite that polls the inbox without wiring the seam (every suite runs flag-on in the " +
      "ownership-on job). The set, over-approximated (a file that only names the tool is in " +
      "it) and possibly incomplete (a suite that polls through a helper without naming the " +
      "tool is missed): the test files that name tandem_checkInbox and name neither setDeliveryRoundSeam " +
      "nor registerTestCallerRecord, i.e. grep -rlE 'tandem_checkInbox' tests --include=*.test.ts " +
      "| xargs grep -LE 'setDeliveryRoundSeam|registerTestCallerRecord' (38 files when this row " +
      "was written). A change that makes their polls open or close a keyed round wrongly is " +
      "not seen there, although every tandem_checkInbox poll reaches the round (its " +
      "resolveDeliveryRound call in awareness.ts).",
    closedBy:
      "Wiring the suites of that set that poll the inbox, each with a live check, or a test " +
      "that drives their paths keyed.",
  },
  {
    gap:
      "#2439: on Windows the launcher folder's owner and access-list checks run once per server " +
      "process (verifiedWindowsDirs, src/server/launcher/run-files.ts), so an entry new files do " +
      "not inherit, added after the first check, is not seen again in that process. Bryan accepted " +
      "it on 2026-11-17 for the dark state (docs/security.md, Accepted (bounded)); the acceptance " +
      "is re-decided when OWNERSHIP_ENABLED flips.",
    closedBy: "Bryan's decision on #2439 at the flip, recorded in the register.",
  },
  {
    gap:
      "The restart question (3b-2b1b): while the mode is unknown (after a restart, before a " +
      "client says whether it was Solo), waiting counts no user comment or reply, and nothing " +
      "re-asks when the mode becomes known (the only release wake is emitModeReleaseWake, " +
      "src/server/mcp/routes/mode-release.ts). Such a comment counts only when something next " +
      "asks: a change of owner, or 3b-2b4's checks.",
    closedBy:
      "Bryan's answer (3b-2b1b's 'Needs Bryan') and, if it differs, the change with a test.",
  },
  {
    gap:
      "After a server restart the delivery registry is empty, so on a document Tandem's Claude " +
      "holds, and (3b-2b1b-claimable) on every open document nobody holds while no other " +
      "session is connected (after a restart every restored document is unowned), every pending " +
      "user comment reads as waiting, answered or not, as does a resolved " +
      "comment ever edited, and every user thread reply on any Claude-facing comment (replies " +
      "have no status gate). The handled-filter row covers a handover's re-owe, not this, and " +
      "that filter would not close it: a comment answered only in chat is never handled by it.",
    closedBy: "3b-2b4: a durable registry, or a handled rule covering chat answers.",
    acceptedFor:
      "Bryan picked 'Accept (Recommended)', picked from options, 2026-11-23 (the " +
      "written-since-boot rule bounds what can start Tandem's Claude); tracked as #2358.",
  },
  {
    gap:
      "The waiting decision's cost is unmeasured (3b-2b1b-chat): each tandemWorkWaiting ask runs " +
      "one waiting probe per document Tandem's Claude holds, settledChatIds over every chat row, " +
      "one structuredClone and one schema parse per user chat row, and one message read per owed " +
      "key, and, while no other session is connected, one claim read and one waiting probe per " +
      "open, unowned document. Since 3b-2b1c-a wires it as the supervisor's workWaiting, that " +
      "happens at every start-or-wake pass, and a " +
      "document whose waiting read keeps failing logs documentWaiting's unthrottled line at each. " +
      "And (3b-2b1c-b) the message forward's admit runs one tandemChatWaiting scan (every owed " +
      "key's message read and standing, one structuredClone per user chat row) per changed key " +
      "that passes its caller check and departure gate, at the release loop and at " +
      "dropChatOwners, none at setMessageOwner; a deleted record releasing N keys, handled ones " +
      "included, runs up to N such scans.",
    closedBy:
      "Measured by 3b-2b4c (ADR-054's 3b-2b4c amendment; tests/server/ownership-waiting-cost.test.ts): " +
      "about 87 ms per decision at 50 held documents of 200 annotations and 500 chat rows, " +
      "nothing waiting, almost all of it the per-document probe (about 1.7 ms each), and about " +
      "1 to 1.5 ms per chat scan, so a release of N keys can cost N such scans. Closed by a " +
      "cheaper decision (for example a cached or incremental waiting answer), with the " +
      "measurement re-run, or Bryan accepting that cost.",
    acceptedFor:
      "Bryan picked 'Accept (Recommended)' for the measured cost of about 87 ms per decision, " +
      "picked from options, 2026-11-23; tracked as #2358.",
  },
  {
    gap:
      "Acknowledged but unanswered chat is never started for (3b-2b1b-chat): a tandem_reply with " +
      "replyTo and inProgress ('I'm on it') stamps the user message read, so it leaves waiting; if " +
      "no final answer follows (the run dies or gives up), nothing starts or wakes Claude for it, " +
      "and after a server restart it is carried over and never re-owed. The user notices and " +
      "sends the message again.",
    closedBy:
      "A design for acknowledged-but-unanswered chat after 0.32 (#2484), then its change with a test.",
    acceptedFor:
      "Bryan picked 'Known limit for 0.32; design it after (Recommended)', picked from options, " +
      "2026-11-19; tracked as #2484.",
  },
  {
    gap:
      "Acknowledged but unanswered chat by the channel route is never started for (3b-2b1b-chat): " +
      "a POST /api/channel-reply with replyTo and inProgress ('I'm on it') from the session that " +
      "owns the message stamps it read, so it leaves waiting; if no final answer follows (the run " +
      "dies or gives up), nothing starts or wakes Claude for it, and after a server restart it is " +
      "carried over and never re-owed. The user notices and sends the message again. (The same " +
      "route's acknowledgement from a non-owner is PR 4's channel-reply row.)",
    closedBy:
      "A design for acknowledged-but-unanswered chat after 0.32 (#2484), then its change with a test.",
    acceptedFor:
      "Bryan picked 'Yes, both routes (Recommended)', picked from options, 2026-11-19, so 'Known " +
      "limit for 0.32; design it after (Recommended)' covers the channel route too; tracked as " +
      "#2484.",
  },
  {
    gap:
      "Read but unacknowledged chat is never started for (3b-2b1b-chat): a cursor acknowledgement, " +
      "or a cursor-less poll's commit at hand-out, stamps a user message read with no 'I'm on it'; " +
      "if Claude never answers, the message leaves waiting for good, and after a server restart it " +
      "is carried over and never re-owed. The pick on acknowledged chat does not cover this.",
    closedBy: "Bryan's answer, then its change with a test.",
    acceptedFor:
      "Bryan picked 'Fold into #2484 (Recommended)', picked from options, 2026-11-23; tracked " +
      "as #2484.",
  },
  {
    gap:
      "The decision's 'another session is connected' (3b-2b1b-claimable) counts Tandem's own " +
      "launched Claude, whose transports still sit on claude:<id> records, so while it runs and " +
      "for a while after it stops claimable work does not count (about two minutes if its " +
      "transport held a stream, up to about 37 minutes if it never did; which applies is " +
      "unmeasured); and it differs from the supervisor's otherAiAttached (#2196), which excludes " +
      "Tandem's own children by session id. So also (3b-2b1c): if a session holding a document " +
      "goes away while Tandem's Claude is running or has just stopped, Tandem's Claude is " +
      "neither woken nor started for that session's waiting work; it reaches the work at its " +
      "next look or start. And Tandem's own child can itself hold a document it opened and " +
      "lapse when it stops, which starts Tandem's Claude for its own leftovers; with new " +
      "blocker 2 (answered work reads as waiting after a handover) that can repeat after every " +
      "idle stop. And while the child sits on a claude:<id> record, a document or chat that " +
      "becomes Tandem's Claude's is refused to that child (reason 'default'), so a wake or start " +
      "for it hands it nothing, the work stays waiting, and each later forward or pass wakes or " +
      "starts it again. The same holds for chat (3b-2b1c-b): if the child's record held a " +
      "document when it was closed, it owns that document's chat per message, and its lapse " +
      "releases the message and, while no other session is connected (the departure gate), " +
      "starts Tandem's Claude for it.",
    closedBy:
      "3b-2b3's routing of Tandem's own transports to the tandem record, with a row where its " +
      "transport does not count, and one 'another session' rule named for the decision and the " +
      "start arm; and a test where a holder lapses beside a running, idle Tandem's Claude with " +
      "no other session and it is woken, and a test that a stopped child's own lapse starts " +
      "nothing.",
  },
  {
    gap:
      "Claude Desktop is left out of 'another session' by its self-reported client name " +
      "('claude-ai', transport-registry.ts), which is unverified. The rule is decided (Bryan " +
      "picked 'No, Desktop doesn't count (Recommended)', picked from options, 2026-11-19); only " +
      "the name is open.",
    closedBy:
      "A hand check recorded in the ADR: with Claude Desktop connected and no other session, a " +
      "comment on an unheld document makes tandemWorkWaiting true.",
  },
  {
    gap:
      "Answered work starts Tandem's Claude (3b-2b1c). A handover retires the document's " +
      "delivery entries and nothing yet tells answered from unanswered, so after any handover, " +
      "at the next forward, every pending user comment, every settled one " +
      "ever edited, and every user reply on a Claude-facing thread reads as waiting, and the " +
      "forward starts or wakes Tandem's Claude for work the user did not ask for again; " +
      "likewise after a restart once anything forwards. See the handled-filter and restart rows.",
    closedBy:
      "The handled filter (#2360), with a test where a lapse of a holder that answered " +
      "everything in its threads starts nothing; for what it cannot see (answers in chat or by " +
      "an edit, state lost at a restart), the restart row's closer or Bryan's answer.",
  },
  {
    gap:
      "A session still open whose live stream dropped and that stayed quiet past its grace has " +
      "lapsed and stays lapsed while registered, so it does not count as another session, and " +
      "another session's departure starts or wakes Tandem's Claude beside it (3b-2b1c; how often " +
      "Claude Code drops its GET stream is unmeasured).",
    closedBy:
      "A hand check of whether Claude Code holds or reopens its GET stream, recorded in the " +
      "ADR; if it does not, 3b-2b2's re-ask, with a test.",
  },
  {
    gap:
      "A lapsed holder whose deferred move has not run leaves a closed document's chat with no " +
      "owner (`assignClosedDocumentChat`: `to` is undefined, the chat is re-owed). Once the " +
      "document is closed and Tandem's Claude is present the message is its by standing, with " +
      "no `messageOwnerChanged`, so nothing forwards for it.",
    closedBy:
      "3b-2b2's standby arm, or a test showing the next poll or start covers it and an Accepted " +
      "line.",
  },
];

/**
 * What stops the flip, as messages; empty when nothing does (no row, or only
 * accepted rows). **A pure function of the release literal and the list**:
 * off passes whatever the list holds, on passes only when every row carries
 * `acceptedFor` (a blank one does not count).
 */
export function flipBlockerViolations(
  literal: boolean,
  blockers: readonly FlipBlocker[],
): string[] {
  if (!literal) return [];
  return blockers
    .filter((b) => !b.acceptedFor?.trim())
    .map((b) => `OWNERSHIP_ENABLED is true while this is open: ${b.gap}`);
}
