/**
 * POST /api/store/reclaim-lock (#1077) — self-healing for a stale `store.lock`.
 *
 * When a Tandem process dies without a clean shutdown, the lockfile survives;
 * if the OS then recycles its PID onto an unrelated process, startup's
 * liveness-only check wrongly concludes another instance is running and the
 * server stays read-only forever. The store-readonly banner's Reclaim button
 * calls this route to re-run the staleness check with a process-identity
 * probe (see `reclaimStoreLock`).
 *
 * On success the handler re-persists the live annotation state of every wired
 * document (writes queued while read-only were dropped, so on-disk envelopes
 * are behind the Y.Maps) and broadcasts the cleared read-only flag so all
 * connected clients drop the banner. On failure it returns 409 with a
 * user-facing message the banner surfaces inline.
 */

import type { Request, Response } from "express";

import { API_STORE_RECLAIM_LOCK } from "../../../shared/api-paths.js";
import { isStoreReadOnly, reclaimStoreLock } from "../../annotations/store.js";
import { persistSnapshot } from "../../annotations/sync.js";
import { getAllFileSyncContexts } from "../../events/file-sync-registry.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { broadcastStoreReadOnly } from "../document-service.js";
import { sendApiError } from "./_shared.js";

export async function handleStoreReclaimLock(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_STORE_RECLAIM_LOCK)) return;
  if (assertLoopbackForMutation(req, res)) return;

  try {
    const result = await reclaimStoreLock();
    if (!result.ok) {
      res.status(409).json({ error: "LOCK_HELD", message: result.message });
      return;
    }

    if (result.reclaimed) {
      // Re-initialize durable state: every write queued while read-only was
      // dropped, so force one snapshot per wired doc to bring the on-disk
      // envelopes up to the live Y.Map state. Per-doc failures are isolated —
      // they feed the store's own failure/notification machinery via
      // recordFailure and must not fail the reclaim.
      for (const ctx of getAllFileSyncContexts()) {
        try {
          await persistSnapshot(ctx.store, ctx.ydoc, ctx.docHash, ctx.meta.filePath);
        } catch (err) {
          console.error(
            `[Tandem] reclaim-lock: failed to re-persist annotations for ${ctx.meta.filePath}:`,
            err,
          );
        }
      }
      console.error("[Tandem] Annotation store lock reclaimed; writes re-enabled.");
    }

    // Source of truth, not a literal `false` — defends against future paths
    // where reclaim returns ok without flipping the flag.
    broadcastStoreReadOnly(isStoreReadOnly());
    res.json({ data: { reclaimed: result.reclaimed } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
