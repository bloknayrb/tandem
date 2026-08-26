/**
 * The composition root for the Hocuspocus lifecycle (ADR-033).
 *
 * This is the one place that knows how the registry, the event queue, the
 * dirty-state mirror and the generation gate fit together, and the only place
 * that installs them. `index.ts` calls `installTandemLifecycle()` once, before
 * either `startHocuspocus` call.
 *
 * It exists as its own module rather than inline in `index.ts` for one reason:
 * `index.ts`'s `main()` cannot be imported by a test without stubbing ~20
 * transitive imports, so anything assembled there can only ever be checked by
 * asserting on source text. Assembled here, the wiring is directly callable.
 *
 * **Import direction is load-bearing.** This module imports the registry, the
 * queue and the document-service; none of them may import it back, and
 * `yjs/provider.ts` must never import it at all. The whole point of the
 * injected seam is that the provider stays a leaf with respect to document
 * state — a "default lifecycle" fallback inside the provider would be the
 * cycle this design exists to avoid, just spelled differently.
 */

import { CTRL_ROOM } from "../../shared/constants.js";
import { isUploadPath } from "../../shared/paths.js";
import { setDirtyMirrorEligibility } from "../documents/dirty.js";
import { getOpenDocs, isDirtyMirrorEligible } from "../documents/registry.js";
import { detachObservers, reattachCtrlObservers, reattachObservers } from "../events/queue.js";
import { getGenerationId } from "../mcp/document-service.js";
import type { HocuspocusLifecycle } from "../yjs/lifecycle.js";
import { installHocuspocusLifecycle } from "../yjs/provider.js";

/**
 * Build the production lifecycle. Exported separately from the install so a
 * test can exercise the wiring without mutating provider module state.
 */
export function createHocuspocusLifecycle(): HocuspocusLifecycle {
  return {
    shouldKeepDocument(name) {
      // CTRL_ROOM is never an OpenDoc — ADR-033 rejected modelling it as one —
      // so its retention rides on this clause alone. Dropping it evicts the
      // bootstrap room's persistent chat history the moment the last tab closes.
      return getOpenDocs().has(name) || name === CTRL_ROOM;
    },

    onDocSwapped(docName, newDoc) {
      if (docName === CTRL_ROOM) {
        reattachCtrlObservers();
        return;
      }
      const openDoc = getOpenDocs().get(docName);
      const uploadDoc = openDoc ? isUploadPath(openDoc.filePath) : false;
      reattachObservers(docName, newDoc, { uploadDoc });
    },

    onDocUnloaded(docName) {
      // Queue observers only. Deliberately NOT the mirror of onDocSwapped: see
      // the interface doc — clearing the file-sync context here would strand a
      // tombstone ledger, and is pinned against by
      // `tests/server/adr-033-lifecycle-characterization.test.ts`.
      detachObservers(docName);
    },

    // A method, so the read stays live. See the interface doc for what a
    // captured field would cost.
    expectedGenerationToken: () => getGenerationId(),
  };
}

/**
 * Install the lifecycle and the registry-owned predicates that used to run as
 * module-import side effects.
 *
 * `setDirtyMirrorEligibility` is registered here rather than being a method on
 * `HocuspocusLifecycle`: it belongs to `documents/dirty.ts`, a module
 * `yjs/provider.ts` never touches, so folding it into the provider's interface
 * would misplace it. What it shares with the lifecycle is only that it was an
 * import-time side effect, and this call site is what retires the second
 * registration mechanism the ADR-033 rollback note forbids coexisting.
 */
export function installTandemLifecycle(): void {
  setDirtyMirrorEligibility(isDirtyMirrorEligible);
  installHocuspocusLifecycle(createHocuspocusLifecycle());
}
