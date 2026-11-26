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
 * Tandem's bridge"), so it is not a row. Likewise *the queue wait bound's
 * uncovered half* (1c's review, 2026-11-11): the stdio bridge now sends
 * `notifications/cancelled` wherever it answers a forwarded request itself
 * (ADR-054 as amended 2026-11-23, Bryan's pick "Build it"; it ships live), so
 * its row was deleted in that change. And #2360 PR B's three (2026-11-26):
 * *the handled filter for comment threads* and *answered work starts
 * Tandem's Claude*, closed by PR B's handled filter and its tests (the
 * second on Bryan's Q4 pick, "Accept for the flip (Recommended)", for what
 * the filter cannot see), and *a forged pre-flip chat `replyTo`*, closed by
 * its own `closedBy`: `docs/security.md`'s accepted (bounded) entry for
 * client-written answer marks (Bryan's Q7, "Accepted, bounded
 * (Recommended)").
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
      "The shipped skill (skills/tandem/SKILL.md) says wake frames on /api/events carry an id, " +
      "a type and a timestamp. With ownership on, the stream also sends PR 4a's id-less " +
      "`event: ownership-changed` / `data: {}` nudge, which the skill does not mention, so a " +
      "session watching ?filter=wake as the skill describes is not told what it means.",
    closedBy:
      'A SKILL.md line saying an ownership-changed frame also means "call tandem_checkInbox", ' +
      "with its frontmatter version bumped, landed with or before the flip (it reaches users, so " +
      "not while dark).",
  },
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
      "#2360 PR A drops update data a browser tab left pending in a DOCUMENT room " +
      "(`makeDocumentPendingGuard`, `events/observers/reply-client-undo.ts`), so a struct aimed " +
      "at the server's next clock cannot land under a server origin past the replies-map undo. " +
      "It widens the CTRL row's unmeasured premise (a real tab never leaves anything pending) to " +
      "document rooms, where a wrong premise drops the user's typing silently, not a chat row.",
    closedBy:
      "The CTRL row's measurement, run in document rooms too (reconnect, offline edits, two " +
      "tabs, a long paste), showing no pending data after a tab's update; or a guard narrowed " +
      "to updates that touch the replies map.",
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
      "route's acknowledgement from a non-owner was the channel-reply row, closed by PR 4b's permit.)",
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
      "A session still open whose live stream dropped and that stayed quiet past its grace has " +
      "lapsed and stays lapsed while registered, so it does not count as another session, and " +
      "another session's departure starts or wakes Tandem's Claude beside it (3b-2b1c; how often " +
      "Claude Code drops its GET stream is unmeasured).",
    closedBy:
      "A hand check of whether Claude Code holds or reopens its GET stream, recorded in the " +
      "ADR; if it does not, 3b-2b2's re-ask, with a test.",
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
