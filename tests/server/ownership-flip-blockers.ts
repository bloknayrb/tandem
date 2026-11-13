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
      "The notice rule: an accept or dismiss notice already handed to an earlier owner goes to " +
      "nobody after a handover (design §6.3 step 2's use of handoverSeq, §6.4's last bullet). " +
      "handoverSeq is written but has no reader.",
    closedBy:
      "The change-notice PR (the second half of the scope work: change notices and `changed`, the " +
      "notice rule, per-document delivery rounds). It must also re-owe past what the scope PR " +
      "left: a close of an unowned document runs no handover, so an acknowledgement before the " +
      "close can hide its kept notices from a fresh reader after a reopen; a reader's mark set " +
      "by exclusion (its default polls read another holder's document as empty) passes a notice " +
      "that holder was handed and never acknowledged, so once a handover keeps the notice, that " +
      "reader acknowledges it and is never handed it, nor is a fresh reader; a poll's claim over " +
      "a stale entry runs a handover that writes handoverSeq above notices the same poll handed; " +
      "a claim refused at commit does not undo a cursor-less poll's acknowledgement of an " +
      "entry that predates it; and a mark moved by exclusion drops the reader's held seqs there, " +
      "so a Solo-held kept notice is passed with it.",
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
      "Handover gap (d): re-owed items open no delivery round, so /health can read idle while " +
      "items are owed.",
    closedBy: "The change-notice PR (per-document delivery rounds, design §6.7).",
  },
  {
    gap:
      "tandem_checkInbox's description and the shipped skill say things that are false flag-on " +
      "once the scope PR lands. The description: 'once a poll of yours has read a document, " +
      "another session's polls never hide its items from you' (with inbox scope, only the " +
      "document's holder reads it); 'each item repeats on every poll until you pass a cursor from " +
      "a response that held it' (after a handover an acknowledged item is handed again, " +
      "unmarked); 'Omit `documentId` to cover every open document'; and the summary's 'The cursor " +
      "was not recognised ... returns everything not yet acknowledged' (only what is in scope). " +
      "The `documentId` input: 'Omit it to poll every open document'. skills/tandem/SKILL.md: " +
      "'polls every open document', and its contract that a summary with no document read means " +
      "nothing is open (flag-on, it can mean nothing open is yours to answer). docs/mcp-tools.md's " +
      "tandem_checkInbox section says the same things; it carries a 'ships dark' paragraph listing " +
      "what changes flag-on, and the flip PR rewrites the section.",
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
      "On master a close and reopen re-hands nothing. (A restart that returns under the same owner " +
      "id inside the two-minute grace is no handover: its fresh cursor counts what its earlier " +
      "incarnation acknowledged as seen, as on master, so the outcome turns on the grace.) Since " +
      "the scope PR a detached record also claims a document again on a poll that yields it " +
      "something, so the write-then-idle cycle is also a poll-then-idle cycle.",
    closedBy: "Bryan's answer to it (PR of the handover, 'Needs Bryan').",
  },
  {
    gap:
      "`ownership.notYours` in tandem_checkInbox tells any local MCP client that a document it " +
      "named is not its to answer (design §11.3's holder exposure, accepted by Bryan 2026-11-05, " +
      "decision 4). It is not yet in docs/security.md's register.",
    closedBy: "PR 5's owners entry in docs/security.md (design §11.3).",
  },
  {
    gap:
      "The delivery round is still one global round (pendingSince): a scoped poll closes it " +
      "although it did not read the documents other sessions hold, so /health can read idle " +
      "while another session's document has items no poll of its holder has returned.",
    closedBy: "The change-notice PR (per-document delivery rounds, design §6.7).",
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
      "Chat stays unscoped until the chat PR: every session is handed every user chat message, " +
      "whatever document it is about (#2358's own symptom, for chat). Besides duplicate answers, " +
      "a session handed 'please fix the intro in d3' for a document another session holds may " +
      "tandem_open it, and the take rule lets an open by another session take a `claimed` " +
      "document or one Tandem's Claude holds as `default`; the inbox's " +
      "exclusion texts carry the refusals' guard (an item Tandem handed you is not a request), " +
      "which only lowers that risk.",
    closedBy: "The chat PR (design §7: per-message owners).",
  },
  {
    gap:
      "A document claimed by a poll whose items its holder then never answers: the holder keeps " +
      "it, and no other session is handed its items until a lapse, a close or a take moves it " +
      "(design §8.5's 'waiting' is what would start or wake the holder; until then nothing does).",
    closedBy: "PR 3b (waiting, startOrWake) for Tandem's Claude, or Bryan's answer for terminals.",
  },
  {
    gap:
      "A take-back and the inbox's exclusion texts: after Tandem's Claude takes a document back " +
      "('taken back'), the refusal tells the loser not to tandem_open it again unless the user asks " +
      "again after this point, but the inbox's exclusion texts and `notYours`'s description say " +
      "only 'only if the user asked you, in your own conversation', which the original request " +
      "still satisfies, and decideTake checks no loss, so the re-open takes it back from Tandem's " +
      "Claude. Unreachable until Tandem's Claude can be present (PR 3a/3b).",
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
      "#2360's switch has not merged (decisions 5 and 6: comment-thread replies are the " +
      "answered-link, and the switch lands immediately before the flip, in the same release).",
    closedBy: "#2360's switch PR merged.",
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
