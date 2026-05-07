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
 * ADR-028 (docs/decisions.md) records the design rationale.
 */

export const ACTION_GROUPS = ["editor", "navigation", "view", "document"] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface Action {
  id: string;
  label: string;
  group: ActionGroup;
  shortcut?: string;
  run: () => void | Promise<void>;
}

// $state-backed Map so derived consumers react to add/remove.
// We expose a plain snapshot array via getActions() to avoid leaking the Map.
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

export function unregisterAction(id: string): void {
  if (!actionsMap.has(id)) return;
  const next = new Map(actionsMap);
  next.delete(id);
  actionsMap = next;
}

export function unregisterByPrefix(prefix: string): void {
  const toRemove = [...actionsMap.keys()].filter((k) => k.startsWith(prefix));
  if (toRemove.length === 0) return;
  const next = new Map(actionsMap);
  for (const id of toRemove) next.delete(id);
  actionsMap = next;
}

export function getActions(): Action[] {
  return [...actionsMap.values()];
}

export function getActionsMap(): ReadonlyMap<string, Action> {
  return actionsMap;
}
