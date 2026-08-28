/**
 * Lifecycle-bound execution for registry actions (Unit 9).
 *
 * ## Why this exists
 *
 * Action *shapes* register at module import time (`builtin.svelte.ts`), because
 * the Shortcuts settings tab, HelpModal and the command palette all need a
 * non-empty catalog before `App` mounts. Action *execution* needs the opposite
 * lifetime: it depends on 26 closures over App's reactive state, which are only
 * meaningful while that App instance is alive.
 *
 * The previous shape was a module-level `let deps: ActionDeps | null` installed
 * by a `wireActionDeps()` that had no counterpart. That fails in two ways a
 * warning cannot catch:
 *
 *  1. **A stale bag is indistinguishable from a live one.** The old `guardedRun`
 *     warned on `deps === null` and nothing else, so an action running against a
 *     destroyed component's closures looked exactly like a healthy one.
 *  2. **App remount is a production path, not a thought experiment.**
 *     `Root.svelte` wraps `<App />` in `ErrorBoundary.svelte`, whose `failed`
 *     snippet offers a "Try to recover" button calling `reset()`. That destroys
 *     and re-creates App in a shipped build.
 *
 * ## The two guarantees
 *
 * **Entry.** `runBoundAction` resolves the live executor at *call* time — never
 * a captured reference — so a new run can only reach the current deps or none.
 *
 * **In flight.** Entry-time checking alone is not enough, and this is the half
 * that is easy to miss: every consequential action here suspends and then
 * re-enters the bag. `relaunchHere` notifies and calls `afterLauncherAction()`
 * in a `finally` after several awaits AND a blocking `confirm()`;
 * `restoreBackupOfActiveDoc` notifies after two fetches and a confirm;
 * `showInFileManager` notifies after a dynamic import. So action bodies are
 * never handed the raw bag — they get a **revalidating facade** whose every
 * member re-checks disposal at the moment it is called. A post-teardown
 * `d.notify(...)` becomes a reported drop instead of a message vanishing into a
 * dead closure.
 *
 * ## Failure reporting
 *
 * `report()` is deliberately three things in a fixed order: `console.error`
 * FIRST (so the diagnostic survives a failing toast), then `reportError` from
 * `../sentry.js`, then the user-facing toast.
 *
 * The `reportError` call is **load-bearing, not decoration**. `sentry.ts`
 * registers a `window.addEventListener("unhandledrejection", ...)` handler, so
 * today a rejected action reaches crash reporting with a stack. Attaching a
 * rejection handler here marks those rejections handled and they stop arriving.
 * Catching them without re-reporting would trade a stack-carrying crash report
 * for a console line nobody reads — a net loss of telemetry wearing the costume
 * of a fix.
 *
 * ## The contract for action bodies
 *
 * **An action body that reports its own failure must swallow, not rethrow.**
 * Nearly every async helper in `builtin.svelte.ts` already catches and notifies
 * with a specific, actionable message; those return normally and never reach
 * this funnel, which is why the generic toast below does not stack on top of a
 * specific one. The funnel is for the genuinely unreported class.
 *
 * ## Not a rune module, on purpose
 *
 * This file is plain `.ts` and holds no `$state`. `mountActionExecutor` is
 * called during App's component initialization, so a reactive `current` would
 * put a `$state` write inside an initializing reaction — the
 * `state_unsafe_mutation` class from #1195. The extension is the invariant:
 * this module sits outside the reactive graph.
 *
 * **Callers must stay off the reactive path.** The synchronous-throw branch of
 * `report()` runs `notify` on the caller's own stack, and `notify` writes
 * `$state`. So `runBoundAction` must never be invoked from a `$derived`, a
 * template expression, or a Tiptap `transaction`/`update` subscriber. Every
 * caller today is a DOM event handler. The rejection branch is its own
 * microtask and is safe unconditionally.
 */

import { reportError } from "../sentry.js";
import { type Action, getActionsMap } from "./registry.svelte.js";

/** Optional routing for a toast pushed by the executor rather than by App. */
export interface ActionNotifyOptions {
  /** Activity-tray classification. Defaults to App's own choice when omitted. */
  type?: "general-error";
  /** Coalesce repeats of the same failure onto one row. */
  dedupKey?: string;
  /** Stable toast id. Without one App mints `launcher-${Date.now()}`, and
   * ToastContainer keys its `{#each}` on the id — two toasts in the same
   * millisecond are an `each_key_duplicate` throw. */
  id?: string;
}

export interface ActionDeps {
  getActiveTabId: () => string | null;
  /** Absolute filesystem path of the active doc, or null for upload://,
   * scratchpads, or app-internal docs. Launcher palette actions use this
   * to derive a cwd for `/relaunch-here`. */
  getActiveDocumentPath: () => string | null;
  /** Push a transient toast notification (info/warning/error). */
  notify: (
    severity: "info" | "warning" | "error",
    message: string,
    opts?: ActionNotifyOptions,
  ) => void;
  /**
   * Re-poll launcher-derived state after an action that moves or restarts
   * Claude (#1282).
   *
   * Called by every exported launcher action, rather than left to callers.
   * It used to be the callers' job and they did not all do it: `App.svelte`
   * wrapped the status-pill and empty-state paths, while the command palette
   * invoked the same relaunch directly and never re-probed. The #1282 drift probe
   * re-arms on the document path and an explicit refresh, neither of which a
   * relaunch changes — so after a palette relaunch the amber pill went on naming
   * the folder Claude had just left, indefinitely, which is precisely what that
   * refresh exists to prevent. Owning it in the action makes "every launcher
   * action re-probes" true by construction instead of by everyone remembering.
   *
   * Fired from the `finally` of `relaunchHere` / `startFreshConversation` — NOT
   * from the exported wrappers. The wrappers used to call it beside their
   * `void`-ed invocation, which runs the moment the async function suspends at
   * its first `await`, i.e. before the blocking `confirm()`. That put the
   * staggered re-probes ahead of the mutation they were meant to observe, so a
   * user who read the dialog for a few seconds got two answers describing the
   * world before the relaunch. Keep it at the mutation.
   */
  afterLauncherAction: () => void;
  /** Open the Settings modal (the single consolidated settings surface). */
  openSettings: () => void;
  toggleSoloMode: () => void;
  openFindBar: () => void;
  openFindBarTabs: () => void;
  findNext: () => void;
  findPrev: () => void;
  closeActiveTab: () => void;
  openFileDialog: () => void | Promise<void>;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  reopenClosedTab: () => void | Promise<void>;
  annotationNext: () => void;
  annotationPrev: () => void;
  annotationAccept: () => void;
  annotationDismiss: () => void;
  selectBlock: () => void;
  toggleAuthorship: () => void;
  toggleFormattingBar: () => void;
  /**
   * Toggle the raw-markdown source view for the active document (#1021). A
   * no-op when the active doc isn't an editable .md (the App-level handler
   * guards on format + read-only).
   */
  toggleSourceView: () => void | Promise<void>;
  /** Reveal Chat and focus its composer. */
  focusChat: () => void;
  /**
   * Save the active document under a new file path. Used to promote an
   * ephemeral scratchpad (or any `upload://`-backed doc) into a real file.
   * Resolves once the save attempt completes (success or failure) so action
   * runners can chain notifications.
   */
  saveAs: () => Promise<void>;
  /** Save the active target, promoting upload-backed documents through Save As. */
  save: () => Promise<void>;
}

/** The subset of `ActionDeps` members that are plain callables. All of them —
 * the interface is 26 functions and nothing else, which is what makes the
 * revalidating facade a mechanical wrap rather than a hand-maintained list. */
type DepKey = keyof ActionDeps;

export interface ActionExecutor {
  /** Tear down. Idempotent. Clears the module-level `current` ONLY if this
   * executor is still the current one — disposing a superseded executor must
   * never unwire its successor. */
  dispose(): void;
}

interface ExecutorImpl extends ActionExecutor {
  readonly facade: ActionDeps;
  run(id: string, fn: (d: ActionDeps) => void | Promise<void>): void;
}

let current: ExecutorImpl | null = null;

function isThenable(v: unknown): v is Promise<unknown> {
  return typeof (v as { then?: unknown } | null | undefined)?.then === "function";
}

/** Human-readable name for a toast. Falls back to the id when the action is not
 * in the registry (an exported wrapper reporting under an action id it shares). */
function failureMessage(id: string): string {
  const label = getActionsMap().get(id)?.label;
  // Not every reporting id is a registry id — `relaunchClaudeCode` reports under
  // "launcher-relaunch" so its telemetry is distinguishable from the palette
  // command it shares code with, and that id is not registered. Falling back to
  // the raw id would put a machine-readable string in front of a user, so the
  // unnamed case drops the name rather than inventing one.
  const subject = label ? `"${label}" didn't finish` : "That command didn't finish";
  return `${subject} — something went wrong inside Tandem. The details are in the developer console.`;
}

/**
 * Report an action that threw or rejected.
 *
 * The three steps are independently try-wrapped, in this fixed order, because a
 * throw inside a rejection handler is a *fresh* unhandled rejection — the exact
 * defect this module exists to remove, relocated one frame outward. Independent
 * wrapping (rather than one `try` around all three) is what keeps a failing
 * `reportError` from also swallowing the user-facing toast.
 */
function report(id: string, err: unknown, deps: ActionDeps | null): void {
  console.error(`[actions] "${id}" failed:`, err);
  try {
    reportError(err, { source: "actionExecutor", actionId: id });
  } catch {
    // reportError is already internally guarded; belt and braces.
  }
  if (!deps) return;
  try {
    deps.notify(
      "error",
      failureMessage(id),
      // Deterministic id + dedupKey: repeats of the same failing action coalesce
      // onto one row instead of racing App's `launcher-${Date.now()}` id.
      { type: "general-error", dedupKey: `action-failed-${id}`, id: `action-failed-${id}` },
    );
  } catch (notifyErr) {
    console.error(`[actions] reporting "${id}" failed:`, notifyErr);
  }
}

/** One `console.warn` + crash report for a call that arrived after teardown. */
function reportDroppedCall(member: DepKey): void {
  const err = new Error(
    `[actions] "${member}" called after the action executor was disposed — the App instance that owned it is gone, so this call was dropped.`,
  );
  console.warn(err.message);
  try {
    reportError(err, { source: "actionExecutor", droppedMember: member });
  } catch {
    // ignore
  }
}

/** The mutable half of an executor, shared by its facade, `run` and `dispose`. */
interface ExecutorState {
  deps: ActionDeps;
  disposed: boolean;
}

/**
 * Build the revalidating facade. Every member re-checks `state.disposed` at call
 * time, so an in-flight action that captured `d` before teardown cannot write
 * into the dead App's closures — it gets a reported drop instead.
 */
function buildFacade(state: ExecutorState): ActionDeps {
  const facade = {} as Record<string, unknown>;
  for (const key of Object.keys(state.deps) as DepKey[]) {
    facade[key] = (...args: unknown[]) => {
      if (state.disposed) {
        reportDroppedCall(key);
        // A dropped call must still return something type-shaped. `null` is the
        // documented "no active document / no path" value for the two getters,
        // and is ignored by every other member's `void`/`Promise<void>` caller.
        return null;
      }
      return (state.deps[key] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return facade as unknown as ActionDeps;
}

/**
 * Bind the action dependency bag to the calling component's lifetime.
 *
 * Supersedes any live executor **without warning**: the two things that produce
 * an overlap are Vite HMR and an ErrorBoundary recovery, both legitimate, so a
 * warning here would be pure noise on exactly the paths that cause it.
 */
export function mountActionExecutor(deps: ActionDeps): ActionExecutor {
  current?.dispose();

  // The mutable cell lives beside the executor rather than on it, so the facade
  // can be built before `impl` exists instead of being patched in afterwards.
  const state: ExecutorState = { deps, disposed: false };
  const facade = buildFacade(state);

  const impl: ExecutorImpl = {
    facade,
    run(id, fn) {
      if (state.disposed) {
        report(id, new Error("action invoked on a disposed executor"), null);
        return;
      }
      let result: void | Promise<void>;
      try {
        result = fn(facade);
      } catch (err) {
        report(id, err, state.disposed ? null : state.deps);
        return;
      }
      if (isThenable(result)) {
        result.then(undefined, (err: unknown) => {
          // Re-read disposal in the continuation: the App that would show the
          // toast may have gone away while the promise was in flight.
          report(id, err, state.disposed ? null : state.deps);
        });
      }
    },
    dispose() {
      state.disposed = true;
      // Only if still current. Mount B then dispose A must leave B live.
      if (current === impl) current = null;
    },
  };

  current = impl;
  return impl;
}

/**
 * The live dependency facade, or `null` when no App is mounted.
 *
 * Exists for `triggerSave`, which is exported and driven from call sites
 * *outside* any action body (the save path, the Ctrl+S dispatch and the
 * activity-tray retry), so it cannot route through `runBoundAction`. It returns
 * the facade rather than the raw bag so `triggerSave`'s post-`await` notifies
 * get the same revalidation every action body gets.
 */
export function currentActionDeps(): ActionDeps | null {
  return current ? current.facade : null;
}

/**
 * Run an action body against the live dependency bag.
 *
 * Resolves `current` at call time, never a captured reference — that is what
 * makes a *new* run against stale deps unrepresentable.
 */
export function runBoundAction(id: string, fn: (d: ActionDeps) => void | Promise<void>): void {
  const impl = current;
  if (!impl) {
    // Unreachable by user gesture in a shipped build: the bag is installed in
    // App's script scope, before any child — CommandPalette included — exists.
    // Kept, and kept loud, as a developer assertion rather than a contract.
    report(id, new Error("action invoked before the App mounted — no deps wired"), null);
    return;
  }
  impl.run(id, fn);
}

/**
 * Run an arbitrary registry `Action` with the same central catch.
 *
 * Honest about what this is: every builtin's `run` is already a synchronous
 * `runBoundAction(...)` wrapper returning `undefined`, so today this catches
 * nothing. It exists so the palette is not the hole again for a registrar added
 * later. What actually fixes the live unhandled rejection is that action bodies
 * now *return* their promises instead of `void`-ing them.
 */
export function runAction(action: Action): void {
  let result: void | Promise<void>;
  try {
    result = action.run();
  } catch (err) {
    report(action.id, err, currentActionDeps());
    return;
  }
  if (isThenable(result)) {
    result.then(undefined, (err: unknown) => report(action.id, err, currentActionDeps()));
  }
}
