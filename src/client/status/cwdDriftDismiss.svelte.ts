/**
 * Suppression state for the working-directory drift nudge (#1282).
 *
 * Three layers, because one is not enough and the reason is arithmetic. The
 * launcher's default working directory is `os.homedir()`, and the drift check
 * requires the candidate folder to be *inside* home — so out of the box, for a
 * user who has never set a working directory, EVERY document in every subfolder
 * drifts. Without suppression this would not be an occasional nudge about an
 * occasional mistake; it would be a permanent amber pill.
 *
 *   1. **Per-pair dismissal** — "not now" for this exact (Claude's folder,
 *      target folder) combination, for this session.
 *   2. **Session backstop** — after `SESSION_DISMISS_LIMIT` dismissals the nudge
 *      stops for the whole session. Aimed at the user who deliberately parks
 *      Claude in one place and edits everywhere: per-pair dismissal alone hands
 *      them a fresh pill for every folder they visit, forever.
 *   3. **Persistent opt-out** — "don't ask again", across restarts.
 *
 * Keyed on the PAIR, never the target alone. Dismiss "move to ~/notes" while
 * Claude sits in home; later move Claude to a project; reopen a note. Keyed on
 * the target, that is still suppressed — even though the situation is now
 * strictly worse, because Claude is in a folder with a `CLAUDE.md` that has
 * nothing to do with the note.
 *
 * Module scope, not component `$state`, because no single component owns it: the
 * readers and writers live in `App.svelte` (the `visibleCwdDrift` derivation and
 * all three menu handlers), while `StatusBar` only receives the already-filtered
 * result as a prop. `StatusBar` is mounted unconditionally today, so this is not
 * guarding a live remount — it is keeping "for this session" true of a decision
 * that spans two files.
 */

/** localStorage key for the permanent opt-out. */
const OPT_OUT_KEY = "tandem:cwd-drift-opt-out";
/** localStorage key for "the one-time explainer has been shown". */
const SEEN_KEY = "tandem:cwd-drift-seen";

/** How many "not now" clicks before the nudge gives up for the session. */
export const SESSION_DISMISS_LIMIT = 3;

/**
 * Reassigned to a fresh Set on every dismissal, never mutated in place.
 * `$state(new Set())` is NOT deep-proxied in Svelte 5 — only plain objects and
 * arrays are — so `.add()` is invisible to reactivity. Mutating would make the
 * dismiss button look dead and then take effect retroactively at some unrelated
 * re-render. Same contract as `MarginColumn`'s `pinnedIds`.
 */
let dismissedPairs = $state<Set<string>>(new Set());
let dismissCount = $state(0);
let optedOut = $state(loadOptOut());
/** Has the "I'll stop asking" notice been shown this session? */
let backstopAnnounced = false;

function loadOptOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    // Incognito / storage-disabled browsers throw on access. An unreadable
    // preference is not an opt-out — fall back to showing the nudge, which the
    // session-scoped layers still bound.
    return false;
  }
}

/**
 * Stable key for a (Claude's folder, target folder) pair.
 *
 * Length-prefixed rather than delimiter-joined. Any separator character can in
 * principle occur in a path, and joining on one makes two different pairs
 * identical whenever a folder name contains it: joined on "|", both
 * ("a|b", "c") and ("a", "b|c") become "a|b|c", so dismissing either silently
 * suppresses the other. A length prefix reserves no character and has no such
 * case.
 */
function pairKey(claudeCwd: string, suggestedCwd: string): string {
  return `${claudeCwd.length}:${claudeCwd}${suggestedCwd}`;
}

/** Should the nudge for this pair be hidden? */
export function driftDismissed(claudeCwd: string, suggestedCwd: string): boolean {
  if (optedOut) return true;
  if (dismissCount >= SESSION_DISMISS_LIMIT) return true;
  return dismissedPairs.has(pairKey(claudeCwd, suggestedCwd));
}

/**
 * Dismiss this pair for the session.
 *
 * Returns `true` when this dismissal is the one that trips the session backstop
 * and the caller should say so — once. Silently going quiet after the third
 * dismissal would leave the user with no way to tell "Claude is in the right
 * folder now" from "Tandem stopped mentioning it", which are opposite facts.
 */
export function dismissDrift(claudeCwd: string, suggestedCwd: string): boolean {
  const next = new Set(dismissedPairs);
  next.add(pairKey(claudeCwd, suggestedCwd));
  dismissedPairs = next;
  dismissCount += 1;
  if (dismissCount >= SESSION_DISMISS_LIMIT && !backstopAnnounced) {
    backstopAnnounced = true;
    return true;
  }
  return false;
}

/** Permanent opt-out ("don't ask again"). A failed write is not silent: the
 * caller is told, so it can degrade to the session-scoped promise it CAN keep
 * rather than claiming a durable one it cannot. */
export function optOutOfDriftNudge(): boolean {
  optedOut = true;
  try {
    localStorage.setItem(OPT_OUT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Whether the user has permanently opted out. Read by the palette command that
 * turns the reminders back on — "don't show this again" must not be a one-way
 * door whose only exit is editing localStorage by hand. */
export function driftNudgeOptedOut(): boolean {
  return optedOut;
}

/** Undo the permanent opt-out. Returns false when the preference could not be
 * cleared from storage, so the caller can avoid promising it will stick. */
export function clearDriftNudgeOptOut(): boolean {
  optedOut = false;
  try {
    localStorage.removeItem(OPT_OUT_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim the one-time explainer. Returns `true` exactly once per install — the
 * first time a drift is actually SHOWN, not the first time one is computed, so
 * a user whose very first drift is suppressed still gets the explanation
 * whenever one first reaches them.
 *
 * A plain `let` guard, deliberately not `$state`: the caller reads this from
 * inside an `$effect` that also writes a notification, and a reactive flag
 * would re-enter that effect.
 *
 * **When it cannot record the claim, it does not make it.** Returning true on an
 * unwritable store would look like "degrade to once per session", but the
 * degradation compounds: the same store cannot persist the opt-out either, so
 * a storage-disabled browser replays this four-sentence notice on EVERY launch,
 * forever, including to someone who has explicitly clicked "don't show this
 * again". The pill and its menu still carry the whole explanation, so declining
 * to explain costs one notice; the alternative costs one per launch for good.
 */
let explainerShownThisSession = false;
export function noteDriftSeen(): boolean {
  if (explainerShownThisSession) return false;
  explainerShownThisSession = true;
  try {
    if (localStorage.getItem(SEEN_KEY) === "1") return false;
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    return false;
  }
  return true;
}

/** Test-only reset of module state between cases. Clears storage FIRST, then
 * re-runs `loadOptOut()` exactly as a fresh page load would — so a test can seed
 * `OPT_OUT_KEY` and prove the opt-out actually survives a restart, which a plain
 * `optedOut = false` assignment silently skips. */
export function _resetDriftDismissForTests(opts: { keepStorage?: boolean } = {}): void {
  dismissedPairs = new Set();
  dismissCount = 0;
  backstopAnnounced = false;
  explainerShownThisSession = false;
  if (!opts.keepStorage) {
    try {
      localStorage.removeItem(OPT_OUT_KEY);
      localStorage.removeItem(SEEN_KEY);
    } catch {
      // no-op — the tests that care assert through the exported readers
    }
  }
  optedOut = loadOptOut();
}
