/**
 * A full `ActionDeps` bag for the action tests.
 *
 * Four suites need one (`executor`, `launcher-commands`, `save-outcome`,
 * `show-in-file-explorer`) and each only cares about two or three members, but
 * the bag has to be *complete*: `buildFacade` wraps `Object.keys(deps)`, so a
 * member left out of a hand-written literal is simply absent from the facade
 * and the action body calling it throws a TypeError instead of failing the
 * assertion it was written for. One builder keeps that impossible, and makes a
 * 27th dependency a one-line change here rather than four copies to find.
 *
 * Deliberately lives under `tests/client/` rather than `tests/helpers/`: the
 * type it imports resolves through `registry.svelte.ts`, whose runes only have
 * ambient declarations in the client typecheck program.
 *
 * The import is TYPE-ONLY and must stay that way — `show-in-file-explorer`
 * captures its executor seam from an isolated post-`vi.resetModules()` realm,
 * and a runtime import here would load a second copy of that module's
 * `current` cell into every file that uses this builder.
 */

import { vi } from "vitest";
import type { ActionDeps } from "../../../src/client/actions/executor.js";

/** Every member is a distinguishable spy; pass `overrides` for the ones a spec
 * actually asserts on (typically `notify` plus an active-document path).
 *
 * The three members typed `() => void | Promise<void>` default to ASYNC spies,
 * not bare `vi.fn()`: their promise arm is the one the executor has to await,
 * and a synchronous default would exercise only the arm that cannot fail. */
export function makeActionDeps(overrides: Partial<ActionDeps> = {}): ActionDeps {
  return {
    getActiveTabId: () => "doc-1",
    getActiveDocumentPath: () => "/home/user/notes.md",
    notify: vi.fn(),
    afterLauncherAction: vi.fn(),
    openSettings: vi.fn(),
    toggleSoloMode: vi.fn(),
    openFindBar: vi.fn(),
    openFindBarTabs: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
    closeActiveTab: vi.fn(),
    openFileDialog: vi.fn(async () => {}),
    toggleLeftPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    reopenClosedTab: vi.fn(async () => {}),
    annotationNext: vi.fn(),
    annotationPrev: vi.fn(),
    annotationAccept: vi.fn(),
    annotationDismiss: vi.fn(),
    selectBlock: vi.fn(),
    toggleAuthorship: vi.fn(),
    toggleFormattingBar: vi.fn(),
    toggleSourceView: vi.fn(async () => {}),
    focusChat: vi.fn(),
    save: vi.fn(async () => {}),
    saveAs: vi.fn(async () => {}),
    ...overrides,
  };
}
