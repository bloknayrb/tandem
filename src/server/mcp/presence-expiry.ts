/**
 * Expiry sweep for Claude's presence (`ClaudeAwareness.status` / `active`).
 *
 * ## Why this exists
 *
 * `POST /api/channel-awareness` used to write `ClaudeAwareness` on every SSE event
 * the channel shim received, including a 3s auto-clear to `{status:"idle",
 * active:false}`. That write was dishonest — the shim fires it on event RECEIPT,
 * not on Claude doing anything, so an inert shim (one whose host never negotiated
 * the channel) kept stamping presence for a process with no model attached. It is
 * deleted.
 *
 * But it was also, incidentally, the only writer that ever set `active: false`.
 * The two remaining writers cannot clear:
 *
 *   - `document.ts` (`tandem_status` write mode) hardcodes `active: true`
 *   - `typing-presence.ts` (`withWorking`) spreads `prev` and touches only `working`
 *
 * So without a sweep, one `tandem_status({text})` — which `skills/tandem/SKILL.md`
 * instructs Claude to call per section — latches the status pill and the chat
 * panel's "Your AI is thinking…" for the life of the document's Y.Doc, including
 * after the MCP session ends. Fixing one lie by leaving a stickier one is not a fix.
 *
 * ## Why the freshness clock lives here and not in the CRDT
 *
 * The obvious design keys expiry off `ClaudeAwareness.timestamp`. That is wrong in
 * two ways. First, only `tandem_status` stamps it — `setPresenceOn` spreads `prev`
 * without bumping it — so a long run of tool calls between status updates reads as
 * stale while Claude is at its busiest, darkening the pill mid-edit. Second, a
 * predicate over a CRDT field that the clear does not change stays true forever:
 * `Y.Map.set` does not diff on value, so the sweep would rewrite and re-sync every
 * tick for the life of the process, and (since `session/manager.ts` encodes the
 * whole doc) inflate the session file on every autosave.
 *
 * Keeping the clock in module state fixes both: any MCP activity refreshes it, and
 * the CRDT write happens only when there is something to clear.
 *
 * ## What this must never do
 *
 * - **Touch `working`.** `typing-presence.ts` owns that field with its own 30s
 *   token-guarded sweep, and `working.annotationId` passes an ADR-027 filter on the
 *   way in (`sanitizeAnnotationIdForPresence`). Writing back a value captured
 *   outside the transaction could resurrect an id that `clearPresenceOn` removed —
 *   and if the user demoted that comment to a note meanwhile, that republishes a
 *   private note's existence. Read `prev` INSIDE the transaction, spread it, and
 *   mutate only the fields below.
 * - **Materialize documents.** `getOrCreateDocument` inserts on miss and eviction
 *   needs a WebSocket disconnect, so a sweep over stale names would accumulate
 *   phantom Y.Docs that nothing reclaims — and a later reopen would hand the
 *   phantom back with its stale awareness live. Resolve with `getDocument`.
 */

import { Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import type { ClaudeAwareness } from "../../shared/types.js";
import { getOpenDocs } from "../documents/registry.js";
import { getDocument } from "../yjs/provider.js";

/**
 * How long after Claude's last MCP activity its presence stops being claimed.
 *
 * 300s is a deliberate over-estimate pending measurement. The cost is asymmetric:
 * lingering presence is a cosmetic staleness the user can ignore, while a premature
 * "idle" is the same class of lie this module exists to remove. Do not tune it down
 * on intuition — `working` covers only the five tools wrapped by
 * `withTypingPresence`, and expires at 30s regardless, so it is not the safety net
 * it looks like.
 */
export const PRESENCE_TTL_MS = 300_000;

/** Sweep cadence. Only runs while at least one document has claimed presence. */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * Last MCP activity per document name. The freshness clock — see the module
 * docblock for why this is not `ClaudeAwareness.timestamp`.
 *
 * Doubles as the arming registry: entries are added when Claude acts and dropped
 * when the document no longer resolves, so the sweep drains and self-disarms.
 */
const lastActivityByDoc = new Map<string, number>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Record that Claude did something on this document. Called from the
 * `tandem_status` write path and from `withTypingPresence`, so ANY tool activity
 * refreshes presence — not just an explicit status update.
 */
export function noteClaudeActivity(docName: string): void {
  lastActivityByDoc.set(docName, Date.now());
  ensureSweep();
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepExpiredPresence();
    if (lastActivityByDoc.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the event loop open for a presence sweep.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

/**
 * Does this record still claim presence? The `active || status` clause is what
 * makes the clear idempotent — without it the entry keeps matching after being
 * cleared, so the sweep rewrites forever and can never disarm.
 */
function claimsPresence(prev: ClaudeAwareness | undefined): boolean {
  if (!prev) return false;
  if (prev.working != null) return false; // a live tool call is positive liveness
  return prev.active === true || (prev.status ?? "") !== "";
}

/**
 * Clear the presence fields on one document, preserving everything else.
 *
 * Deliberately does NOT re-stamp `timestamp`: a clear is the absence of activity,
 * and stamping it would read as fresh Claude activity to every later reader.
 */
function clearPresenceFields(docName: string): boolean {
  const doc = getDocument(docName);
  if (!doc) return false;
  const awarenessMap = doc.getMap(Y_MAP_AWARENESS);

  // Re-read and re-check INSIDE the transaction — a `tandem_status` or
  // `setPresenceOn` can land between the collect pass and here.
  let wrote = false;
  withInternal(doc, () => {
    const prev = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
    if (!claimsPresence(prev) || !prev) return;
    awarenessMap.set(Y_MAP_CLAUDE, {
      ...prev,
      status: "",
      active: false,
      focusParagraph: null,
      focusOffset: null,
    });
    wrote = true;
  });
  return wrote;
}

/**
 * One sweep pass. Exported for tests — production arms it via `noteClaudeActivity`.
 *
 * Covers two staleness cases:
 *  1. Claude acted on this document and has been quiet past the TTL.
 *  2. The document claims presence with NO activity entry at all. That means a
 *     previous process wrote it: `session/manager.ts` encodes the entire Y.Doc,
 *     awareness included, and `restoreYDoc` applies it back — so `active: true`
 *     survives a server restart into a process where Claude never ran. This is the
 *     worst instance of the bug (it outlives the MCP session by an unbounded
 *     margin) and an activity-armed sweep alone would never reach it.
 */
export function sweepExpiredPresence(now: number = Date.now()): number {
  const stale: string[] = [];

  for (const [docName, lastActivity] of lastActivityByDoc) {
    if (!getDocument(docName)) {
      lastActivityByDoc.delete(docName); // doc gone — drain the registry
      continue;
    }
    if (now - lastActivity > PRESENCE_TTL_MS) stale.push(docName);
  }

  // Case 2: presence with no activity entry — restored from a previous process.
  for (const docName of getOpenDocs().keys()) {
    if (lastActivityByDoc.has(docName)) continue;
    const doc = getDocument(docName);
    if (!doc) continue;
    const prev = doc.getMap(Y_MAP_AWARENESS).get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
    if (claimsPresence(prev)) stale.push(docName);
  }

  if (stale.length === 0) return 0;

  let cleared = 0;
  for (const docName of stale) {
    if (clearPresenceFields(docName)) cleared++;
    // Drop the activity entry either way: it has expired, and keeping it would
    // re-select the same doc every tick once its presence is already cleared.
    lastActivityByDoc.delete(docName);
  }
  return cleared;
}

/**
 * Clear presence across every open document, now.
 *
 * Called when the last MCP session closes — session end is positive knowledge that
 * Claude is gone, so there is nothing to wait a TTL for.
 */
export function clearAllClaudePresence(): number {
  let cleared = 0;
  for (const docName of getOpenDocs().keys()) {
    if (clearPresenceFields(docName)) cleared++;
  }
  lastActivityByDoc.clear();
  return cleared;
}

/** Test-only. Stops the timer and drops all recorded activity. */
export function resetPresenceExpiryForTests(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  lastActivityByDoc.clear();
}

/** Test-only introspection — is the sweep currently armed? */
export function isPresenceSweepArmed(): boolean {
  return sweepTimer !== null;
}
