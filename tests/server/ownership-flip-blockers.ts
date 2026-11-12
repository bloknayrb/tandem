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
      "Handover gap (a): every poll still reads every document and acknowledgement is not scoped, " +
      "so after a handover a poll by the previous owner, or any cursor-less poll, is handed the " +
      "re-owed items and its acknowledgement hides them from a fresh cursor again.",
    closedBy:
      "The scope PR (inbox scope and scoped acknowledgement, design §6.2), which must flip the test " +
      "'FLIP-BLOCKER gap (a): the previous owner's poll is handed the item, and its acknowledgement " +
      "hides it from a fresh cursor' in tests/server/ownership-handover.test.ts.",
  },
  {
    gap:
      "Handover gap (b): a session can be handed, and acknowledge, items on an unowned document " +
      "that another session then claims with no handover, so design §6.3's 'nobody else could have " +
      "been handed an unowned document's items' is not yet true.",
    closedBy:
      "The scope PR (a poll reads an unowned document only if it may claim it, and claims it).",
  },
  {
    gap:
      "The notice rule: an accept or dismiss notice already handed to an earlier owner goes to " +
      "nobody after a handover (design §6.3 step 2's use of handoverSeq, §6.4's last bullet). " +
      "handoverSeq is written but has no reader.",
    closedBy:
      "The scope PR. It moved there because, until acknowledgement is scoped, 'acknowledged' does " +
      "not mean 'the owner had it'.",
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
    closedBy: "The scope PR (per-document delivery rounds, design §6.7).",
  },
  {
    gap:
      "tandem_checkInbox's description. Its sentence 'once a poll of yours has read a document, " +
      "another session's polls never hide its items from you' stops being true once the scope PR " +
      "lands, and its sentence 'each item repeats on every poll until you pass a cursor from a " +
      "response that held it' is already not the whole truth flag-on: after a handover an " +
      "acknowledged item is handed again, unmarked.",
    closedBy: "A description change before the flip (the scope PR, or the flip PR itself).",
  },
  {
    gap:
      "The lone-session re-hand. With one session attached, a close and reopen of a tab it holds, " +
      "a lapse (a laptop asleep past the grace, a Claude Code restart, the detached-record cap) or " +
      "any other handover hands it again every pending user comment on that document, answered or " +
      "not, every resolved comment that was ever edited, and every user reply on a Claude-facing " +
      "thread; and a comment edited since it was seen arrives without `edited: true`. On master a " +
      "close and reopen re-hands nothing.",
    closedBy: "Bryan's answer to it (PR of the handover, 'Needs Bryan').",
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
