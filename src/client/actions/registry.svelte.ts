/**
 * Central action registry for the command palette and keyboard shortcut catalog.
 *
 * Actions register their shape (id, label, group, shortcut, run) at module load
 * time. The registry is a $state Map so the palette and Shortcuts settings tab
 * react to registrations automatically.
 *
 * Collision policy: calling registerAction with an id that already exists is a
 * console.warn in production (debugging aid) and a thrown error in dev. To
 * replace an existing entry explicitly, pass { replace: true }.
 *
 * ADR-029 (docs/decisions.md) records the design rationale.
 */

import { reportError } from "../sentry.js";

export const ACTION_GROUPS = [
  "editor",
  "navigation",
  "view",
  "document",
  "annotations",
  "claude",
] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface Action {
  id: string;
  label: string;
  group: ActionGroup;
  shortcut?: string;
  run: () => void | Promise<void>;
}

// $state-backed Map so derived consumers react to add/remove.
// Consumers read via getActionsMap() (ReadonlyMap) to avoid leaking write access.
let actionsMap = $state(new Map<string, Action>());

export interface RegisterOptions {
  replace?: boolean;
}

/** Throw in dev, warn in production — the collision policy documented above. */
function reportCollision(id: string): void {
  const msg = `[actions] id collision: "${id}" — existing action silently replaced. Pass { replace: true } to suppress this warning.`;
  if (import.meta.env.DEV) {
    throw new Error(msg);
  }
  console.warn(msg);
}

export function registerAction(action: Action, opts: RegisterOptions = {}): boolean {
  if (actionsMap.has(action.id) && !opts.replace) {
    reportCollision(action.id);
  }
  actionsMap = new Map(actionsMap).set(action.id, action);
  return true;
}

/**
 * Remove one action. Returns whether it was there.
 *
 * The copy-and-REASSIGN is the whole mechanism, not a style choice. Svelte 5's
 * `$state` proxies plain objects and arrays; a `Map` is not proxied, so
 * `.set`/`.delete`/`.values()` are invisible to the reactive graph. Every
 * consumer reads by iterating inside a `$derived.by` (CommandPalette, HelpModal,
 * ShortcutEditorList), and the ONLY thing that invalidates them is writing the
 * `actionsMap` cell. A bare `actionsMap.delete(id)` would leave all of them
 * showing the removed action until some unrelated `registerAction` happened to
 * reassign — which is what an intermittent bug looks like.
 */
export function unregisterAction(id: string): boolean {
  const next = new Map(actionsMap);
  if (!next.delete(id)) return false;
  actionsMap = next;
  return true;
}

/** Teardown handle for a batch registration. `dispose()` is idempotent. */
export interface ActionRegistration {
  dispose(): void;
}

/**
 * Register a batch and hand back its teardown.
 *
 * Two properties worth stating because neither is obvious from the signature:
 *
 * - **Collisions are pre-validated before anything is written.**
 *   `registerAction` throws in DEV, so a mid-batch collision would otherwise
 *   leave the registry half-populated with no disposer ever returned — the
 *   exact unrecoverable state this function exists to prevent.
 * - **One reassignment for the whole batch**, in each direction. A per-id loop
 *   would re-run all four `$derived.by` consumers N times and is non-atomic in
 *   the middle.
 *
 * `{ replace: true }` suppresses the *pre-existing-entry* collision only. A
 * duplicate id WITHIN one batch is always an authoring bug: the later entry
 * wins, so the registry holds one fewer action than the array reads, and in a
 * production build (where `reportCollision` warns rather than throws) the
 * earlier entry then trips the disposer's superseded-by-someone-else branch and
 * files a crash report blaming a second owner that does not exist. Hence
 * `owned` is de-duplicated below rather than being `actions.slice()`.
 */
export function registerActions(actions: Action[], opts: RegisterOptions = {}): ActionRegistration {
  const seen = new Map<string, Action>();
  for (const action of actions) {
    if (seen.has(action.id)) reportCollision(action.id);
    seen.set(action.id, action);
    if (actionsMap.has(action.id) && !opts.replace) reportCollision(action.id);
  }

  const next = new Map(actionsMap);
  for (const action of actions) next.set(action.id, action);
  actionsMap = next;

  // The de-duplicated view, not `actions.slice()`. In PROD an intra-batch
  // duplicate survives the warning above, and keeping both copies here would
  // make teardown report a phantom rival owner for the loser (see the doc
  // comment). `seen` holds the winner per id, which is exactly what was written.
  let owned: Action[] | null = [...seen.values()];
  return {
    dispose() {
      // Idempotent. A register→dispose→register cycle over the same array hands
      // the SAME object references back (an HMR re-import does mint fresh ones,
      // so this is about repeat calls within one module instance, not across
      // them); without the latch a stale disposer called twice would delete the
      // second batch's live entries.
      if (!owned) return;
      const mine = owned;
      owned = null;

      const after = new Map(actionsMap);
      let changed = false;
      for (const action of mine) {
        // Identity, not id: a later `{ replace: true }` registration of the same
        // id belongs to someone else and must survive this teardown.
        if (after.get(action.id) === action) {
          after.delete(action.id);
          changed = true;
        } else if (after.has(action.id)) {
          // Reported, not just logged: this means two owners are fighting over
          // one id, and the loser's teardown is now permanently incomplete —
          // the superseding entry outlives whatever was supposed to own it.
          const msg = `[actions] not unregistering "${action.id}" — a later registration superseded this batch's entry.`;
          console.warn(msg);
          try {
            reportError(new Error(msg), { source: "actionRegistry", actionId: action.id });
          } catch (reportErr) {
            console.warn("[actions] crash reporting is unavailable:", reportErr);
          }
        }
      }
      if (changed) actionsMap = after;
    },
  };
}

export function getActionsMap(): ReadonlyMap<string, Action> {
  return actionsMap;
}
