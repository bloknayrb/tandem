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
 * `tabs` and `activeTabId` (its own `$state`, `:157-158`) along with
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
 * **Destructuring rule, stated precisely.** The GETTERS below
 * (`sourceViewTabs`, `sourceDrafts`, `sourceDirtyTabs`, `canSourceView`,
 * `inSourceView`, `sourceDirtyCount`) must be read through the object at each
 * use — destructuring them snapshots the current value forever. The METHODS are
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
import { saveExactTarget } from "../tabs/target-save.js";
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
  triggerSave: (documentId: string) => Promise<boolean>;
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

  /** Close funnel notifies App so it can evict the tab's remembered scroll position. */
  onTabClosed?: (tabId: string) => void;
}

export interface DocumentWorkspace {
  readonly sourceViewTabs: ReadonlySet<string>;
  readonly sourceDrafts: ReadonlyMap<string, string>;
  readonly sourceDirtyTabs: ReadonlySet<string>;
  readonly canSourceView: boolean;
  readonly inSourceView: boolean;

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

  closeTabAndRecord: (tabId: string) => void;
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

  async function requestToggleSourceViewTarget(documentId: string): Promise<void> {
    const tab = opts.getTabs().find((candidate) => candidate.id === documentId);
    if (!tab || tab.format !== "md" || tab.readOnly) return;
    opts.setActiveTabId(documentId);
    if (!sourceViewTabs.has(documentId)) {
      enterSourceViewTarget(documentId);
      return;
    }
    // An inactive SourceView is unmounted. Activate first, then wait for its
    // command registration so a dirty draft is committed before exit.
    await tick();
    await sourceViewCommands.get(documentId)?.exit();
  }

  async function requestToggleSourceView(): Promise<void> {
    const documentId = opts.getActiveTabId();
    if (!documentId) return;
    if (sourceViewTabs.has(documentId)) {
      await sourceViewCommands.get(documentId)?.exit();
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

  function closeTabAndRecord(tabId: string): void {
    const tab = opts.getTabs().find((t) => t.id === tabId);
    // #864: warn before closing a scratchpad that has unsaved content. Annotations
    // are intentionally out of scope (accepted loss); only document text matters.
    if (tab && isScratchpadPath(tab.filePath)) {
      const uuid = scratchpadUuidFromPath(tab.filePath);
      if (uuid && opts.scratchpad.hasUnsavedContent(uuid)) {
        const ok = opts.confirm(
          "This scratchpad has unsaved content that will be lost. Close it anyway?",
        );
        if (!ok) return;
        // User accepted the loss — discard the recovery copy so the next
        // scratchpad open doesn't restore the content they just dismissed.
        opts.scratchpad.clearUnsaved(uuid);
      }
    }
    // #1021: warn before closing a tab with uncommitted markdown-source edits
    // (mirrors the #864 scratchpad confirm above). The disk file is intact — this
    // is loss of unsaved source-view work only.
    if (sourceDirtyTabs.has(tabId)) {
      const ok = opts.confirm(
        "This document has unsaved markdown-source edits that will be lost. Close it anyway?",
      );
      if (!ok) return;
    }
    if (tab && !isUploadPath(tab.filePath)) {
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
    opts.onTabClosed?.(tabId);
    opts.closeTab(tabId);
  }

  // Tab context-menu bulk closes (#923 Phase 2). The id lists are computed by
  // pure helpers (which guard against a stale right-clicked id closing every
  // tab) and snapshotted before the loop — closeTabAndRecord mutates the tab
  // list, so iterating live tabs would skip entries. Each close routes through
  // closeTabAndRecord so the scratchpad-unsaved guard + closed-tab stack apply.
  function closeOtherTabs(keepId: string): void {
    for (const id of tabIdsToCloseOthers(opts.getOrderedTabs(), keepId)) closeTabAndRecord(id);
  }

  function closeTabsToLeft(fromId: string): void {
    for (const id of tabIdsToCloseLeft(opts.getOrderedTabs(), fromId)) closeTabAndRecord(id);
  }

  function closeTabsToRight(fromId: string): void {
    for (const id of tabIdsToCloseRight(opts.getOrderedTabs(), fromId)) closeTabAndRecord(id);
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
    if (inflightReopens.has(rec.filePath)) return;
    inflightReopens.add(rec.filePath);
    const handleFailure = (reason: string) => {
      // Restore the record so the user can retry with another Ctrl+Alt+T;
      // silent drop would also surprise users who expect LIFO to be retryable.
      opts.closedTabStack.push(rec);
      const basename = crossBasename(rec.filePath) || rec.filePath;
      opts.pushNotification({
        id: `reopen-failed-${Date.now()}`,
        type: "general-error",
        severity: "error",
        message: `Couldn't reopen ${basename}: ${reason}`,
        dedupKey: `reopen-failed:${rec.filePath}`,
        timestamp: Date.now(),
      });
    };
    try {
      const result = await opts.openServerPath(rec.filePath);
      if (!result.ok) handleFailure(result.error);
    } finally {
      inflightReopens.delete(rec.filePath);
    }
  }

  // ---- save ----------------------------------------------------------------

  function pushSaveNotification(severity: SaveSeverity, message: string): void {
    opts.pushNotification({
      id: generateNotificationId(),
      type: "launcher",
      severity,
      message,
      timestamp: Date.now(),
    });
  }

  async function saveDocumentTargetAfterSourceCommit(
    tabId: string,
    intent: "save" | "save-as",
    expectedYdoc?: OpenTab["ydoc"],
  ): Promise<boolean> {
    const tab = opts.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || (expectedYdoc && tab.ydoc !== expectedYdoc)) return false;

    const needsPromotion = tab.source === "upload" || isUploadPath(tab.filePath);
    if (needsPromotion) {
      if (tab.readOnly) {
        pushSaveNotification("warning", "Not saved — this document is read-only.");
        return false;
      }
      return opts.triggerSaveAs({
        activeDocId: tab.id,
        defaultName: crossBasename(tab.filePath) || tab.filePath,
        sourceFormat: tab.format,
        notify: pushSaveNotification,
      });
    }

    if (intent === "save-as") {
      pushSaveNotification(
        "info",
        "Save As is for uploads and scratchpads; this document already saves to its file.",
      );
      return false;
    }
    return opts.triggerSave(tab.id);
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
      pushSaveNotification("warning", "No active document to save.");
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
