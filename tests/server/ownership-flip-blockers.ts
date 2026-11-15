/**
 * What the ownership flip must not land without (#2358, ADR-054).
 *
 * **The one list.** The PRs of the dark series leave gaps open on purpose,
 * each to be closed by a later PR or by a decision of Bryan's. They used to be
 * held in prose (the plan's flip row, ADR amendments) and in memory. Each is a
 * row here, and `tests/server/ownership-flag.test.ts` fails when the release
 * literal `OWNERSHIP_ENABLED` is `true` while this list is not empty. The
 * plan's flip row (`docs/plans/2358-ownership.md`, PR 6) points here.
 *
 * **To close a row:** land what `closedBy` names, then delete the row in that
 * same PR. A row is never closed by editing its text. The flip PR may set the
 * literal only once the list is empty.
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
}

export const OWNERSHIP_FLIP_BLOCKERS: readonly FlipBlocker[] = [
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
      "Handover gap (d): re-owed items open no delivery round, so /health can read idle while " +
      "items are owed.",
    closedBy:
      "The 'chat, rounds and the greeting' PR (per-document delivery rounds beside per-message " +
      "rounds, design §6.7; moved there by the notice-rule PR's brief, then by the chat owners " +
      "PR's brief, Ruling 1).",
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
      "to a message is stamped with the message's document).",
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
      "The delivery round is still one global round (pendingSince): a scoped poll closes it " +
      "although it did not read the documents other sessions hold, so /health can read idle " +
      "while another session's document has items no poll of its holder has returned.",
    closedBy:
      "The 'chat, rounds and the greeting' PR (per-document delivery rounds beside per-message " +
      "rounds, design §6.7; moved there by the notice-rule PR's brief, then by the chat owners " +
      "PR's brief, Ruling 1).",
  },
  {
    gap:
      "A lapse to unowned wakes no session (startOrWake and the frames are stubs), so under " +
      "inbox scope a user's next comment on that document waits until some session polls for " +
      "an unrelated reason.",
    closedBy: "PR 3b (presence, startOrWake and the ownership frames).",
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
      "Posts (tandem_reply without replyTo) are accepted from any caller and stamped with the " +
      "active document (the chat owners PR gates only a reply that names a message).",
    closedBy: "The posts PR (design §7.3 rule 2, the `post` refusal).",
  },
  {
    gap:
      "The batch rule is master's: one session's final reply can settle a message another " +
      "session owns and has received (the global received-sweep); if that owner then lapses, " +
      "the message is not re-owed (it reads as handled) and is lost. Master can do the same, " +
      "less often.",
    closedBy: "The posts PR (`settles` written by the server, the global sweep removed).",
  },
  {
    gap:
      "An acknowledged message is handled under master's predicate and owned by its " +
      "acknowledger (the chat owners PR, R5.8). A live acknowledger that never answers keeps " +
      "it (PR 5's control on the message). If the acknowledger's record is deleted before its " +
      "final reply (its transport went and its grace ran out, the detached cap lapsed it early, " +
      "it had already lapsed, or Tandem restarts), each outcome on ADR-054's accepted list " +
      "'An acknowledger's record deleted before its final reply' follows, including the " +
      "re-initialize case there (a session with no X-Claude-Session-Id gets a new record and is " +
      "refused naming its own old label; probe-contingent, PR 3b's real-launcher smoke).",
    closedBy:
      "The posts PR (acknowledgements count for nothing and are superseded at a re-owe), with " +
      "PR 3b's probe of which identity a real Claude Code HTTP session resolves to.",
  },
  {
    gap:
      "Answered-once is not enforced for chat: a record that now owns a message another record " +
      "already answered may answer it again (design R1.5).",
    closedBy: "The posts PR (answered-once for chat, the `answered` refusal).",
  },
  {
    gap:
      "A client can write server-only values (a Claude row with replyTo, and later `settles` " +
      "and `superseded`) and hide a message from every inbox.",
    closedBy: "The posts PR (stripping client-written server-only values).",
  },
  {
    gap:
      "A poll's claim through chat with outcome 'changed' (setDocOwner ran but the caller does " +
      "not hold the document after it: only a re-entrant lapse, which needs the detached cap " +
      "to lapse the claimant inside its own claim) is handled by code that excludes the " +
      "document's chat from the stamp and retires the entries the poll created, so the message " +
      "stays unread, undelivered and unregistered for its new owner; but no test reaches that " +
      "outcome on chat (the chat owners PR, R4.4; review round 1, item 20).",
    closedBy:
      "A test that drives a re-entrant lapse through the cap inside a chat claim, or a seam " +
      "that forces the outcome, showing the message reachable by its new owner.",
  },
  {
    gap:
      "/api/channel-reply appends Claude rows with replyTo, answers and acknowledgements " +
      "(inProgress) alike, with no ownership check, sets no owner, and calls markUserChatRead; " +
      "the handled predicate honours its rows, an acknowledgement included. So an unmapped shim " +
      "session can answer or acknowledge a message another session owns, and either one " +
      "handles it (Ruling 11).",
    closedBy: "PR 4 (the shim's permit, design §9.2).",
  },
  {
    gap:
      "When Tandem's Claude stops being present, every per-message owner it holds of a message " +
      "that is not handled must be dropped and the message re-owed, whatever the origin " +
      "(a tab close of a document nobody held while it was present gives it origin 'close'; " +
      "an acknowledgement, origin 'acknowledgement', whose message is handled, must be dropped " +
      "too). releaseMessageOwners in sessions/ownership.ts takes the selector. Its record never " +
      "lapses, so until then such a message is handed to nobody once presence ends, its own " +
      "reply is refused (not-present) and every other session is refused 'Tandem's Claude " +
      "answers this message' (the chat owners PR, R5.8; review round 1, item 3).",
    closedBy: "PR 3b (presence).",
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
      "one is re-owed at the owner's lapse; a handled one (acknowledged, for instance) is never " +
      "re-owed, and stays the owner's until its record is deleted.",
    closedBy: "PR 3b (waiting, startOrWake) for Tandem's Claude, or Bryan's answer for terminals.",
  },
  {
    gap:
      "A take-back and the inbox's exclusion texts: after Tandem's Claude takes a document back " +
      "('taken back'), the refusal tells the loser not to tandem_open it again unless the user asks " +
      "again after this point, but the inbox's exclusion texts and `notYours`'s description say " +
      "only 'only if the user asked you, in your own conversation', which the original request " +
      "still satisfies, and decideTake checks no loss, so the re-open takes it back from Tandem's " +
      "Claude. Unreachable until Tandem's Claude can be present (PR 3b).",
    closedBy:
      "PR 3b (take-back): carry the loss into the exclusion texts, or make decideTake honour it.",
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
      "The E2E `McpTestClient.callTool` does not throw on an error envelope (the plan's flip row, " +
      "gate (b)): a NOT_DOC_OWNER on a spec's setup write is returned, not thrown, so a flag-on " +
      "spec carries on.",
    closedBy: "A change to tests/e2e/helpers.ts that makes it throw.",
  },
  {
    gap:
      "`ownership-bundle-probe.mjs`'s `probeRefusal` is pinned by regex alone (the plan's flip " +
      "row, gate (c)).",
    closedBy: "A pin by behaviour.",
  },
  {
    gap:
      "Change-notice causes PR 3b owes (the change-notice PR, R7.2): 'taken back' (a lost entry " +
      "when Tandem's Claude takes a document back), every gained entry for Tandem's Claude (the " +
      "default rule after a lapse or a user open, a take-back, its own tandem_open while " +
      "present) and Tandem's Claude's lost entry when it stops being present. Each must follow " +
      "Ruling 10 (a past-tense fact with no instruction, the change-notice PR's R7.3 and R7.4). " +
      "Until then a session holding a document those paths move is told only through `holding`. " +
      "Note: `changeCauseOf` (sessions/ownership.ts) today maps every `take` loss to 'another " +
      "session took it'; a take by Tandem's Claude, which `lossCauseOf` calls 'taken back', must " +
      "get its own word then.",
    closedBy: "PR 3b: the causes, with tests through their production paths.",
  },
  {
    gap:
      "Change-notice cause the chat PR owes (R7.2): a gained entry by a chat post's claim, a " +
      "past-tense fact with no instruction (Ruling 10). Until then such a change is told only " +
      "through `holding`.",
    closedBy:
      "The posts PR (retargeted by the chat owners PR, R5.7, whose reply claim has its own " +
      "word): the cause, with a test through its production path.",
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
    gap:
      "Nothing reads PR 3a's bind fact: a transport bound to Tandem's Claude's current spawn " +
      "still sits on its claude:<id> record, not on the `tandem` record, and there are no " +
      "unbound-child records, no private records for its other own-child ids, and no retirement " +
      "or demotion at a spawn (Ruling A).",
    closedBy: "PR 3b (rule 0's routing to the `tandem` record, and the records around it).",
  },
  {
    gap:
      "The `unbound-child` refusal and the take guard against Tandem's Claude are not built, so a " +
      "child of Tandem's Claude that did not bind is answered as an ordinary session.",
    closedBy:
      "PR 3b, for documents and for messages; the per-message owner its message half reads " +
      "landed in the chat owners PR.",
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
      "The 'chat, rounds and the greeting' PR (classify by bound transport; a channel reply is " +
      "never the greeting).",
  },
  {
    gap:
      "PR 3a's assumptions are unmeasured (its PR body lists them): the supervisor's own signed-in " +
      "child honours --mcp-config and --settings as the headless probes did, --settings still " +
      "disables the plugin beside --mcp-config, an entry's env wins Claude Code's merge, a " +
      "--resume spawn reads its new run MCP config, a project-scope tandem entry is still " +
      "replaced, macOS and Linux, and the bridge binds before a not-signed-in child closes it.",
    closedBy: "The real-launcher smoke on Bryan's Windows PC before PR 3b (Ruling J).",
  },
  {
    gap:
      "Whether Claude Code lets a settings file's `env` block (a project or local settings file " +
      "in the child's working folder, possibly hostile) beat the launcher's `--mcp-config` " +
      "entry's `env` is unmeasured: if it does, such a file can point the bridge's URL variables " +
      "at another local listener, which then receives the handle (accepted as a residual for 3a, " +
      "Bryan 2026-11-13).",
    closedBy:
      "The real-launcher smoke measuring that merge order, before PR 3b gives the bound fact a " +
      "reader; then refuse the flags on such a file, or record the residual as accepted.",
  },
];

/**
 * What stops the flip, as messages; empty when nothing does. **A pure function
 * of the release literal and the list**: off passes whatever the list holds,
 * on passes only with an empty list.
 */
export function flipBlockerViolations(
  literal: boolean,
  blockers: readonly FlipBlocker[],
): string[] {
  if (!literal) return [];
  return blockers.map((b) => `OWNERSHIP_ENABLED is true while this is open: ${b.gap}`);
}
