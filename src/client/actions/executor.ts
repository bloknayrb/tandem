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
import { logClientError, logClientWarning } from "../utils/client-log.js";
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
  // Deliberately does NOT say "see the developer console": devtools are excluded
  // from release desktop builds, so that would send the primary distribution's
  // users somewhere they cannot go. This toast is itself the activity-tray
  // record, which is the surface that does exist.
  return `${subject} — something went wrong inside Tandem. Try again; if it keeps happening, restart Tandem.`;
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
function report(id: string, err: unknown): void {
  // `logClientError`, not a bare `console.error`. Both write the console line,
  // but only this one also lands in the ring buffer that Copy Diagnostics and
  // Report-a-bug drain — and on the primary distribution the console reaches
  // nobody, which is the same argument `failureMessage` makes twenty lines up.
  // The action id is deliberately NOT interpolated into `event`: that parameter
  // is a static literal by contract (`client-log.ts`, pinned by
  // `tests/client/client-log-callsites.test.ts`), and the id travels on the
  // crash report and the toast instead.
  logClientError("actions", "action-failed", err);
  try {
    reportError(err, { source: "actionExecutor", actionId: id });
  } catch (reportErr) {
    // reportError is internally guarded, so reaching here means crash reporting
    // itself is broken — worth one line rather than nothing.
    logClientWarning("actions", "crash-reporting-unavailable", reportErr);
  }
  // The LIVE bag, deliberately — not the failing executor's. An ErrorBoundary
  // recovery is the motivating scenario for this whole module, and it ends with
  // a working App on screen; reporting into the dead one (or into nothing)
  // would lose the toast in exactly the case that most needs it. The live
  // facade belongs to the successor, so this still never writes into a dead
  // closure.
  const deps = currentActionDeps();
  if (!deps) {
    // Recorded, not returned silently. The failure itself is already logged and
    // reported above, but the toast vanishing is its own fact — and an
    // unrecorded drop is precisely the shape this module exists to remove.
    logClientWarning("actions", "failure-toast-dropped");
    return;
  }
  try {
    deps.notify(
      "error",
      failureMessage(id),
      // Deterministic id + dedupKey: repeats of the same failing action coalesce
      // onto one row instead of racing App's `launcher-${Date.now()}` id.
      { type: "general-error", dedupKey: `action-failed-${id}`, id: `action-failed-${id}` },
    );
  } catch (notifyErr) {
    logClientError("actions", "failure-toast-threw", notifyErr);
  }
}

/**
 * Thrown by the revalidating facade when a body touches a dependency after its
 * executor was disposed. It aborts the body rather than being an action failure,
 * so `run` reports it as a drop and never as a crash.
 */
class ExecutorDisposedError extends Error {
  readonly member: DepKey;
  constructor(member: DepKey) {
    super(
      `[actions] "${member}" called after the action executor was disposed — the App instance that owned it is gone, so the action was abandoned.`,
    );
    this.name = "ExecutorDisposedError";
    this.member = member;
  }
}

/**
 * Record a body abandoned after teardown, and tell the user it was abandoned.
 *
 * The user-facing half is not decoration. The motivating scenario ends with a
 * WORKING App on screen — someone clicked "Try to recover" — and the command
 * they ran before the crash may have half-completed (the relaunch POST can land
 * before the touch that throws). Saying nothing leaves them guessing about the
 * state of their Claude session. It is deliberately `info`, not `error`: nothing
 * went wrong with the command, its App went away.
 */
function reportDroppedCall(err: ExecutorDisposedError): void {
  logClientWarning("actions", "post-teardown-drop", err);
  try {
    reportError(err, { source: "actionExecutor", droppedMember: err.member });
  } catch (reportErr) {
    logClientWarning("actions", "crash-reporting-unavailable", reportErr);
  }
  // The LIVE bag — the successor App, if one is up. `notifyUser` handles the
  // no-App case by recording the drop, so this cannot become a silent one.
  notifyUser(
    "info",
    "That command was interrupted while Tandem recovered, so it may not have finished. Run it again if you still need it.",
    { dedupKey: "action-interrupted", id: "action-interrupted" },
  );
}

/**
 * Classify what came out of an action body. A body abandoned by the facade is
 * not a failure — nothing went wrong with the command, its App went away — so
 * it gets the drop report rather than a crash report and an error toast.
 */
function settle(id: string, err: unknown): void {
  if (err instanceof ExecutorDisposedError) {
    reportDroppedCall(err);
    return;
  }
  report(id, err);
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
      // THROW, never a type-shaped placeholder. An earlier draft returned
      // `null` — "the documented no-active-document value" — and that was the
      // most dangerous line in this module. `relaunchHere` reads
      // `getActiveDocumentPath()` and treats `null` not as absence but as a
      // second, distinct user intent: on the `cwdRequired: false` path a null
      // cwd skips the guard, reaches a `confirm()` (a global the facade cannot
      // revalidate) naming a destination the user never chose, and on accept
      // POSTs a real relaunch that SIGTERMs Claude into the server's configured
      // directory — with every toast and the #1282 re-probe dropped. The drop
      // it was meant to replace was "nothing happens"; the placeholder turned it
      // into a destructive restart at an unrequested location, silently.
      //
      // Throwing abandons the body at its FIRST post-teardown touch, which is
      // the only safe moment. `run` classifies this as a drop, not a failure.
      if (state.disposed) throw new ExecutorDisposedError(key);
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
    // No entry-time `state.disposed` guard: `runBoundAction` resolves `current`,
    // and a disposed impl is never `current` (dispose either nulls it or the
    // impl was already superseded and unreachable). A branch that cannot be
    // taken is not a safety net, it is a claim nothing can check — the facade's
    // per-call check is the real one.
    run(id, fn) {
      let result: void | Promise<void>;
      try {
        result = fn(facade);
      } catch (err) {
        settle(id, err);
        return;
      }
      if (isThenable(result)) result.then(undefined, (err: unknown) => settle(id, err));
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
 * Push a user-facing toast, or report the drop when there is nowhere to push it.
 *
 * The optional-chained `currentActionDeps()?.notify(...)` this replaces was a
 * silent failure of exactly the kind this unit exists to remove: with no bag
 * mounted the message evaporated and nothing anywhere recorded that it had.
 * That matters most for the messages that are themselves failure reports — the
 * integrity advisory ("some content may not have been preserved") is the one
 * whose disappearance is worst, because the user's next signal is a file that
 * quietly lost content.
 *
 * A missing bag is genuinely possible: `triggerSave` is driven from the Ctrl+S
 * dispatch and the activity-tray retry, and its fetch can settle after an
 * ErrorBoundary recovery has torn the old App down. So this is a report, not an
 * assertion — the console line plus a crash report is what turns an invisible
 * drop into a diagnosable one.
 */
export function notifyUser(
  severity: "info" | "warning" | "error",
  message: string,
  opts?: ActionNotifyOptions,
): void {
  const deps = currentActionDeps();
  if (!deps) {
    logClientWarning("actions", "toast-dropped");
    try {
      // The message text rides along deliberately: without it the report says
      // only that *a* toast was lost, which does not distinguish a dropped
      // integrity advisory from a dropped "saved" nudge.
      reportError(new Error(`dropped ${severity} toast: ${message}`), {
        source: "actionExecutor",
        droppedToast: severity,
      });
    } catch (reportErr) {
      logClientWarning("actions", "crash-reporting-unavailable", reportErr);
    }
    return;
  }
  try {
    deps.notify(severity, message, opts);
  } catch (notifyErr) {
    // Same reasoning as `report()`'s wrapper, and it is load-bearing here for a
    // different reason: `triggerSave` pushes up to two toasts in sequence, so an
    // unguarded throw on the first would skip the rest AND unwind past the
    // `finally` that has already recorded the save as successful — leaving the
    // status bar flashing "Saved" beside a funnel toast saying it did not finish.
    logClientError("actions", "toast-threw", notifyErr);
  }
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
    report(id, new Error("action invoked before the App mounted — no deps wired"));
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
    settle(action.id, err);
    return;
  }
  if (isThenable(result)) {
    result.then(undefined, (err: unknown) => settle(action.id, err));
  }
}
