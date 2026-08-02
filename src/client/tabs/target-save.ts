export interface TargetSaveCommands {
  save(intent: "save" | "save-as"): Promise<boolean>;
}

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
}

/**
 * Coordinate a native/shortcut save against one exact live tab incarnation.
 * Source view owns commit ordering; formatted documents go directly to the
 * post-commit persistence helper. A stale/closed/reopened target never falls
 * back to the active tab.
 */
export async function saveExactTarget<T>(deps: TargetSaveDeps<T>): Promise<boolean> {
  const before = deps.resolveTarget(deps.tabId);
  if (!before) return false;

  if (deps.isSourceView(deps.tabId)) {
    deps.activateTarget(deps.tabId);
    await deps.afterActivate();
    const after = deps.resolveTarget(deps.tabId);
    if (!after || !deps.isSameTarget(before, after)) return false;
    const commands = deps.getSourceCommands(deps.tabId);
    if (!commands) return false;
    return commands.save(deps.intent);
  }

  const current = deps.resolveTarget(deps.tabId);
  if (!current || !deps.isSameTarget(before, current)) return false;
  return deps.saveCommitted(current, deps.intent);
}
