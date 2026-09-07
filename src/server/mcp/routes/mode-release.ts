import type { Request, Response } from "express";
import * as Y from "yjs";
import { API_MODE_RELEASE } from "../../../shared/api-paths.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { withModeRelease } from "../../../shared/origins.js";
import { nextRev } from "../../annotations/schema.js";
import { getOpenDocs } from "../../documents/registry.js";
import { emitModeReleaseWake } from "../../events/queue.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { readModeState } from "../../mode.js";
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
 *  1. VERIFY the client's CRDT mode write has landed — `readModeState()` must
 *     read "tandem"; otherwise answer 409 MODE_NOT_TANDEM and release nothing.
 *     The route does NOT write the mode key (#1769). It used to, unconditionally,
 *     which meant a Solo→Tandem→Solo toggle inside this POST's latency left the
 *     room reading "tandem" while the toggle showed Solo — with every held marker
 *     swept. With the write gone, the room always holds the user's last CRDT
 *     write, so the server mode can never disagree with the last user toggle.
 *     "indeterminate" (the key absent) refuses too — fail closed, exactly as
 *     `pushEvent`'s gate reads it.
 *
 *     A 409 is DEFINITIVE when the room genuinely reads Solo (the user toggled
 *     back, or another window owns the room) and TRANSIENT when this POST simply
 *     outran the client's own CRDT write. The client covers the second with one
 *     250 ms retry; beyond that the held items stay held and marked, and the next
 *     Solo→Tandem toggle releases them. Pull is authoritative regardless.
 *  2. Clear the persisted `heldInSolo` markers across ALL open docs (badge +
 *     fail-closed-restart substrate), rev-bumped and durable.
 *  3. Wake the push monitor ONCE — but only if we actually released held
 *     content (`released > 0`). Idempotency is state-based on the work done: a
 *     repeat/flapping POST finds the markers already cleared, releases 0, and
 *     fires no duplicate wake.
 *
 * The verify and the wake are ONE synchronous frame — no `await` between them —
 * because `pushEvent` drops the wake whenever mode reads non-Tandem.
 *
 * No `mode` body parameter: a stale POST from an earlier toggle would carry
 * "tandem" too, so the room is the only witness worth reading.
 *
 * The held items themselves surface via the checkInbox / getAnnotations pull
 * path (they re-read live mode = Tandem now), NOT via this route. Gated on
 * origin-allowlist THEN loopback, mirroring handleRename (#1121).
 */
export function handleModeRelease(req: Request, res: Response): void {
  if (assertOriginAllowlisted(req, res, API_MODE_RELEASE)) return;
  if (assertLoopbackForMutation(req, res)) return;

  if (readModeState() !== "tandem") {
    res.status(409).json({
      error: "MODE_NOT_TANDEM",
      message: "The room does not read Tandem; nothing was released.",
      data: { released: 0 },
    });
    return;
  }

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
