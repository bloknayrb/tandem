/**
 * Document workspace (ADR-035 Unit 10a).
 *
 * Owns the three things `App.svelte` still held for the open-document domain:
 * the per-tab **source view** (raw markdown) with its drafts and dirty set, the
 * **close / reopen** funnel, and the **save entry points**. Factory invoked ONCE
 * in `App.svelte`'s `<script>` scope, mirroring `createLayoutModel`
 * (`../layout/model.svelte.ts`) and `createChatState` (`./useChatState.svelte.ts`).
 * Returns getters so consumers see reactivity through the `$state` underneath.
 * NOT a module-level singleton — the `beforeunload` `$effect` below must run
 * inside a component effect root.
 *
 * **It does not own tabs or the active tab, and must not.** The unit's original
 * instruction said this workspace "must own active document, tab" — that
 * described a component that no longer exists. `yjsSync.svelte.ts` has owned
 * `tabs` and `activeTabId` (its own `$state` cells `tabsState` /
 * `activeTabIdState`, exposed as those two getters) along with
 * `setActiveTabId` / `handleTabClose` / `handleTabRename` for some time, and
 * taking them back here would be a regression wearing an extraction's clothes.
 * Tab *ordering* likewise stays in `useTabOrder`, the reopen LIFO in
 * `useClosedTabStack`, save-in-flight state in `actions/builtin.svelte.ts`'s
 * `saveStore`, and the save-one-incarnation algorithm in `tabs/target-save.ts`.
 * This module orchestrates those; it re-implements none of them.
 *
 * **The four collections are copy-on-write, and nothing but this note enforces
 * it.** `sourceViewTabs`, `sourceDrafts`, `sourceDirtyTabs` and
 * `sourceViewCommands` are plain `$state(new Set()/new Map())`. Svelte 5 boxes
 * the *reference*, not the contents — only `svelte/reactivity`'s `SvelteSet` /
 * `SvelteMap` proxy mutations, and nothing in `src/client/` imports those (see
 * `panels/MarginColumn.svelte`'s note on the same rule). So **every mutator here
 * builds a new collection and assigns it.** A `.add(...)` on the existing
 * instance would compile, run, update the data, and never notify a single
 * consumer — the UI would silently stop tracking. `tests/client/
 * document-workspace.svelte.test.ts` pins this by counting effect re-runs, which
 * is the only assertion shape that can tell the two apart: `.has(id)` reads true
 * either way, because a `Set` is a mutable reference.
 *
 * **Destructuring rule, stated precisely.** The five GETTERS below
 * (`sourceViewTabs`, `sourceDrafts`, `sourceDirtyTabs`, `canSourceView`,
 * `inSourceView`) must be read through the object at each use — destructuring
 * them snapshots the current value forever. The METHODS are
 * ordinary closures over this factory's state and destructure safely; do not
 * "fix" a method destructure on the strength of the getter rule.
 *
 * **Every `getX` option must read live state in its body.** `getActiveTab: () =>
 * activeTab` is correct; `const t = activeTab; getActiveTab: () => t` typechecks
 * identically and never sees a tab switch, because the snapshot happened at the
 * `const`. TypeScript cannot distinguish them.
 *
 * Deliberately NOT here: per-tab scroll memory (DOM-bound, with a
 * `requestAnimationFrame` retry loop — `onTabClosed` lets the close funnel evict
 * it without dragging a DOM ref into this module), the shortcut dispatch table
 * (mixes this domain with chat/annotation actions; Unit 10c's shape), and the
 * auto-open-scratchpad effect (connection-lifecycle bootstrapping, not document
 * state).
 */

import { tick } from "svelte";
import { crossBasename } from "../../shared/cross-basename.js";
import { isScratchpadPath, isUploadPath, scratchpadUuidFromPath } from "../../shared/paths";
import { generateNotificationId } from "../../shared/utils";
import {
  tabIdsToCloseLeft,
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
} from "../tabs/tab-context-menu";
import { saveExactTarget, type TargetSaveRefusal } from "../tabs/target-save.js";
import type { OpenTab } from "../types.js";
import type { ClosedTabRecord } from "./useClosedTabStack.svelte";
import type { NotificationsState } from "./useNotifications.svelte";

/** Registered by a mounted `SourceView` so save/exit can drive it by id. */
export type SourceViewCommands = {
  documentId: string;
  save(intent: "save" | "save-as"): Promise<boolean>;
  exit(): Promise<void>;
};

type SaveSeverity = "info" | "warning" | "error";

/**
 * #1708 item 1. One sentence per refusal reason, because they are three
 * different events: a user whose tab is gone must not be told to expect a
 * reload, and a user whose source editor had not mounted yet must not be told
 * the tab vanished.
 */
const SAVE_REFUSAL_MESSAGES: Record<TargetSaveRefusal, string> = {
  "no-such-tab": "Not saved — that document is no longer open.",
  "tab-changed": "Not saved — the document reloaded while saving.",
  "no-source-commands": "Not saved — the Markdown source editor wasn't ready yet.",
};

/** Defaults for the reopen post-condition poll (#1708 item 6). */
const REOPEN_POLL_MS = 250;
const REOPEN_TIMEOUT_MS = 8000;

export interface CreateDocumentWorkspaceOpts {
  /** Live tab list. Must read `yjsSync.tabs` in the body, not a snapshot. */
  getTabs: () => OpenTab[];
  /** Live active tab id. */
  getActiveTabId: () => string | null;
  /** Live active tab. */
  getActiveTab: () => OpenTab | undefined;
  /** Live read-only flag for the active tab. */
  getIsReadOnly: () => boolean;
  /** Live ordered tab list — the bulk closes iterate display order, not doc order. */
  getOrderedTabs: () => OpenTab[];

  setActiveTabId: (tabId: string) => void;
  /** `yjsSync.handleTabClose` — this module never closes a tab itself. */
  closeTab: (tabId: string) => void;

  closedTabStack: {
    push: (record: ClosedTabRecord) => void;
    pop: () => ClosedTabRecord | null;
  };
  scratchpad: {
    hasUnsavedContent: (uuid: string) => boolean;
    clearUnsaved: (uuid: string) => void;
  };

  openServerPath: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * The options bag is part of the injected type so this module can pass
   * `{ announceBusy: true }` (#1708 item 3). Every save that reaches here came
   * from a user gesture — Ctrl+S, the menu, the tab context menu — and a
   * re-entrant one that says nothing is a dead key.
   */
  triggerSave: (documentId: string, opts?: { announceBusy?: boolean }) => Promise<boolean>;
  triggerSaveAs: (args: {
    activeDocId: string;
    defaultName: string;
    sourceFormat: string;
    notify: (severity: SaveSeverity, message: string) => void;
  }) => Promise<boolean>;

  /**
   * Injected whole rather than as `(severity, message)`: the two call sites
   * build DIFFERENT envelopes, and a flattened signature drops fields. The save
   * path is `type: "launcher"`; the reopen-failure path is
   * `type: "general-error"` and carries a `dedupKey`, which is what stops a
   * duplicate toast per retry.
   */
  pushNotification: NotificationsState["push"];

  /**
   * Injected so the close funnel is testable without a real dialog. Both call
   * sites are a plain accept/decline and differ only in message.
   */
  confirm: (message: string) => boolean;

  /**
   * Source view replaces the Tiptap editor, so entering it closes the
   * editor-bound overlays. Those live in `App.svelte` (find bar, slash-command
   * menu, palette) and are not this module's state.
   */
  closeEditorOverlays: () => void;

  /**
   * Close funnel notifies App so it can evict the tab's remembered scroll
   * position. REQUIRED, not optional: on master this was an unconditional
   * `scrollMemory.delete(tabId)` inside the funnel, so an optional callback
   * would let a future consumer leak scroll memory forever with no signal.
   */
  onTabClosed: (tabId: string) => void;

  /**
   * Reopen post-condition poll (#1708 item 6). Injectable ONLY so a spec can
   * reach the timeout path without burning the real ceiling; `App.svelte`
   * passes neither.
   */
  reopenPollMs?: number;
  reopenTimeoutMs?: number;
}

export interface DocumentWorkspace {
  readonly sourceViewTabs: ReadonlySet<string>;
  readonly sourceDrafts: ReadonlyMap<string, string>;
  readonly sourceDirtyTabs: ReadonlySet<string>;
  readonly canSourceView: boolean;
  readonly inSourceView: boolean;
  /**
   * Size of the registered-commands map. Exists so the fourth copy-on-write
   * collection has a reactive observer at all: `sourceCommandsForEvent` is a
   * plain Map lookup and tracks nothing, so without this a mutator rewritten
   * to `.set(...)` in place notified nobody and every spec stayed green. The
   * commands themselves stay unexported -- they are closures over a mounted
   * component, not data a consumer should reach into.
   */
  readonly sourceViewCommandCount: number;

  isTabInSourceView: (tabId: string) => boolean;
  updateSourceViewCommands: (documentId: string, commands: SourceViewCommands | null) => void;
  sourceCommandsForEvent: (e: KeyboardEvent) => SourceViewCommands | null;
  updateSourceDraft: (tabId: string, text: string, dirty: boolean) => void;
  clearSourceDraft: (tabId: string) => void;
  enterSourceView: () => void;
  enterSourceViewTarget: (documentId: string) => void;
  requestToggleSourceView: () => Promise<void>;
  requestToggleSourceViewTarget: (documentId: string) => Promise<void>;
  exitSourceView: (tabId: string) => void;

  // #1824 item H: `boolean` (`true` = closed, `false` = cancelled) so a bulk
  // close loop can abort the rest of its batch on Cancel. A bare call site
  // that ignores the return value still typechecks (assignable where `void`
  // was expected).
  closeTabAndRecord: (tabId: string) => boolean;
  closeOtherTabs: (keepId: string) => void;
  closeTabsToLeft: (fromId: string) => void;
  closeTabsToRight: (fromId: string) => void;
  reopenClosedTab: () => Promise<void>;

  saveDocumentTarget: (tabId: string | null, intent: "save" | "save-as") => Promise<void>;
  saveDocumentTargetAfterSourceCommit: (
    tabId: string,
    intent: "save" | "save-as",
    expectedYdoc?: OpenTab["ydoc"],
  ) => Promise<boolean>;
}

export function createDocumentWorkspace(opts: CreateDocumentWorkspaceOpts): DocumentWorkspace {
  // Per-tab raw-markdown source view (#1021). Ephemeral (not persisted): the set
  // of tab IDs currently showing the markdown source editor instead of WYSIWYG.
  let sourceViewTabs = $state(new Set<string>());
  // In-progress source text + dirty flags, keyed by tab ID, lifted out of
  // SourceView so uncommitted edits survive a tab switch (which unmounts the
  // component) and so tab close / app quit can warn before discarding them
  // (#1021 review SHOULD-FIX).
  let sourceDrafts = $state(new Map<string, string>());
  let sourceDirtyTabs = $state(new Set<string>());
  let sourceViewCommands = $state(new Map<string, SourceViewCommands>());

  // Reopen dedup. Plain Set, deliberately not `$state`: nothing renders it, and
  // it is read and written inside one async function.
  const inflightReopens = new Set<string>();

  const canSourceView = $derived.by(() => {
    const tab = opts.getActiveTab();
    return !!tab && tab.format === "md" && !opts.getIsReadOnly();
  });
  const inSourceView = $derived.by(() => {
    const tab = opts.getActiveTab();
    return !!tab && sourceViewTabs.has(tab.id);
  });

  // ---- source view ---------------------------------------------------------

  function updateSourceViewCommands(documentId: string, commands: SourceViewCommands | null): void {
    const next = new Map(sourceViewCommands);
    if (commands) next.set(documentId, commands);
    else next.delete(documentId);
    sourceViewCommands = next;
  }

  function sourceCommandsForEvent(e: KeyboardEvent): SourceViewCommands | null {
    const el = e.target as HTMLElement | null;
    const container = el?.closest?.<HTMLElement>('[data-testid="source-view-container"]');
    const documentId = container?.dataset.documentId;
    return documentId ? (sourceViewCommands.get(documentId) ?? null) : null;
  }

  function updateSourceDraft(tabId: string, text: string, dirty: boolean): void {
    const drafts = new Map(sourceDrafts);
    const dirtyTabs = new Set(sourceDirtyTabs);
    if (dirty) {
      drafts.set(tabId, text);
      dirtyTabs.add(tabId);
    } else {
      drafts.delete(tabId);
      dirtyTabs.delete(tabId);
    }
    sourceDrafts = drafts;
    sourceDirtyTabs = dirtyTabs;
  }

  function clearSourceDraft(tabId: string): void {
    if (!sourceDrafts.has(tabId) && !sourceDirtyTabs.has(tabId)) return;
    const drafts = new Map(sourceDrafts);
    const dirtyTabs = new Set(sourceDirtyTabs);
    drafts.delete(tabId);
    dirtyTabs.delete(tabId);
    sourceDrafts = drafts;
    sourceDirtyTabs = dirtyTabs;
  }

  function enterSourceView(): void {
    const tab = opts.getActiveTab();
    if (!tab) return;
    const id = tab.id;
    if (sourceViewTabs.has(id) || !canSourceView) return;
    const next = new Set(sourceViewTabs);
    next.add(id);
    // Source view replaces the Tiptap editor; close editor-bound overlays so
    // they don't linger non-functional over the textarea.
    opts.closeEditorOverlays();
    sourceViewTabs = next;
  }

  function enterSourceViewTarget(documentId: string): void {
    const tab = opts.getTabs().find((candidate) => candidate.id === documentId);
    if (!tab || tab.format !== "md" || tab.readOnly || sourceViewTabs.has(documentId)) return;
    opts.setActiveTabId(documentId);
    const next = new Set(sourceViewTabs);
    next.add(documentId);
    opts.closeEditorOverlays();
    sourceViewTabs = next;
  }

  /**
   * Leave source view through the tab's own registered commands, so a dirty
   * draft is committed first. The caller must have activated the tab: an
   * inactive SourceView is unmounted, and `App.svelte` keys it on
   * `{#key activeTab.id}`, so a lookup taken in the same turn as a remount can
   * miss a registration that is one microtask away — hence the `tick()`.
   *
   * #1708 item 4: both toggles used to optional-chain `…get(id)?.exit()`, so an
   * unregistered id resolved normally and left the user in source view with
   * nothing said.
   */
  async function exitViaSourceCommands(documentId: string): Promise<void> {
    await tick();
    const commands = sourceViewCommands.get(documentId);
    if (!commands) {
      pushWorkspaceNotification(
        "warning",
        "Couldn't leave source view — the Markdown source editor was still loading.",
        `source-view-exit:${documentId}`,
      );
      return;
    }
    await commands.exit();
  }

  async function requestToggleSourceViewTarget(documentId: string): Promise<void> {
    const tab = opts.getTabs().find((candidate) => candidate.id === documentId);
    if (!tab || tab.format !== "md" || tab.readOnly) return;
    opts.setActiveTabId(documentId);
    if (!sourceViewTabs.has(documentId)) {
      enterSourceViewTarget(documentId);
      return;
    }
    await exitViaSourceCommands(documentId);
  }

  async function requestToggleSourceView(): Promise<void> {
    const documentId = opts.getActiveTabId();
    if (!documentId) return;
    if (sourceViewTabs.has(documentId)) {
      // The target twin already waited a tick for a remounting SourceView to
      // register; this one did not (#1708 item 4). Both go through the shared
      // helper so neither can drift back to a silent optional chain.
      await exitViaSourceCommands(documentId);
      return;
    }
    // #1708 item 5. Every VISIBLE affordance is gated on `canSourceView`, but
    // Ctrl+Shift+E is not — this is the one entry point that has to explain the
    // rule rather than be a dead key. Both arms read the tab and the read-only
    // flag directly: `canSourceView` is a single boolean and cannot say which
    // half failed.
    const tab = opts.getActiveTab();
    // An active id resolving to no tab is a transient between swaps, with no
    // format to name. Silence is the honest answer there.
    if (!tab) return;
    // Format FIRST, because it is the durable rule. A read-only `.md` fails
    // this test, falls through, and gets the read-only sentence; a read-only
    // `.docx` must be told the rule it can never satisfy. Read-only-first is
    // the order that misreports — it implies that making the file writable
    // would enable source view, which the format gate never will.
    if (tab.format !== "md") {
      pushWorkspaceNotification(
        "info",
        "Source view is only available for Markdown documents.",
        `source-view-unavailable:not-markdown:${tab.id}`,
      );
      return;
    }
    if (opts.getIsReadOnly()) {
      pushWorkspaceNotification(
        "info",
        "Source view isn't available — this document is read-only.",
        `source-view-unavailable:read-only:${tab.id}`,
      );
      return;
    }
    enterSourceView();
  }

  function exitSourceView(id: string): void {
    if (!sourceViewTabs.has(id)) return;
    const next = new Set(sourceViewTabs);
    next.delete(id);
    sourceViewTabs = next;
    // Returning to WYSIWYG discards any in-progress draft (a dirty exit commits
    // first via SourceView.handleExit, which already cleared it).
    clearSourceDraft(id);
  }

  // Warn before unloading the page (reload / quit) while any source view holds
  // uncommitted edits — mirrors the scratchpad #864 beforeunload guard.
  $effect(() => {
    const onBeforeUnload = (ev: BeforeUnloadEvent): void => {
      if (sourceDirtyTabs.size === 0) return;
      ev.preventDefault();
      ev.returnValue = "You have unsaved markdown-source edits.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });

  // ---- close / reopen ------------------------------------------------------

  // #1824 item H: returns `false` (cancelled) rather than silently returning
  // when a confirm is declined, so a bulk-close loop can tell "closed" from
  // "the user stopped the batch here" and abort instead of prompting for the
  // rest. #1708 item 7 adds the other early return, and it must answer `true`:
  // `false` is reserved for the user's Cancel and `closeEachUntilCancelled`
  // breaks on it, so `false` for an id that never resolved would silently
  // truncate a bulk close at the ghost.
  function closeTabAndRecord(tabId: string): boolean {
    const tab = opts.getTabs().find((t) => t.id === tabId);
    if (!tab) {
      // Before #1708 an unresolvable id ran most of the funnel on nothing: it
      // skipped both confirms and the stack push, then still cleared the draft
      // and called `onTabClosed` + `closeTab`. It logs rather than notifying —
      // `closeOtherTabs` sources its ids from `getOrderedTabs()`, a `$derived`
      // over the same list this resolves against, so a ghost id is not a state
      // the user can cause and a toast would name one that does not exist.
      console.warn(`[Tandem] closeTabAndRecord: no open tab with id "${tabId}"`);
      return true;
    }
    // #864 / #1021: both confirms below must be settled (and both must be
    // accepted) BEFORE either one's side effect runs. A scratchpad with
    // unsaved content that has also picked up unsaved source-view edits is
    // reachable through one tab (a scratchpad's format is "md", so source
    // view is available on it), so accepting the first confirm and then
    // declining the second must leave the scratchpad's localStorage recovery
    // copy intact — declining is "keep this tab open", and a copy discarded
    // on the way to a decline is data loss the user explicitly chose against.
    let scratchpadUuidToClear: string | null = null;
    // #864: warn before closing a scratchpad that has unsaved content. Annotations
    // are intentionally out of scope (accepted loss); only document text matters.
    if (isScratchpadPath(tab.filePath)) {
      const uuid = scratchpadUuidFromPath(tab.filePath);
      if (uuid && opts.scratchpad.hasUnsavedContent(uuid)) {
        const ok = opts.confirm(
          "This scratchpad has unsaved content that will be lost. Close it anyway?",
        );
        if (!ok) return false;
        scratchpadUuidToClear = uuid;
      }
    }
    // #1021: warn before closing a tab with uncommitted markdown-source edits
    // (mirrors the #864 scratchpad confirm above). The disk file is intact — this
    // is loss of unsaved source-view work only.
    if (sourceDirtyTabs.has(tabId)) {
      const ok = opts.confirm(
        "This document has unsaved markdown-source edits that will be lost. Close it anyway?",
      );
      if (!ok) return false;
    }
    // Both confirms (whichever applied) passed — now safe to discard the
    // scratchpad recovery copy so the next scratchpad open doesn't restore
    // content the user just accepted losing.
    if (scratchpadUuidToClear) {
      opts.scratchpad.clearUnsaved(scratchpadUuidToClear);
    }
    if (!isUploadPath(tab.filePath)) {
      opts.closedTabStack.push({ filePath: tab.filePath, closedAt: Date.now() });
    }
    // Drop any source-view flag + draft for the closed tab so the maps don't leak (#1021).
    if (sourceViewTabs.has(tabId)) {
      const next = new Set(sourceViewTabs);
      next.delete(tabId);
      sourceViewTabs = next;
    }
    clearSourceDraft(tabId);
    // App evicts the closed tab's remembered scroll position (#1055). It stays
    // there because it is a DOM concern; the funnel still owns the *timing*.
    opts.onTabClosed(tabId);
    opts.closeTab(tabId);
    return true;
  }

  // Tab context-menu bulk closes (#923 Phase 2). The id lists are computed by
  // pure helpers (which guard against a stale right-clicked id closing every
  // tab) and snapshotted before the loop — closeTabAndRecord mutates the tab
  // list, so iterating live tabs would skip entries. Each close routes through
  // closeTabAndRecord so the scratchpad-unsaved guard + closed-tab stack apply.
  // #1824 item H: Cancel on any one tab ABORTS the rest of the batch (not
  // skip-and-continue) — `break` on the first `false`.
  function closeEachUntilCancelled(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!closeTabAndRecord(id)) break;
    }
  }

  function closeOtherTabs(keepId: string): void {
    closeEachUntilCancelled(tabIdsToCloseOthers(opts.getOrderedTabs(), keepId));
  }

  function closeTabsToLeft(fromId: string): void {
    closeEachUntilCancelled(tabIdsToCloseLeft(opts.getOrderedTabs(), fromId));
  }

  function closeTabsToRight(fromId: string): void {
    closeEachUntilCancelled(tabIdsToCloseRight(opts.getOrderedTabs(), fromId));
  }

  /**
   * Teardown latch (review round 1).
   *
   * Every `opts.*` collaborator is bound to ONE `App.svelte` instance, and
   * `Root.svelte` wraps `<App/>` in `ErrorBoundary` whose `reset()` is a real
   * production remount — the same fact `mountActionExecutor`'s `onDestroy`
   * release exists for. The reopen poll below is the only await in this module
   * long enough to straddle one, so without this a "Try to recover" during the
   * wait leaves work still writing into the destroyed instance's closures.
   *
   * Its own `$effect` with an EMPTY body, deliberately: the body reads nothing
   * reactive, so the effect never re-runs and its teardown therefore fires on
   * destruction only. Hanging this off the `beforeunload` effect instead would
   * latch `disposed` permanently the first time anyone added a reactive read
   * there — a failure that looks exactly like a working latch.
   */
  let disposed = false;
  $effect(() => () => {
    disposed = true;
  });

  /**
   * Wait for a reopened path to actually appear in the tab list (#1708 item 6).
   * A poll rather than a subscription: the tab arrives over Yjs and this module
   * deliberately holds no provider handle.
   */
  async function waitForReopenedTab(filePath: string): Promise<boolean> {
    const pollMs = opts.reopenPollMs ?? REOPEN_POLL_MS;
    const deadline = Date.now() + (opts.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS);
    for (;;) {
      // The first check runs before any wait, so an open that lands
      // synchronously costs nothing.
      if (opts.getTabs().some((t) => t.filePath === filePath)) return true;
      // `disposed` first: a torn-down workspace must stop polling now rather
      // than burn the rest of an 8-second ceiling against `getTabs` closures
      // that no longer describe any mounted app.
      if (disposed || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function reopenClosedTab(): Promise<void> {
    const rec = opts.closedTabStack.pop();
    if (!rec) return;
    // Server may have rejected the original close (rare); also covers the
    // close→reopen→close→reopen rapid cycle for the same path. If the file is
    // still open, just activate it.
    const existing = opts.getTabs().find((t) => t.filePath === rec.filePath);
    if (existing) {
      opts.setActiveTabId(existing.id);
      return;
    }
    if (inflightReopens.has(rec.filePath)) {
      // Put it back. The stack dedups only CONSECUTIVE duplicates, so a
      // close X / close Y / close X sequence really does hold the same path
      // twice; dropping the popped record here would make the user's next
      // Ctrl+Alt+T a silent no-op with the entry gone for good.
      opts.closedTabStack.push(rec);
      // ...and say so (review round 1). Item 6's post-condition poll widened
      // this window from one HTTP round trip to as long as the reopen ceiling,
      // so a user who presses Ctrl+Alt+T again while nothing has appeared yet
      // lands here — and a branch that restores the record and returns in
      // silence is the same dead key the rest of this issue removes. The
      // end-of-wait warning cannot cover it: that one reports the FIRST
      // attempt, and a user who gives up before the ceiling never sees it.
      //
      // `info`, not `warning`: the reopen really is running. Its own dedupKey,
      // because two DIFFERENT messages must never share one.
      pushWorkspaceNotification(
        "info",
        `Still reopening ${crossBasename(rec.filePath) || rec.filePath}…`,
        `reopen-inflight:${rec.filePath}`,
      );
      return;
    }
    inflightReopens.add(rec.filePath);
    // `kind` keys BOTH the notification id and the dedupKey, so the two
    // outcomes never coalesce onto one tray row (#1708 item 6).
    const handleFailure = (
      reason: string,
      kind: "failed" | "no-tab" = "failed",
      severity: SaveSeverity = "error",
    ) => {
      if (disposed) {
        // Both writes below reach ONE App instance: the stack is that
        // instance's (`useClosedTabStack` — "lifetime is the app session"), and
        // so is the tray. After an ErrorBoundary remount both have already been
        // recreated empty, so pushing is a ghost write whose toast nobody can
        // ever see. A console line instead, the same choice `closeTabAndRecord`
        // makes for a state the user cannot act on.
        console.warn(`[Tandem] reopen ${kind} after teardown: ${rec.filePath} — ${reason}`);
        return;
      }
      // Restore the record so the user can retry with another Ctrl+Alt+T;
      // silent drop would also surprise users who expect LIFO to be retryable.
      opts.closedTabStack.push(rec);
      const basename = crossBasename(rec.filePath) || rec.filePath;
      opts.pushNotification({
        id: `reopen-${kind}-${Date.now()}`,
        type: "general-error",
        severity,
        message: `Couldn't reopen ${basename}: ${reason}`,
        dedupKey: `reopen-${kind}:${rec.filePath}`,
        timestamp: Date.now(),
      });
    };
    try {
      const result = await opts.openServerPath(rec.filePath);
      if (!result.ok) {
        handleFailure(result.error);
      } else if (!(await waitForReopenedTab(rec.filePath))) {
        // `{ ok: true }` means the server ACCEPTED the open, not that a tab
        // arrived — the tab materialises later over Yjs (#1708 item 6). The
        // record was popped at the top and restored only inside
        // `handleFailure`, so without this a server-side no-op loses it for
        // good. The wait sits inside the `try` so `inflightReopens` holds
        // across it. One severity BELOW the rejection arm: the open was accepted
        // and the tab may still land, in which case the next Ctrl+Alt+T finds
        // it open and activates instead of opening twice.
        handleFailure("the server accepted it but no tab appeared.", "no-tab", "warning");
      }
    } catch (err) {
      // The injected implementation catches internally today, so its type says
      // it never throws -- but a type is not an enforcement, and this became an
      // injected dependency only in Unit 10a. Without this branch a throw skips
      // handleFailure, loses the record silently, and escapes as an unhandled
      // rejection through App's `void reopenClosedTab()` call sites.
      handleFailure(err instanceof Error ? err.message : String(err));
    } finally {
      inflightReopens.delete(rec.filePath);
    }
  }

  // ---- save ----------------------------------------------------------------

  /**
   * Client-action notification, `type: "launcher"` — the tray's classification
   * for an echo of something the user just did.
   *
   * `dedupKey` is optional and carried by the #1708 messages only; the three
   * older ones stay byte-identical. **Two DIFFERENT messages must never share
   * one key.** `useNotifications` coalesces on the key and spreads the newer
   * notification over the matched row, so a shared key silently replaces one
   * report with the other — which is the information loss #1708 exists to fix.
   * Two sites emitting the SAME sentence may share a key, and one pair does.
   */
  function pushWorkspaceNotification(
    severity: SaveSeverity,
    message: string,
    dedupKey?: string,
  ): void {
    opts.pushNotification({
      id: generateNotificationId(),
      type: "launcher",
      severity,
      message,
      dedupKey,
      timestamp: Date.now(),
    });
  }

  /**
   * One message and one dedupKey per refusal reason (#1708 items 1 and 2), so
   * the two sites that can report the same reason cannot drift apart: two sites
   * emitting the SAME sentence may share a key, two different messages may not.
   */
  function reportSaveRefusal(reason: TargetSaveRefusal, tabId: string): void {
    pushWorkspaceNotification(
      "warning",
      SAVE_REFUSAL_MESSAGES[reason],
      `save-target:${reason}:${tabId}`,
    );
  }

  async function saveDocumentTargetAfterSourceCommit(
    tabId: string,
    intent: "save" | "save-as",
    expectedYdoc?: OpenTab["ydoc"],
  ): Promise<boolean> {
    const tab = opts.getTabs().find((candidate) => candidate.id === tabId);
    // #1708 item 2: the one refusal in this function that said nothing, while
    // its three siblings below all notify. Split, because the halves are
    // different events — and the ydoc mismatch takes its OWN dedupKey rather
    // than item 1's `save-target:tab-changed`, since the tray keeps the newer
    // message on a shared key and the milder copy would overwrite the only one
    // that reports lost work. No reassurance about surviving edits: `commit()`
    // clears the draft before `onSave`, and the remount drops it.
    if (!tab) {
      reportSaveRefusal("no-such-tab", tabId);
      return false;
    }
    if (expectedYdoc && tab.ydoc !== expectedYdoc) {
      pushWorkspaceNotification(
        "warning",
        "Not saved — the document reloaded while saving; your last edit was not written to the file.",
        `save-commit:ydoc-swapped:${tabId}`,
      );
      return false;
    }

    const needsPromotion = tab.source === "upload" || isUploadPath(tab.filePath);
    if (needsPromotion) {
      if (tab.readOnly) {
        pushWorkspaceNotification("warning", "Not saved — this document is read-only.");
        return false;
      }
      return opts.triggerSaveAs({
        activeDocId: tab.id,
        defaultName: crossBasename(tab.filePath) || tab.filePath,
        sourceFormat: tab.format,
        notify: pushWorkspaceNotification,
      });
    }

    if (intent === "save-as") {
      pushWorkspaceNotification(
        "info",
        "Save As is for uploads and scratchpads; this document already saves to its file.",
      );
      return false;
    }
    return opts.triggerSave(tab.id, { announceBusy: true });
  }

  /**
   * Save one exact live tab incarnation. A source-view target must mount and
   * commit its draft before the post-commit persistence helper is allowed to
   * run; formatted documents can persist immediately.
   */
  async function saveDocumentTarget(
    tabId: string | null,
    intent: "save" | "save-as",
  ): Promise<void> {
    if (!tabId) {
      pushWorkspaceNotification("warning", "No active document to save.");
      return;
    }

    await saveExactTarget<OpenTab>({
      tabId,
      intent,
      resolveTarget: (id) => opts.getTabs().find((candidate) => candidate.id === id) ?? null,
      isSameTarget: (before, after) => before.ydoc === after.ydoc,
      isSourceView: (id) => sourceViewTabs.has(id),
      activateTarget: (id) => opts.setActiveTabId(id),
      afterActivate: tick,
      getSourceCommands: (id) => sourceViewCommands.get(id) ?? null,
      saveCommitted: (target, nextIntent) =>
        saveDocumentTargetAfterSourceCommit(target.id, nextIntent, target.ydoc),
      // #1708 item 1: the boolean this call used to drop. `saveExactTarget`
      // reports only ITS OWN refusals — a `false` from the source-view command
      // or from the post-commit helper is already reported by that callee, so a
      // toast here would double-report one refusal.
      onRefused: (reason) => reportSaveRefusal(reason, tabId),
    });
  }

  return {
    get sourceViewTabs() {
      return sourceViewTabs;
    },
    get sourceDrafts() {
      return sourceDrafts;
    },
    get sourceDirtyTabs() {
      return sourceDirtyTabs;
    },
    get canSourceView() {
      return canSourceView;
    },
    get inSourceView() {
      return inSourceView;
    },
    get sourceViewCommandCount() {
      return sourceViewCommands.size;
    },

    isTabInSourceView: (tabId: string) => sourceViewTabs.has(tabId),
    updateSourceViewCommands,
    sourceCommandsForEvent,
    updateSourceDraft,
    clearSourceDraft,
    enterSourceView,
    enterSourceViewTarget,
    requestToggleSourceView,
    requestToggleSourceViewTarget,
    exitSourceView,

    closeTabAndRecord,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    reopenClosedTab,

    saveDocumentTarget,
    saveDocumentTargetAfterSourceCommit,
  };
}
