import type { Request, Response } from "express";
import * as Y from "yjs";
import { API_MODE_RELEASE } from "../../../shared/api-paths.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../shared/constants.js";
import { withModeRelease } from "../../../shared/origins.js";
import { nextRev } from "../../annotations/schema.js";
import { getOpenDocs } from "../../documents/registry.js";
import { emitModeReleaseWake } from "../../events/queue.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { getOrCreateDocument } from "../../yjs/provider.js";

/**
 * Strip the persisted `heldInSolo` marker from every annotation and reply in one
 * doc that carries it, rev-bumped so the durable-sync last-writer-wins counter
 * advances. Entries are snapshotted BEFORE the write so the `forEach` isn't
 * iterating a map we mutate mid-loop. Runs inside a single `withModeRelease`
 * transaction: channel-skip (no spurious `annotation:edited` events — the items
 * are released via the checkInbox pull path, not a re-emit) and durable-persist
 * (the cleared marker must reach disk or a restart re-holds it). Returns the
 * count cleared.
 */
function clearHeldMarkersForDoc(doc: Y.Doc): number {
  const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
  const replyMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);

  const hits: Array<[Y.Map<unknown>, string, Record<string, unknown>]> = [];
  const collect = (map: Y.Map<unknown>) => {
    map.forEach((value, key) => {
      const rec = value as Record<string, unknown> | undefined;
      if (rec && rec.heldInSolo === true) hits.push([map, key, rec]);
    });
  };
  collect(annMap);
  collect(replyMap);
  if (hits.length === 0) return 0;

  withModeRelease(doc, () => {
    for (const [map, key, rec] of hits) {
      const { heldInSolo: _dropped, ...rest } = rec;
      // Bump from the record's own rev so the durable-sync LWW counter advances.
      map.set(key, { ...rest, rev: nextRev(rec as { rev?: number }) });
    }
  });
  return hits.length;
}

/**
 * POST /api/mode/release — the WS-A2 Solo→Tandem release.
 *
 * Three steps, ordered so nothing is stranded:
 *  1. Flip mode to Tandem SERVER-side (route-owned) so every hide predicate
 *     reads Tandem before the wake fires — closes the wake/mode-sync stall where
 *     the client's CRDT mode write hasn't reached the server's CTRL_ROOM doc yet.
 *  2. Clear the persisted `heldInSolo` markers across ALL open docs (badge +
 *     fail-closed-restart substrate), rev-bumped and durable.
 *  3. Wake the push monitor ONCE — but only if we actually released held
 *     content (`released > 0`). Idempotency is state-based on the work done,
 *     NOT on a prior-mode read: the client broadcasts mode = Tandem into
 *     CTRL_ROOM over its CRDT socket, and that write reliably reaches the
 *     server's ctrl doc BEFORE this HTTP round-trip, so a `readModeState()`
 *     here almost always already sees "tandem" and would wrongly suppress
 *     every wake (verified live). Gating on the marker-clear count instead
 *     fires the wake exactly when there was genuinely held content to announce
 *     and stays idempotent — a repeat/flapping POST finds the markers already
 *     cleared, releases 0, and fires no duplicate wake.
 *
 * The held items themselves surface via the checkInbox / getAnnotations pull
 * path (they re-read live mode = Tandem now), NOT via this route. Gated on
 * origin-allowlist THEN loopback, mirroring handleRename (#1121).
 */
export function handleModeRelease(req: Request, res: Response): void {
  if (assertOriginAllowlisted(req, res, API_MODE_RELEASE)) return;
  if (assertLoopbackForMutation(req, res)) return;

  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  withModeRelease(ctrlDoc, () => ctrlDoc.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "tandem"));

  // Sweep only OPEN docs. A doc closed while it still holds markers is not
  // visited, so its `heldInSolo` markers persist — harmless because mode is now
  // tandem (hideFromAI ignores the marker) so the items surface normally on
  // reopen; the only residue is a stale "Held" pill until the next
  // release-while-that-doc-is-open. Per-doc try/catch isolates a bad doc: it
  // must not abort the loop (starving later docs of their clear), suppress the
  // wake, or 500 the response — mode is already tandem, so the pull path
  // delivers everything regardless of marker state.
  let released = 0;
  for (const docId of getOpenDocs().keys()) {
    try {
      released += clearHeldMarkersForDoc(getOrCreateDocument(docId));
    } catch (err) {
      console.warn(`[mode-release] failed to clear held markers for ${docId}:`, err);
    }
  }

  if (released > 0) emitModeReleaseWake();

  res.json({ data: { released } });
}
