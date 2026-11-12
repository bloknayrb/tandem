/**
 * Can this page change the local-model settings (#2404)? One shared answer
 * for the Models tab, the edit modal and the first-run picker.
 *
 * `blocked` is true when the page's own origin is one the server will never
 * accept (see `models/own-window.ts`), or once the server has refused a write
 * with `OWN_WINDOW_ONLY` — the latch, kept in `models/write-refusal.ts` (a
 * plain module, so the reconcile action can record it without importing
 * runes) and mirrored here. It is set by the three callers of the two routes
 * (`useModels`, `useLocalModelSettings`, the reconcile action), always from a
 * fetch continuation, never inside a reaction. It never clears: the page's
 * origin does not change, and the server reads its allowance once, at start.
 *
 * Imports neither models hook (the reconcile action promises no cycle), and
 * reads `window` lazily so a node-environment importer does not crash.
 * Consumers read the getters; never destructure them.
 */

import { isTauriRuntime } from "../cowork/cowork-helpers";
import { type ModelsWriteAccess, modelsWriteAccess, ownWindowNotice } from "../models/own-window";
import {
  _resetModelsWriteRefusalForTests,
  modelsWriteWasRefused,
  onModelsWriteRefused,
} from "../models/write-refusal";
import { MCP_BASE_URL } from "../utils/backend-ports";

// The reactive mirror of the plain flag in `models/write-refusal.ts`. The
// callers record a refusal there (from a fetch continuation, never inside a
// reaction); this cell is what the components read.
let _refused = $state(modelsWriteWasRefused());
onModelsWriteRefused(() => {
  _refused = true;
});
/** Test seam: stands in for `window.location.origin`. `undefined` = read it. */
let _originOverride: string | null | undefined;

function pageOrigin(): string | null {
  if (_originOverride !== undefined) return _originOverride;
  try {
    return typeof window === "undefined" ? null : window.location.origin;
  } catch {
    return null;
  }
}

/** What the page's own origin says, before any answer from the server. */
export function modelsPageAccess(): ModelsWriteAccess {
  return modelsWriteAccess(pageOrigin(), isTauriRuntime(), MCP_BASE_URL);
}

export interface ModelsWriteAccessState {
  /** These settings cannot be changed from this page. */
  readonly blocked: boolean;
  /** The page's own origin is one the server never answers readably or
   *  accepts (not merely a refused write): its reads cannot succeed either. */
  readonly foreign: boolean;
  /** The one sentence that says so, and what to do. */
  readonly notice: string;
}

export function createModelsWriteAccess(): ModelsWriteAccessState {
  return {
    get blocked() {
      return _refused || modelsPageAccess() === "foreign";
    },
    get foreign() {
      return modelsPageAccess() === "foreign";
    },
    get notice() {
      return ownWindowNotice(modelsPageAccess(), pageOrigin(), MCP_BASE_URL);
    },
  };
}

/** Test seam: pretend the page is served from `origin` (null = no window). */
export function _setPageOriginForTests(origin: string | null | undefined): void {
  _originOverride = origin;
}

/** Test seam: forget the latch and the origin override. */
export function _resetModelsWriteAccessForTests(): void {
  _resetModelsWriteRefusalForTests();
  _refused = false;
  _originOverride = undefined;
}
