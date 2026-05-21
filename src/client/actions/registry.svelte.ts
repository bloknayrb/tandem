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

export function registerAction(action: Action, opts: RegisterOptions = {}): boolean {
  if (actionsMap.has(action.id)) {
    if (!opts.replace) {
      const msg = `[actions] id collision: "${action.id}" — existing action silently replaced. Pass { replace: true } to suppress this warning.`;
      if (import.meta.env.DEV) {
        throw new Error(msg);
      } else {
        console.warn(msg);
      }
    }
  }
  actionsMap = new Map(actionsMap).set(action.id, action);
  return true;
}

export function getActionsMap(): ReadonlyMap<string, Action> {
  return actionsMap;
}
