export interface TargetSaveCommands {
  save(intent: "save" | "save-as"): Promise<boolean>;
}

/**
 * Why a save was refused before it ever reached a persistence helper (#1708).
 *
 * Three reasons, not one boolean, because they need three different sentences:
 * a user whose tab is gone must not be told to expect a reload, and a user
 * whose source editor had not mounted yet must not be told the tab vanished.
 */
export type TargetSaveRefusal = "no-such-tab" | "tab-changed" | "no-source-commands";

export interface TargetSaveDeps<T> {
  tabId: string;
  intent: "save" | "save-as";
  resolveTarget: (tabId: string) => T | null;
  isSameTarget: (before: T, after: T) => boolean;
  isSourceView: (tabId: string) => boolean;
  activateTarget: (tabId: string) => void;
  afterActivate: () => Promise<void>;
  getSourceCommands: (tabId: string) => TargetSaveCommands | null;
  saveCommitted: (target: T, intent: "save" | "save-as") => Promise<boolean>;
  /**
   * Called when THIS function refuses, never when a delegate does (#1708).
   * `commands.save()` and `saveCommitted()` resolving `false` both already
   * report downstream — the former is `SourceView`, whose refusals are
   * concurrent with a visible save or an on-screen error strip, the latter is
   * the workspace's own post-commit helper, which notifies on every arm — so
   * calling this there would double-report one refusal.
   *
   * Optional so the return type stays `Promise<boolean>` and no caller outside
   * the workspace moves.
   */
  onRefused?: (reason: TargetSaveRefusal) => void;
}

/**
 * Coordinate a native/shortcut save against one exact live tab incarnation.
 * Source view owns commit ordering; formatted documents go directly to the
 * post-commit persistence helper. A stale/closed/reopened target never falls
 * back to the active tab.
 */
export async function saveExactTarget<T>(deps: TargetSaveDeps<T>): Promise<boolean> {
  // Each refusal names its own reason: the two composite guards below used to
  // collapse "the tab is gone" and "the tab was replaced" into one silent
  // `false`, which is half of #1708 item 1.
  const refuse = (reason: TargetSaveRefusal): false => {
    deps.onRefused?.(reason);
    return false;
  };

  const before = deps.resolveTarget(deps.tabId);
  if (!before) return refuse("no-such-tab");

  if (deps.isSourceView(deps.tabId)) {
    deps.activateTarget(deps.tabId);
    await deps.afterActivate();
    const after = deps.resolveTarget(deps.tabId);
    if (!after) return refuse("no-such-tab");
    if (!deps.isSameTarget(before, after)) return refuse("tab-changed");
    const commands = deps.getSourceCommands(deps.tabId);
    if (!commands) return refuse("no-source-commands");
    return commands.save(deps.intent);
  }

  // Defensive, not a live silent failure: this branch awaits nothing between
  // the two resolves, so `current` is necessarily `before`. It reports for
  // symmetry, so a future `await` added above cannot reintroduce a silent arm.
  const current = deps.resolveTarget(deps.tabId);
  if (!current) return refuse("no-such-tab");
  if (!deps.isSameTarget(before, current)) return refuse("tab-changed");
  return deps.saveCommitted(current, deps.intent);
}
