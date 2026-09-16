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
  /**
   * Display order, which in production is `useTabOrder`'s reordered list and is
   * NOT the document order `getTabs` returns. Defaulting the two to the same
   * array made the distinction untestable: `getOrderedTabs` could be swapped
   * for `getTabs` in the source and every bulk-close spec stayed green.
   */
  orderedTabs?: OpenTab[];
  /**
   * Reopen post-condition poll (#1708 item 6). Forwarded into the opts literal
   * so a spec can reach the timeout path in milliseconds instead of the real
   * 8-second ceiling.
   */
  reopenPollMs?: number;
  reopenTimeoutMs?: number;
}

interface Harness {
  ws: DocumentWorkspace;
  /** Mutable so a spec can switch the active tab or flip read-only mid-test. */
  state: { tabs: OpenTab[]; activeTabId: string | null; readOnly: boolean };
  stack: ClosedTabRecord[];
  /** Queued confirm() answers, consumed in order. */
  confirmReplies: boolean[];
  calls: {
    saveAsArgs: { activeDocId: string; defaultName: string; sourceFormat: string }[];
    /**
     * Every collaborator call in order, as `"name:arg"`. The per-collaborator
     * arrays below answer "did it happen"; only this one answers "in what
     * order", which is what a title like "evicts scroll memory BEFORE the close
     * lands" actually claims.
     */
    log: string[];
    closeTab: string[];
    setActiveTabId: string[];
    onTabClosed: string[];
    openServerPath: string[];
    triggerSave: string[];
    /**
     * `triggerSave`'s SECOND argument, kept in its own array (#1708 item 3).
     * Six specs assert `calls.triggerSave` is a bare `string[]`, so pushing a
     * tuple into that one fails all of them.
     */
    triggerSaveOpts: unknown[];
    closeEditorOverlays: number;
    notifications: Record<string, unknown>[];
    scratchpadCleared: string[];
  };
  setOpenServerPathResult: (
    next: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>,
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
    saveAsArgs: [],
    log: [],
    closeTab: [],
    setActiveTabId: [],
    onTabClosed: [],
    openServerPath: [],
    triggerSave: [],
    triggerSaveOpts: [],
    closeEditorOverlays: 0,
    notifications: [],
    scratchpadCleared: [],
  };
  let openServerPathResult: (
    filePath: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }> = async (filePath) => {
    // The default must DELIVER a tab, not merely accept the open (#1708 item
    // 6): production's `{ ok: true }` is followed by the tab arriving over Yjs,
    // and the workspace now waits for it. A stub that never delivers one puts
    // every pre-existing reopen spec on the new timeout path.
    state.tabs = [...state.tabs, tab({ id: filePath, filePath })];
    return { ok: true } as const;
  };

  const opts: CreateDocumentWorkspaceOpts = {
    getTabs: () => state.tabs,
    getActiveTabId: () => state.activeTabId,
    getActiveTab: () => state.tabs.find((t) => t.id === state.activeTabId),
    getIsReadOnly: () => state.readOnly,
    getOrderedTabs: () => init.orderedTabs ?? state.tabs,
    setActiveTabId: (id) => {
      calls.setActiveTabId.push(id);
      state.activeTabId = id;
    },
    closeTab: (id) => {
      calls.log.push(`closeTab:${id}`);
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
      return openServerPathResult(filePath);
    },
    triggerSave: async (id, saveOpts) => {
      calls.triggerSave.push(id);
      calls.triggerSaveOpts.push(saveOpts);
      return true;
    },
    triggerSaveAs: async (args) => {
      calls.saveAsArgs.push({
        activeDocId: args.activeDocId,
        defaultName: args.defaultName,
        sourceFormat: args.sourceFormat,
      });
      return true;
    },
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
    onTabClosed: (id) => {
      calls.log.push(`onTabClosed:${id}`);
      calls.onTabClosed.push(id);
    },
    reopenPollMs: init.reopenPollMs,
    reopenTimeoutMs: init.reopenTimeoutMs,
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
    // The run count is here for a reason the membership assertions cannot cover:
    // `enterSourceViewTarget` also calls `setActiveTabId`, and that write alone
    // dirties `inSourceView`. So a version of the mutator that mutated the Set
    // in place would still read `true` below — the derivation recomputes for the
    // *other* dependency and picks the value off the mutated Set. Only a reader
    // of `sourceViewTabs` itself can see the missing notification.
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        void h.ws.sourceViewTabs.size;
      });
    });
    flushSync();
    expect(runs).toBe(1);

    h.ws.enterSourceViewTarget("a");
    flushSync();
    expect(runs).toBe(2);
    expect(h.ws.inSourceView).toBe(true);

    h.state.activeTabId = "b";
    // Tab "a" is still in source view; "b" is not. A derivation keyed on
    // `sourceViewTabs.size` rather than the active id would answer true.
    expect(h.ws.inSourceView).toBe(false);
    expect(h.ws.isTabInSourceView("a")).toBe(true);

    stop();
    h.dispose();
  });

  it("enterSourceView refuses a read-only markdown tab", () => {
    const h = harness({ readOnly: true });
    h.ws.enterSourceView();
    flushSync();
    expect(h.ws.sourceViewTabs.has("a")).toBe(false);
    expect(h.calls.closeEditorOverlays).toBe(0);
    // #1708 item 5 notifies from `requestToggleSourceView` — the ungated
    // shortcut path — and NOT from this private step, which every visible
    // affordance already gates on `canSourceView`. Silence here is what proves
    // the message lives in the toggle rather than in the entry itself.
    expect(h.calls.notifications).toEqual([]);
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
    // Deliberately silent: this one is behind a gated menu item (#1708 item 5).
    expect(h.calls.notifications).toEqual([]);
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
    // Silent by design: the target twin is reached from a gated menu, so only
    // the keyboard-driven active-tab toggle explains the rule (#1708 item 5).
    expect(h.calls.notifications).toEqual([]);

    h.dispose();
  });

  it("registering and clearing commands notifies, it does not mutate the Map in place", () => {
    const h = harness();
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        // Reading through the public `sourceCommandsForEvent` would not do:
        // that is a plain Map lookup and tracks nothing. The dependency has to
        // be the boxed collection, which only the exported reader reaches.
        void h.ws.sourceViewCommandCount;
      });
    });
    flushSync();
    expect(runs).toBe(1);

    h.ws.updateSourceViewCommands("a", {
      documentId: "a",
      save: async () => true,
      exit: async () => {},
    });
    flushSync();
    expect(runs).toBe(2);
    expect(h.ws.sourceViewCommandCount).toBe(1);

    h.ws.updateSourceViewCommands("a", null);
    flushSync();
    expect(runs).toBe(3);
    expect(h.ws.sourceViewCommandCount).toBe(0);

    stop();
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

  // #1708 item 4. Both toggles optional-chained `…get(id)?.exit()`, so an
  // unregistered id resolved normally and left the user in source view with
  // nothing said.
  it("says so when an exit finds no registered source-view commands", async () => {
    const h = harness();
    h.ws.enterSourceView();
    flushSync();

    await h.ws.requestToggleSourceView();
    flushSync();

    expect(h.ws.isTabInSourceView("a")).toBe(true);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message: "Couldn't leave source view — the Markdown source editor was still loading.",
      dedupKey: "source-view-exit:a",
    });
    h.dispose();
  });

  it("waits a tick for a remounting SourceView to register before giving up", async () => {
    // The discriminating spec for the added `await tick()`. `App.svelte` keys
    // SourceView on `{#key activeTab.id}`, so registration can land one
    // microtask after the toggle; without the wait the lookup returns null and
    // a perfectly healthy exit reports "still loading" instead of exiting.
    const h = harness();
    const exit = vi.fn(async () => {
      h.ws.exitSourceView("a");
    });
    h.ws.enterSourceView();
    flushSync();
    void Promise.resolve().then(() => {
      h.ws.updateSourceViewCommands("a", { documentId: "a", save: async () => true, exit });
    });

    await h.ws.requestToggleSourceView();
    flushSync();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(h.calls.notifications).toEqual([]);
    h.dispose();
  });

  // #1708 item 5: every VISIBLE affordance is gated on `canSourceView`, but
  // Ctrl+Shift+E is not, so the shortcut was a dead key on a document that can
  // never show source view.
  it("explains that source view is Markdown-only when the shortcut is pressed", async () => {
    const h = harness({ tabs: [tab({ id: "d", format: "docx" })], activeTabId: "d" });

    await h.ws.requestToggleSourceView();
    await h.ws.requestToggleSourceView();
    flushSync();

    expect(h.ws.sourceViewTabs.size).toBe(0);
    expect(h.calls.notifications).toHaveLength(2);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "info",
      message: "Source view is only available for Markdown documents.",
      dedupKey: "source-view-unavailable:not-markdown:d",
    });
    // Both presses carry ONE key, which is what makes a held shortcut a single
    // tray row. The stub records every push — dedup itself lives in
    // `useNotifications`, so asserting a count of 1 would assert something this
    // harness cannot deliver.
    expect(h.calls.notifications.map((n) => n.dedupKey)).toEqual([
      "source-view-unavailable:not-markdown:d",
      "source-view-unavailable:not-markdown:d",
    ]);
    h.dispose();
  });

  it("explains that a read-only Markdown document has no source view", async () => {
    // `harness({ readOnly: true })`, not `tab({ readOnly: true })`:
    // `canSourceView` reads `getIsReadOnly()`, which the harness decouples from
    // the tab's own flag, so the tab-level version never fires.
    const h = harness({ readOnly: true });

    await h.ws.requestToggleSourceView();
    flushSync();

    expect(h.ws.sourceViewTabs.size).toBe(0);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "info",
      message: "Source view isn't available — this document is read-only.",
      dedupKey: "source-view-unavailable:read-only:a",
    });
    h.dispose();
  });

  it("tells a read-only NON-markdown tab the rule it can never satisfy", async () => {
    // The only case that can fail on a wrong guard order: both conditions hold.
    // Read-only-first answers "this document is read-only", implying that
    // making the file writable would enable source view — which the format gate
    // never will. The other two cases pass under either ordering.
    const h = harness({ readOnly: true, tabs: [tab({ id: "a", format: "docx" })] });

    await h.ws.requestToggleSourceView();
    flushSync();

    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "info",
      message: "Source view is only available for Markdown documents.",
      dedupKey: "source-view-unavailable:not-markdown:a",
    });
    h.dispose();
  });
});

describe("createDocumentWorkspace — the close funnel", () => {
  it("closes, records to the stack, and evicts scroll memory before the close lands", () => {
    const h = harness();
    h.ws.closeTabAndRecord("a");
    // The ordered log, not the two per-collaborator arrays: this title claims a
    // sequence, and swapping the two calls left every previous assertion green.
    // App evicts scroll memory keyed by tab id, so it must run while the tab is
    // still a tab.
    expect(h.calls.log).toEqual(["onTabClosed:a", "closeTab:a"]);
    expect(h.stack).toEqual([{ filePath: "/docs/a.md", closedAt: expect.any(Number) }]);
    h.dispose();
  });

  it("evicting the closed tab's source-view flag notifies, it does not mutate in place", () => {
    const h = harness();
    h.ws.enterSourceView();
    flushSync();
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs = runs + 1;
        void h.ws.sourceViewTabs.size;
      });
    });
    flushSync();
    expect(runs).toBe(1);

    h.ws.closeTabAndRecord("a");
    flushSync();
    // No spec read `sourceViewTabs` after a close before this one, so the
    // funnel's own eviction could mutate the boxed Set in place and stay green.
    expect(runs).toBe(2);
    expect(h.ws.sourceViewTabs.has("a")).toBe(false);

    stop();
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

  it("declining the source-dirty confirm after accepting the scratchpad one keeps the recovery copy", () => {
    // cr-1: a scratchpad (format "md", so source-viewable) with unsaved
    // scratchpad content AND unsaved source-view edits hits both guards. The
    // first confirm accepts the scratchpad loss; the second declines and must
    // still abort the close — and must NOT have already discarded the
    // scratchpad's localStorage recovery copy, or a later crash loses content
    // the user explicitly chose not to close.
    const h = harness({
      tabs: [
        tab({ id: "s", filePath: "upload://scratchpad/uuid-1/Scratchpad.md", source: "upload" }),
      ],
      activeTabId: "s",
      hasUnsaved: true,
    });
    h.ws.updateSourceDraft("s", "half-typed", true);
    flushSync();
    expect(h.ws.sourceDirtyTabs.has("s")).toBe(true);

    h.confirmReplies.push(true, false);
    const result = h.ws.closeTabAndRecord("s");

    expect(result).toBe(false);
    expect(h.calls.closeTab).toEqual([]);
    expect(h.calls.onTabClosed).toEqual([]);
    // The load-bearing assertion: the accepted-then-declined sequence must not
    // have cleared the recovery copy.
    expect(h.calls.scratchpadCleared).toEqual([]);
    expect(h.ws.sourceDirtyTabs.has("s")).toBe(true);

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

  it("bulk closes follow DISPLAY order, not document order", () => {
    // `useTabOrder` reorders tabs independently of the document list, so these
    // two must not be the same array. With the harness defaulting them to one
    // list, swapping `getOrderedTabs()` for `getTabs()` in the source passed
    // every bulk-close spec.
    const tabs = [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })];
    const h = harness({ tabs, orderedTabs: [tabs[2], tabs[1], tabs[0]] });
    h.ws.closeTabsToLeft("a");
    // Display order is c, b, a — so "left of a" is c and b, which is the exact
    // opposite of what document order would give.
    expect([...h.calls.closeTab].sort()).toEqual(["b", "c"]);
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

  // #1824 item H: before this fix the three bulk-close loops had no `break`,
  // so Cancel on one dirty tab still prompted for (and closed) the rest of
  // the batch. Cancel must abort the whole remaining batch.
  it("Cancel on the 2nd of 3 dirty tabs aborts the rest of the bulk close", () => {
    const h = harness({
      tabs: [tab({ id: "keep" }), tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })],
      activeTabId: "keep",
    });
    // All three drop into the source-dirty confirm branch inside
    // closeTabAndRecord.
    h.ws.updateSourceDraft("a", "unsaved a", true);
    h.ws.updateSourceDraft("b", "unsaved b", true);
    h.ws.updateSourceDraft("c", "unsaved c", true);
    flushSync();

    // accept a, decline b — c must never even prompt.
    h.confirmReplies.push(true, false);
    h.ws.closeOtherTabs("keep");

    expect(h.calls.closeTab).toEqual(["a"]);
    expect(h.confirmReplies).toEqual([]); // both queued replies were consumed, none left for "c"
    h.dispose();
  });

  // #1708 item 7: an unresolvable id used to skip both confirms and the stack
  // push and then run the rest of the funnel anyway — draft cleanup,
  // `onTabClosed` and `closeTab`, all on a tab that was not there.
  it("a tab id that no longer resolves runs NO part of the funnel", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    // Keyed by the GHOST id on purpose: `clearSourceDraft(tabId)` was the first
    // side effect to run, so this is what fails when the guard is placed after
    // the side effects rather than before them.
    h.ws.updateSourceDraft("ghost", "half-typed", true);
    flushSync();

    // `true`, not `false`: `false` means "the user cancelled" and
    // `closeEachUntilCancelled` breaks on it.
    expect(h.ws.closeTabAndRecord("ghost")).toBe(true);

    expect(h.calls.closeTab).toEqual([]);
    expect(h.calls.onTabClosed).toEqual([]);
    expect(h.stack).toEqual([]);
    expect(h.ws.sourceDrafts.has("ghost")).toBe(true);
    // The log is the only evidence a developer gets. It does not notify: a
    // ghost id is not a state the user can cause, so a toast would name one
    // that does not exist.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("ghost");
    expect(h.calls.notifications).toEqual([]);

    warn.mockRestore();
    h.dispose();
  });

  it("a ghost id in the middle of a bulk close does not truncate the batch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const keep = tab({ id: "keep" });
    const a = tab({ id: "a" });
    const c = tab({ id: "c" });
    // `orderedTabs` is what the bulk closes iterate and `getTabs()` is what the
    // funnel resolves against; only the harness lets them diverge, which is
    // what makes the guard reachable at all. Returning `false` for the ghost
    // would `break` the batch there and leave "c" open.
    const h = harness({
      tabs: [keep, a, c],
      orderedTabs: [keep, a, tab({ id: "ghost" }), c],
      activeTabId: "keep",
    });

    h.ws.closeOtherTabs("keep");

    expect(h.calls.closeTab).toEqual(["a", "c"]);
    warn.mockRestore();
    h.dispose();
  });
});

describe("createDocumentWorkspace — the beforeunload guard", () => {
  // The single thing standing between a page reload and uncommitted markdown
  // source edits. The file header names it as the reason the harness needs an
  // effect root, and then nothing fired it until this block.
  function fireBeforeUnload(): { prevented: boolean; returnValue: unknown } {
    const ev = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, returnValue: ev.returnValue };
  }

  it("stays silent with no dirty drafts", () => {
    const h = harness();
    flushSync();
    expect(fireBeforeUnload().prevented).toBe(false);
    h.dispose();
  });

  it("prevents the unload once a draft is dirty", () => {
    const h = harness();
    h.ws.updateSourceDraft("a", "unsaved", true);
    flushSync();
    const { prevented, returnValue } = fireBeforeUnload();
    expect(prevented).toBe(true);
    expect(returnValue).toBe("You have unsaved markdown-source edits.");
    h.dispose();
  });

  it("goes quiet again once the draft is cleared", () => {
    const h = harness();
    h.ws.updateSourceDraft("a", "unsaved", true);
    flushSync();
    h.ws.clearSourceDraft("a");
    flushSync();
    // A guard that nags after the work is committed trains users to click
    // through it, which is the same as not having one.
    expect(fireBeforeUnload().prevented).toBe(false);
    h.dispose();
  });

  it("unregisters the listener on dispose", () => {
    const h = harness();
    h.ws.updateSourceDraft("a", "unsaved", true);
    flushSync();
    h.dispose();
    // A leaked listener fires the dialog from a torn-down workspace, which in
    // the app means a reload nagging about a document that is no longer open.
    expect(fireBeforeUnload().prevented).toBe(false);
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
    h.setOpenServerPathResult(async (filePath) => {
      await gate;
      h.state.tabs = [...h.state.tabs, tab({ id: filePath, filePath })];
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

  it("a deduped concurrent reopen puts its record back on the stack", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setOpenServerPathResult(async (filePath) => {
      await gate;
      h.state.tabs = [...h.state.tabs, tab({ id: filePath, filePath })];
      return { ok: true };
    });
    h.stack.push({ filePath: "/docs/x.md", closedAt: 1 });
    h.stack.push({ filePath: "/docs/x.md", closedAt: 2 });

    const first = h.ws.reopenClosedTab();
    const second = h.ws.reopenClosedTab();
    release?.();
    await Promise.all([first, second]);

    // The stack dedups only CONSECUTIVE duplicates, so close X / close Y /
    // close X really does hold the same path twice. Dropping the popped record
    // made the user's next Ctrl+Alt+T a silent no-op with the entry gone.
    expect(h.stack).toEqual([{ filePath: "/docs/x.md", closedAt: 1 }]);
    h.dispose();
  });

  it("says the reopen is already running when a second press lands during the wait", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setOpenServerPathResult(async (filePath) => {
      await gate;
      h.state.tabs = [...h.state.tabs, tab({ id: filePath, filePath })];
      return { ok: true };
    });
    h.stack.push({ filePath: "/docs/x.md", closedAt: 1 });
    h.stack.push({ filePath: "/docs/x.md", closedAt: 2 });

    const first = h.ws.reopenClosedTab();
    const second = h.ws.reopenClosedTab();
    release?.();
    await Promise.all([first, second]);

    // Review round 1. Item 6's post-condition poll holds `inflightReopens` for
    // as long as the reopen ceiling rather than just the HTTP round trip, so
    // this branch is what the user's second Ctrl+Alt+T hits while nothing has
    // appeared yet. It restored the record and returned in SILENCE — the same
    // dead key the rest of #1708 exists to remove, inside #1708's own new code.
    // The end-of-wait warning cannot cover it: that reports the first attempt,
    // and a user who gives up before the ceiling never sees anything at all.
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      type: "launcher",
      // `info`, not `warning`: the reopen really is running.
      severity: "info",
      message: "Still reopening x.md…",
      // Its own key. The end-of-wait arm uses `reopen-no-tab:`, and the tray
      // coalesces on the key — a shared one would drop one of the two reports.
      dedupKey: "reopen-inflight:/docs/x.md",
    });
    h.dispose();
  });

  // Review round 1: the poll is the one await in this module long enough to
  // straddle an ErrorBoundary recovery (`Root.svelte` wraps `<App/>`, and its
  // "Try to recover" is a real production remount). Every collaborator the
  // failure arm touches belongs to the instance that just died.
  it("stops polling and writes nothing once the workspace is torn down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness({
      tabs: [],
      activeTabId: null,
      reopenPollMs: 1,
      // A ceiling this spec must never reach. It is what makes the teardown
      // bail testable at all: drop it and the await below runs for a minute and
      // fails on the test timeout. Without it, a poll that simply ran to
      // completion would be silenced by the `disposed` guard on `handleFailure`
      // and look identical to a pass.
      reopenTimeoutMs: 60_000,
    });
    // Accepted, but no tab ever arrives — the arm that waits out the ceiling.
    h.setOpenServerPathResult(async () => ({ ok: true }));
    h.stack.push({ filePath: "/docs/gone.md", closedAt: 1 });
    // The latch is an `$effect` teardown, so the effect must have RUN before
    // disposing the root can fire it.
    flushSync();

    const pending = h.ws.reopenClosedTab();
    h.dispose();
    await pending;

    expect(h.calls.notifications).toEqual([]);
    // Not restored either: an ErrorBoundary remount has already recreated the
    // stack empty (`useClosedTabStack` — "lifetime is the app session"), so the
    // push would land on a destroyed instance nobody can see.
    expect(h.stack).toEqual([]);
    // Presence, not absence: this is what proves the failure arm was REACHED
    // and chose a console trace, rather than the spec passing because the wait
    // silently never finished.
    expect(warn.mock.calls.map((args) => args.join(" ")).join("\n")).toContain("/docs/gone.md");
    warn.mockRestore();
  });

  it("a thrown openServerPath is handled like a returned failure", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    h.setOpenServerPathResult(async () => {
      throw new Error("network down");
    });
    h.stack.push({ filePath: "/docs/gone.md", closedAt: 1 });

    await expect(h.ws.reopenClosedTab()).resolves.toBeUndefined();
    // `openServerPath` became an INJECTED dependency in Unit 10a, and its type
    // says it never throws. A type is not an enforcement: without a catch, a
    // throw skips the restore, loses the record with no toast, and escapes as
    // an unhandled rejection through App's `void reopenClosedTab()` sites.
    expect(h.stack).toEqual([{ filePath: "/docs/gone.md", closedAt: 1 }]);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "error",
      dedupKey: "reopen-failed:/docs/gone.md",
    });
    h.dispose();
  });

  it("an empty stack is a silent no-op", async () => {
    const h = harness({ tabs: [], activeTabId: null });
    await h.ws.reopenClosedTab();
    expect(h.calls.openServerPath).toEqual([]);
    expect(h.calls.setActiveTabId).toEqual([]);
    h.dispose();
  });

  // #1708 item 6: `{ ok: true }` means the server ACCEPTED the open, not that a
  // tab arrived. The record was already popped, so a server-side no-op used to
  // take the user's next Ctrl+Alt+T with it, silently.
  it("reports an accepted reopen that never produced a tab, and keeps the record", async () => {
    const h = harness({
      tabs: [],
      activeTabId: null,
      reopenPollMs: 1,
      reopenTimeoutMs: 5,
    });
    h.setOpenServerPathResult(async () => ({ ok: true }));
    h.stack.push({ filePath: "/docs/gone.md", closedAt: 1 });

    await h.ws.reopenClosedTab();

    expect(h.stack).toEqual([{ filePath: "/docs/gone.md", closedAt: 1 }]);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      type: "general-error",
      // One severity BELOW the two failure specs above, which assert "error":
      // the server took the open and the tab may still land, so a late arrival
      // turns the restored record into an activate rather than a second open.
      // A byte-copy of `handleFailure` lands "error" with nothing objecting.
      severity: "warning",
      message: "Couldn't reopen gone.md: the server accepted it but no tab appeared.",
      dedupKey: "reopen-no-tab:/docs/gone.md",
    });
    h.dispose();
  });

  it("stays silent when the reopened tab does arrive", async () => {
    const h = harness({
      tabs: [],
      activeTabId: null,
      reopenPollMs: 1,
      reopenTimeoutMs: 5,
    });
    h.stack.push({ filePath: "/docs/gone.md", closedAt: 1 });

    await h.ws.reopenClosedTab();

    expect(h.calls.notifications).toEqual([]);
    expect(h.stack).toEqual([]);
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

  it("refuses to save a tab whose ydoc was swapped out from under it, and says so", async () => {
    const h = harness();
    const staleYdoc = { id: "stale" } as unknown as OpenTab["ydoc"];
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("a", "save", staleYdoc);
    // The tab id still resolves; the incarnation does not. Saving here would
    // write one document's content over another's file.
    expect(ok).toBe(false);
    expect(h.calls.triggerSave).toEqual([]);
    // #1708 item 2: this was the one refusal in the function that said nothing,
    // while its three siblings all notified.
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message:
        "Not saved — the document reloaded while saving; your last edit was not written to the file.",
      // Asserted as an EXACT string, because this is the half that pins the
      // split from item 1's `save-target:tab-changed:a`. The tray coalesces on
      // the key and keeps the newer message, so a copy-paste of item 1's key
      // would let the milder copy overwrite the only message reporting lost
      // work — and a message-only assertion cannot see that.
      dedupKey: "save-commit:ydoc-swapped:a",
    });
    h.dispose();
  });

  it("saving an INACTIVE source-view tab routes through its command, not straight to disk", async () => {
    // The discriminating case, and the reason the per-id binding matters. Tab
    // "b" is in source view; "a" is active. `isSourceView` is bound per-id
    // (`sourceViewTabs.has(id)`), so saving "b" must activate it and hand off to
    // its registered command, which commits the draft first.
    //
    // Bind it to the active-tab-wide `inSourceView` instead — an easy and
    // plausible mistake — and "b" takes the formatted branch, `triggerSave`
    // writes the pre-commit content, and whatever the user just typed is gone
    // with no error. `tabs/target-save.ts` has its own specs, but they run
    // against their own mock deps and structurally cannot see this module's
    // bindings.
    const h = harness({ tabs: [tab({ id: "a" }), tab({ id: "b" })], activeTabId: "a" });
    let committed = 0;
    h.ws.enterSourceViewTarget("b");
    h.state.activeTabId = "a";
    h.ws.updateSourceViewCommands("b", {
      documentId: "b",
      save: async () => {
        committed += 1;
        return true;
      },
      exit: async () => {},
    });
    flushSync();

    // Reset the call log AFTER setup. `enterSourceViewTarget` activates "b"
    // itself, so a `toContain("b")` below would be satisfied by that earlier
    // call and pass with the save path's own activate step deleted — which is
    // exactly what a mutation run showed.
    h.calls.setActiveTabId.length = 0;

    await h.ws.saveDocumentTarget("b", "save");
    expect(committed).toBe(1);
    expect(h.calls.triggerSave).toEqual([]);
    // It must activate the target itself: an unmounted SourceView has no
    // commands registered, so saving without activating cannot commit.
    expect(h.calls.setActiveTabId).toEqual(["b"]);
    h.dispose();
  });

  it("a formatted tab persists directly, without waiting on any command", async () => {
    const h = harness();
    await h.ws.saveDocumentTarget("a", "save");
    // The other side of the same branch: no source view, so no commit hop.
    expect(h.calls.triggerSave).toEqual(["a"]);
    h.dispose();
  });

  it("promotes an upload through Save As with a basename, not the whole path", async () => {
    const h = harness({
      tabs: [tab({ id: "u", filePath: "upload://u/nested/doc.md", source: "upload" })],
      activeTabId: "u",
    });
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("u", "save");
    expect(ok).toBe(true);
    // The stub used to record nothing, so nothing asserted the envelope: a
    // regression here pre-fills the Save As dialog with `upload://u/nested/doc.md`
    // as the filename.
    expect(h.calls.saveAsArgs).toEqual([
      { activeDocId: "u", defaultName: "doc.md", sourceFormat: "md" },
    ]);
    h.dispose();
  });

  it("refuses a tab id that no longer resolves, and says so", async () => {
    const h = harness();
    const ok = await h.ws.saveDocumentTargetAfterSourceCommit("missing", "save");
    expect(ok).toBe(false);
    expect(h.calls.triggerSave).toEqual([]);
    // The other half of the split guard (#1708 item 2). Same sentence and same
    // key as item 1's `no-such-tab` refusal — two sites emitting the SAME
    // message may share a key; two different messages may not.
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message: "Not saved — that document is no longer open.",
      dedupKey: "save-target:no-such-tab:missing",
    });
    h.dispose();
  });

  // #1708 item 1: `saveDocumentTarget` awaited `saveExactTarget` and dropped its
  // boolean, so all four of its refusals were silent. One message per reason.
  it("names a save target that no longer resolves", async () => {
    const h = harness();
    await h.ws.saveDocumentTarget("ghost", "save");
    expect(h.calls.triggerSave).toEqual([]);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message: "Not saved — that document is no longer open.",
      dedupKey: "save-target:no-such-tab:ghost",
    });
    h.dispose();
  });

  it("names a tab replaced across the source-view activation hop", async () => {
    const h = harness();
    h.ws.enterSourceView();
    flushSync();

    // The activation `tick()` is the window: the save suspends there, and the
    // tab list is rebuilt with a new ydoc while it waits. Swapping BEFORE the
    // call would make the pre-activation snapshot read the new tab and the
    // guard would never fire.
    const saving = h.ws.saveDocumentTarget("a", "save");
    h.state.tabs = [tab({ id: "a", ydoc: { id: "reborn" } as unknown as OpenTab["ydoc"] })];
    await saving;

    expect(h.calls.triggerSave).toEqual([]);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message: "Not saved — the document reloaded while saving.",
      dedupKey: "save-target:tab-changed:a",
    });
    h.dispose();
  });

  it("names an unmounted source editor rather than saving nothing", async () => {
    const h = harness();
    h.ws.enterSourceView();
    flushSync();
    // No `updateSourceViewCommands`: the SourceView never registered, so the
    // draft cannot be committed and the save must not proceed — nor be silent.
    await h.ws.saveDocumentTarget("a", "save");

    expect(h.calls.triggerSave).toEqual([]);
    expect(h.calls.notifications).toHaveLength(1);
    expect(h.calls.notifications[0]).toMatchObject({
      severity: "warning",
      message: "Not saved — the Markdown source editor wasn't ready yet.",
      dedupKey: "save-target:no-source-commands:a",
    });
    h.dispose();
  });

  it("stays silent when the source view's own save declines", async () => {
    const h = harness();
    h.ws.enterSourceView();
    h.ws.updateSourceViewCommands("a", {
      documentId: "a",
      save: async () => false,
      exit: async () => {},
    });
    flushSync();

    await h.ws.saveDocumentTarget("a", "save");

    // SourceView reports its own refusals (an on-screen error strip, or a save
    // that is already visibly running). The issue's weaker suggestion — "at
    // minimum an error toast on `false`" — would double-report here.
    expect(h.calls.notifications).toEqual([]);
    h.dispose();
  });

  it("asks triggerSave to announce a busy save — every caller here is a gesture", async () => {
    // #1708 item 3. `triggerSave` is silent on re-entry unless `announceBusy` is
    // passed, and the injected type could not carry it, so Ctrl+S during an
    // in-flight save was a dead key. Widening the type without passing the flag
    // typechecks and changes nothing, which is what this assertion kills.
    const h = harness();
    await h.ws.saveDocumentTarget("a", "save");
    expect(h.calls.triggerSave).toEqual(["a"]);
    expect(h.calls.triggerSaveOpts).toEqual([{ announceBusy: true }]);
    h.dispose();
  });
});
