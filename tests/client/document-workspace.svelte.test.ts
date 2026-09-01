/**
 * Behavioural contract for `createDocumentWorkspace` (ADR-035 Unit 10a).
 *
 * Three things this file is deliberately shaped around.
 *
 * **1. Effect run counts, not collection contents.** The four collections are
 * plain `$state(new Set()/new Map())`, which boxes the *reference*: only
 * `svelte/reactivity`'s `SvelteSet`/`SvelteMap` proxy mutations, and nothing in
 * `src/client/` imports those. A mutator rewritten to `.add(...)` would update
 * the data and notify nobody, so `expect(ws.sourceViewTabs.has(id)).toBe(true)`
 * passes with the bug present — a `Set` is a mutable reference and the test
 * holds the same one. Counting how many times an `$effect` re-ran is the only
 * assertion that separates a reassignment from an in-place mutation, so the
 * source-view specs assert the count alongside the membership.
 *
 * **2. Every harness owns a real `$effect.root`.** The factory installs a
 * `beforeunload` `$effect` internally, so calling it outside a root throws
 * `effect_orphan`. The root is created inside `harness()` and torn down by the
 * returned `dispose`, which is what lets an async spec await across it — the
 * root has to outlive the await, so a spec that disposed first would be
 * asserting against a dead reactive graph.
 *
 * **3. A root, not a fixture component.** `tsconfig.tests.client.json`'s own
 * header records that components under `tests/client/fixtures/` are typechecked
 * by *nothing* (bare `tsc` resolves `.svelte` through an ambient declaration,
 * and `svelte-check` only covers `src/client` + `src/shared`). A fixture is the
 * last resort here, not the default.
 */

import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { ClosedTabRecord } from "../../src/client/hooks/useClosedTabStack.svelte.js";
import {
  type CreateDocumentWorkspaceOpts,
  createDocumentWorkspace,
  type DocumentWorkspace,
} from "../../src/client/hooks/useDocumentWorkspace.svelte.js";
import type { OpenTab } from "../../src/client/types.js";

/**
 * A tab carrying only the fields this module reads. `ydoc` is compared for
 * identity and never dereferenced, and `provider` is untouched, so sentinels
 * keep the harness free of a Yjs/Hocuspocus mount.
 */
function tab(overrides: Partial<OpenTab> & { id: string }): OpenTab {
  return {
    filePath: `/docs/${overrides.id}.md`,
    fileName: `${overrides.id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
    ydoc: { id: overrides.id } as unknown as OpenTab["ydoc"],
    provider: {} as unknown as OpenTab["provider"],
    ...overrides,
  };
}

interface HarnessInit {
  tabs?: OpenTab[];
  activeTabId?: string | null;
  readOnly?: boolean;
  hasUnsaved?: boolean;
}

interface Harness {
  ws: DocumentWorkspace;
  /** Mutable so a spec can switch the active tab or flip read-only mid-test. */
  state: { tabs: OpenTab[]; activeTabId: string | null; readOnly: boolean };
  stack: ClosedTabRecord[];
  /** Queued confirm() answers, consumed in order. */
  confirmReplies: boolean[];
  calls: {
    closeTab: string[];
    setActiveTabId: string[];
    onTabClosed: string[];
    openServerPath: string[];
    triggerSave: string[];
    closeEditorOverlays: number;
    notifications: Record<string, unknown>[];
    scratchpadCleared: string[];
  };
  setOpenServerPathResult: (
    next: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) => void;
  dispose: () => void;
}

/**
 * Build a workspace over spy collaborators, inside its own effect root. `state`
 * is captured by reference and every `getX` reads it in its body — the same rule
 * the module's docblock states for `App.svelte`, and the reason a spec can flip
 * `activeTabId` mid-test and watch `inSourceView` follow.
 */
function harness(init: HarnessInit = {}): Harness {
  // These three must be `$state`, not a plain object. `canSourceView` and
  // `inSourceView` are `$derived.by`, and a derivation whose sources are inert
  // computes once and caches forever — the two specs below went green on a
  // stale value with a plain object here. Production is reactive for the same
  // reason: `getActiveTab` reads `App.svelte`'s `activeTab` `$derived`, which
  // reads `yjsSync`'s own `$state`. A harness that is inert where production is
  // reactive cannot see a derivation lose its dependency.
  let tabsState = $state(init.tabs ?? [tab({ id: "a" })]);
  let activeTabIdState = $state<string | null>(
    init.activeTabId === undefined ? "a" : init.activeTabId,
  );
  let readOnlyState = $state(init.readOnly ?? false);
  const state = {
    get tabs() {
      return tabsState;
    },
    set tabs(next: OpenTab[]) {
      tabsState = next;
    },
    get activeTabId() {
      return activeTabIdState;
    },
    set activeTabId(next: string | null) {
      activeTabIdState = next;
    },
    get readOnly() {
      return readOnlyState;
    },
    set readOnly(next: boolean) {
      readOnlyState = next;
    },
  };
  const stack: ClosedTabRecord[] = [];
  const confirmReplies: boolean[] = [];
  const calls: Harness["calls"] = {
    closeTab: [],
    setActiveTabId: [],
    onTabClosed: [],
    openServerPath: [],
    triggerSave: [],
    closeEditorOverlays: 0,
    notifications: [],
    scratchpadCleared: [],
  };
  let openServerPathResult: () => Promise<{ ok: true } | { ok: false; error: string }> = async () =>
    ({ ok: true }) as const;

  const opts: CreateDocumentWorkspaceOpts = {
    getTabs: () => state.tabs,
    getActiveTabId: () => state.activeTabId,
    getActiveTab: () => state.tabs.find((t) => t.id === state.activeTabId),
    getIsReadOnly: () => state.readOnly,
    getOrderedTabs: () => state.tabs,
    setActiveTabId: (id) => {
      calls.setActiveTabId.push(id);
      state.activeTabId = id;
    },
    closeTab: (id) => {
      calls.closeTab.push(id);
      state.tabs = state.tabs.filter((t) => t.id !== id);
    },
    closedTabStack: {
      push: (record) => {
        stack.push(record);
      },
      pop: () => stack.pop() ?? null,
    },
    scratchpad: {
      hasUnsavedContent: () => init.hasUnsaved ?? false,
      clearUnsaved: (uuid) => calls.scratchpadCleared.push(uuid),
    },
    openServerPath: (filePath) => {
      calls.openServerPath.push(filePath);
      return openServerPathResult();
    },
    triggerSave: async (id) => {
      calls.triggerSave.push(id);
      return true;
    },
    triggerSaveAs: async () => true,
    pushNotification: ((notification: Record<string, unknown>) => {
      calls.notifications.push(notification);
    }) as unknown as CreateDocumentWorkspaceOpts["pushNotification"],
    // Each spec queues its answers. An unqueued confirm throws rather than
    // defaulting, so a spec that stops reaching a guard fails instead of
    // quietly taking the accept branch.
    confirm: () => {
      const reply = confirmReplies.shift();
      if (reply === undefined) throw new Error("unexpected confirm()");
      return reply;
    },
    closeEditorOverlays: () => {
      calls.closeEditorOverlays += 1;
    },
    onTabClosed: (id) => calls.onTabClosed.push(id),
  };

  let ws!: DocumentWorkspace;
  const dispose = $effect.root(() => {
    ws = createDocumentWorkspace(opts);
  });

  return {
    ws,
    state,
    stack,
    confirmReplies,
    calls,
    setOpenServerPathResult: (next) => {
      openServerPathResult = next;
    },
    dispose,
  };
}

describe("createDocumentWorkspace — source view reactivity", () => {
  it("notifies on enter and exit, and re-runs a reader each time", () => {
    const h = harness();
    let runs = 0;
    let inView = false;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        inView = h.ws.sourceViewTabs.has("a");
      });
    });

    flushSync();
    expect(runs).toBe(1);
    expect(inView).toBe(false);

    h.ws.enterSourceView();
    flushSync();
    // The count is the assertion that matters: an `.add(...)` mutator leaves the
    // reference identical, so `inView` would still read true here while `runs`
    // stayed at 1 and every real consumer went stale.
    expect(runs).toBe(2);
    expect(inView).toBe(true);
    expect(h.calls.closeEditorOverlays).toBe(1);

    h.ws.exitSourceView("a");
    flushSync();
    expect(runs).toBe(3);
    expect(inView).toBe(false);

    stop();
    h.dispose();
  });

  it("isTabInSourceView stays reactive when destructured off the object", () => {
    // App passes this to DocumentTabs as a bare method reference
    // (`isTabInSourceView={documentWorkspace.isTabInSourceView}`), so the child
    // holds the function, not the object. Methods are ordinary closures and
    // survive that; only the GETTERS are destructure-unsafe. This spec is the
    // difference between knowing that and assuming it.
    const h = harness();
    const detached = h.ws.isTabInSourceView;
    let runs = 0;
    let seen = false;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        seen = detached("a");
      });
    });
    flushSync();
    expect(runs).toBe(1);
    expect(seen).toBe(false);

    h.ws.enterSourceView();
    flushSync();
    expect(runs).toBe(2);
    expect(seen).toBe(true);

    stop();
    h.dispose();
  });

  it("re-entering an already-open source view notifies nobody", () => {
    const h = harness();
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        void h.ws.sourceViewTabs.size;
      });
    });
    flushSync();

    h.ws.enterSourceView();
    flushSync();
    expect(runs).toBe(2);

    h.ws.enterSourceView();
    flushSync();
    // The early return must not reassign — a reassignment carrying identical
    // contents would still wake every consumer.
    expect(runs).toBe(2);
    expect(h.calls.closeEditorOverlays).toBe(1);

    stop();
    h.dispose();
  });

  it("updateSourceDraft marks dirty and clearing removes both draft and dirty entry", () => {
    const h = harness();
    let runs = 0;
    let dirtyCount = -1;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        dirtyCount = h.ws.sourceDirtyTabs.size;
      });
    });
    flushSync();
    expect(dirtyCount).toBe(0);

    h.ws.updateSourceDraft("a", "# hello", true);
    flushSync();
    expect(runs).toBe(2);
    expect(dirtyCount).toBe(1);
    expect(h.ws.sourceDrafts.get("a")).toBe("# hello");

    h.ws.clearSourceDraft("a");
    flushSync();
    expect(runs).toBe(3);
    expect(dirtyCount).toBe(0);
    expect(h.ws.sourceDrafts.has("a")).toBe(false);

    stop();
    h.dispose();
  });

  it("clearSourceDraft on a clean tab does not notify", () => {
    const h = harness();
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        void h.ws.sourceDirtyTabs.size;
      });
    });
    flushSync();
    expect(runs).toBe(1);

    h.ws.clearSourceDraft("a");
    flushSync();
    expect(runs).toBe(1);

    stop();
    h.dispose();
  });

  it("exitSourceView discards the tab's in-progress draft", () => {
    const h = harness();
    h.ws.enterSourceView();
    h.ws.updateSourceDraft("a", "half-typed", true);
    flushSync();
    expect(h.ws.sourceDirtyTabs.has("a")).toBe(true);

    h.ws.exitSourceView("a");
    flushSync();
    // Returning to WYSIWYG abandons the draft. Leaving it behind would make the
    // beforeunload guard fire for a document the user is no longer editing.
    expect(h.ws.sourceDrafts.has("a")).toBe(false);
    expect(h.ws.sourceDirtyTabs.has("a")).toBe(false);

    h.dispose();
  });

  it("updateSourceDraft(dirty: false) drops the draft rather than storing the clean text", () => {
    const h = harness();
    h.ws.updateSourceDraft("a", "draft", true);
    flushSync();
    expect(h.ws.sourceDirtyTabs.has("a")).toBe(true);

    h.ws.updateSourceDraft("a", "clean", false);
    flushSync();
    expect(h.ws.sourceDrafts.has("a")).toBe(false);
    expect(h.ws.sourceDirtyTabs.has("a")).toBe(false);

    h.dispose();
  });
});

describe("createDocumentWorkspace — canSourceView / inSourceView", () => {
  it("canSourceView is false for a non-markdown tab and for a read-only one", () => {
    const h = harness({ tabs: [tab({ id: "a" }), tab({ id: "d", format: "docx" })] });
    expect(h.ws.canSourceView).toBe(true);

    h.state.activeTabId = "d";
    expect(h.ws.canSourceView).toBe(false);

    h.state.activeTabId = "a";
    h.state.readOnly = true;
    expect(h.ws.canSourceView).toBe(false);

    h.dispose();
  });

  it("inSourceView tracks the ACTIVE tab, not merely whether any tab is in source view", () => {
    const h = harness({ tabs: [tab({ id: "a" }), tab({ id: "b" })] });
    h.ws.enterSourceViewTarget("a");
    flushSync();
    expect(h.ws.inSourceView).toBe(true);

    h.state.activeTabId = "b";
    // Tab "a" is still in source view; "b" is not. A derivation keyed on
    // `sourceViewTabs.size` rather than the active id would answer true.
    expect(h.ws.inSourceView).toBe(false);
    expect(h.ws.isTabInSourceView("a")).toBe(true);

    h.dispose();
  });

  it("enterSourceView refuses a read-only markdown tab", () => {
    const h = harness({ readOnly: true });
    h.ws.enterSourceView();
    flushSync();
    expect(h.ws.sourceViewTabs.has("a")).toBe(false);
    expect(h.calls.closeEditorOverlays).toBe(0);
    h.dispose();
  });

  it("enterSourceViewTarget refuses read-only, non-markdown and unknown ids", () => {
    const h = harness({
      tabs: [tab({ id: "ro", readOnly: true }), tab({ id: "d", format: "docx" })],
      activeTabId: "ro",
    });
    h.ws.enterSourceViewTarget("ro");
    h.ws.enterSourceViewTarget("d");
    h.ws.enterSourceViewTarget("missing");
    flushSync();
    expect(h.ws.sourceViewTabs.size).toBe(0);
    // A refused target must not steal activation either.
    expect(h.calls.setActiveTabId).toEqual([]);
    h.dispose();
  });
});

describe("createDocumentWorkspace — source view commands", () => {
  it("toggling an open source view exits through the registered command", async () => {
    const h = harness();
    const exit = vi.fn(async () => {
      h.ws.exitSourceView("a");
    });
    h.ws.enterSourceView();
    h.ws.updateSourceViewCommands("a", { documentId: "a", save: async () => true, exit });
    flushSync();

    await h.ws.requestToggleSourceView();
    flushSync();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(h.ws.inSourceView).toBe(false);

    // Toggling again enters rather than exiting.
    await h.ws.requestToggleSourceView();
    flushSync();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(h.ws.inSourceView).toBe(true);

    h.dispose();
  });

  it("requestToggleSourceViewTarget activates the target before acting on it", async () => {
    const h = harness({ tabs: [tab({ id: "a" }), tab({ id: "b" })] });
    await h.ws.requestToggleSourceViewTarget("b");
    flushSync();
    expect(h.calls.setActiveTabId).toEqual(["b", "b"]);
    expect(h.ws.isTabInSourceView("b")).toBe(true);

    h.dispose();
  });

  it("requestToggleSourceViewTarget refuses a read-only target without activating it", async () => {
    const h = harness({ tabs: [tab({ id: "a" }), tab({ id: "ro", readOnly: true })] });
    await h.ws.requestToggleSourceViewTarget("ro");
    flushSync();
    expect(h.calls.setActiveTabId).toEqual([]);
    expect(h.ws.isTabInSourceView("ro")).toBe(false);

    h.dispose();
  });

  it("sourceCommandsForEvent resolves via the container's documentId dataset", () => {
    const h = harness();
    const commands = { documentId: "a", save: async () => true, exit: async () => {} };
    h.ws.updateSourceViewCommands("a", commands);

    const container = document.createElement("div");
    container.setAttribute("data-testid", "source-view-container");
    container.dataset.documentId = "a";
    const target = document.createElement("textarea");
    container.appendChild(target);
    document.body.appendChild(container);

    expect(h.ws.sourceCommandsForEvent({ target } as unknown as KeyboardEvent)).toBe(commands);

    // An event outside any source-view container resolves to null rather than
    // falling back to the active tab's commands.
    const stray = document.createElement("input");
    document.body.appendChild(stray);
    expect(h.ws.sourceCommandsForEvent({ target: stray } as unknown as KeyboardEvent)).toBeNull();

    h.ws.updateSourceViewCommands("a", null);
    expect(h.ws.sourceCommandsForEvent({ target } as unknown as KeyboardEvent)).toBeNull();

    container.remove();
    stray.remove();
    h.dispose();
  });
});

describe("createDocumentWorkspace — the close funnel", () => {
  it("closes, records to the stack, and evicts scroll memory before the close lands", () => {
    const h = harness();
    h.ws.closeTabAndRecord("a");
    expect(h.calls.closeTab).toEqual(["a"]);
    expect(h.calls.onTabClosed).toEqual(["a"]);
    expect(h.stack).toEqual([{ filePath: "/docs/a.md", closedAt: expect.any(Number) }]);
    h.dispose();
  });

  it("does not record an upload-backed tab — it has no path to reopen", () => {
    const h = harness({
      tabs: [tab({ id: "u", filePath: "upload://u/doc.md", source: "upload" })],
      activeTabId: "u",
    });
    h.ws.closeTabAndRecord("u");
    expect(h.calls.closeTab).toEqual(["u"]);
    expect(h.stack).toEqual([]);
    h.dispose();
  });

  it("a declined scratchpad confirm aborts the close entirely", () => {
    const h = harness({
      tabs: [
        tab({ id: "s", filePath: "upload://scratchpad/uuid-1/Scratchpad.md", source: "upload" }),
      ],
      activeTabId: "s",
      hasUnsaved: true,
    });
    h.confirmReplies.push(false);
    h.ws.closeTabAndRecord("s");
    expect(h.calls.closeTab).toEqual([]);
    expect(h.calls.onTabClosed).toEqual([]);
    expect(h.calls.scratchpadCleared).toEqual([]);
    h.dispose();
  });

  it("an accepted scratchpad confirm closes and discards the recovery copy", () => {
    const h = harness({
      tabs: [
        tab({ id: "s", filePath: "upload://scratchpad/uuid-1/Scratchpad.md", source: "upload" }),
      ],
      activeTabId: "s",
      hasUnsaved: true,
    });
    h.confirmReplies.push(true);
    h.ws.closeTabAndRecord("s");
    expect(h.calls.closeTab).toEqual(["s"]);
    expect(h.calls.scratchpadCleared).toEqual(["uuid-1"]);
    h.dispose();
  });

  it("a declined source-dirty confirm aborts; an accepted one closes and clears the draft", () => {
    const h = harness();
    h.ws.updateSourceDraft("a", "unsaved", true);
    flushSync();

    h.confirmReplies.push(false);
    h.ws.closeTabAndRecord("a");
    expect(h.calls.closeTab).toEqual([]);
    expect(h.ws.sourceDirtyTabs.has("a")).toBe(true);

    h.confirmReplies.push(true);
    h.ws.closeTabAndRecord("a");
    flushSync();
    expect(h.calls.closeTab).toEqual(["a"]);
    expect(h.ws.sourceDirtyTabs.has("a")).toBe(false);
    expect(h.ws.sourceDrafts.has("a")).toBe(false);

    h.dispose();
  });

  it("bulk closes snapshot the id list before the loop mutates the tab list", () => {
    const h = harness({
      tabs: [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })],
      activeTabId: "b",
    });
    h.ws.closeOtherTabs("b");
    // Iterating the live list would skip "c" once "a" was removed.
    expect([...h.calls.closeTab].sort()).toEqual(["a", "c"]);
    h.dispose();
  });

  it("closeTabsToLeft and closeTabsToRight close only their side", () => {
    const left = harness({ tabs: [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })] });
    left.ws.closeTabsToLeft("c");
    expect([...left.calls.closeTab].sort()).toEqual(["a", "b"]);
    left.dispose();

    const right = harness({ tabs: [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })] });
    right.ws.closeTabsToRight("a");
    expect([...right.calls.closeTab].sort()).toEqual(["b", "c"]);
    right.dispose();
  });
});

describe("createDocumentWorkspace — reopen", () => {
  it("activates an already-open tab instead of asking the server", async () => {
    const h = harness({ tabs: [tab({ id: "a" })] });
    h.stack.push({ filePath: "/docs/a.md", closedAt: 1 });

    await h.ws.reopenClosedTab();
    expect(h.calls.setActiveTabId).toEqual(["a"]);
    expect(h.calls.openServerPath).toEqual([]);
    h.dispose();
  });

  it("reopens through the server when the path is no longer open", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    h.stack.push({ filePath: "/docs/gone.md", closedAt: 1 });
    await h.ws.reopenClosedTab();
    expect(h.calls.openServerPath).toEqual(["/docs/gone.md"]);
    expect(h.calls.notifications).toEqual([]);
    h.dispose();
  });

  it("a failed reopen restores the record and notifies with a dedupKey", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    h.setOpenServerPathResult(async () => ({ ok: false, error: "ENOENT" }));
    h.stack.push({ filePath: "/docs/gone.md", closedAt: 1 });

    await h.ws.reopenClosedTab();
    // Restored so another Ctrl+Alt+T retries the same path — a silent drop
    // would make the LIFO stack lie about what is still retryable.
    expect(h.stack).toEqual([{ filePath: "/docs/gone.md", closedAt: 1 }]);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      type: "general-error",
      severity: "error",
      dedupKey: "reopen-failed:/docs/gone.md",
    });
    h.dispose();
  });

  it("two concurrent reopens of the same path make one server call", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setOpenServerPathResult(async () => {
      await gate;
      return { ok: true };
    });
    h.stack.push({ filePath: "/docs/x.md", closedAt: 1 });
    h.stack.push({ filePath: "/docs/x.md", closedAt: 2 });

    const first = h.ws.reopenClosedTab();
    const second = h.ws.reopenClosedTab();
    release?.();
    await Promise.all([first, second]);

    // The second pop yields the same path while the first request is still in
    // flight; `inflightReopens` is what stops the duplicate open.
    expect(h.calls.openServerPath).toEqual(["/docs/x.md"]);
    h.dispose();
  });

  it("an empty stack is a silent no-op", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    await h.ws.reopenClosedTab();
    expect(h.calls.openServerPath).toEqual([]);
    expect(h.calls.setActiveTabId).toEqual([]);
    h.dispose();
  });
});

describe("createDocumentWorkspace — save entry points", () => {
  it("warns rather than throwing when there is no active document", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    await h.ws.saveDocumentTarget(null, "save");
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      type: "launcher",
      severity: "warning",
      message: "No active document to save.",
    });
    h.dispose();
  });

  it("saves a plain file tab in place", async () => {
    const h = harness();
    await h.ws.saveDocumentTarget("a", "save");
    expect(h.calls.triggerSave).toEqual(["a"]);
    h.dispose();
  });

  it("Save As on an already-on-disk document explains rather than silently doing nothing", async () => {
    const h = harness();
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("a", "save-as");
    expect(ok).toBe(false);
    expect(h.calls.triggerSave).toEqual([]);
    expect(h.calls.notifications[0]).toMatchObject({ severity: "info" });
    h.dispose();
  });

  it("refuses to promote a read-only upload and says why", async () => {
    const h = harness({
      tabs: [tab({ id: "u", filePath: "upload://u/doc.md", source: "upload", readOnly: true })],
      activeTabId: "u",
    });
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("u", "save");
    expect(ok).toBe(false);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message: "Not saved — this document is read-only.",
    });
    h.dispose();
  });

  it("refuses to save a tab whose ydoc was swapped out from under it", async () => {
    const h = harness();
    const staleYdoc = { id: "stale" } as unknown as OpenTab["ydoc"];
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("a", "save", staleYdoc);
    // The tab id still resolves; the incarnation does not. Saving here would
    // write one document's content over another's file.
    expect(ok).toBe(false);
    expect(h.calls.triggerSave).toEqual([]);
    h.dispose();
  });

  it("refuses a tab id that no longer resolves", async () => {
    const h = harness();
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("missing", "save");
    expect(ok).toBe(false);
    expect(h.calls.triggerSave).toEqual([]);
    h.dispose();
  });
});
