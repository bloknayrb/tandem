// @vitest-environment happy-dom

/**
 * Unit coverage for the "Show in file explorer" palette command registered by
 * `src/client/actions/builtin.svelte.ts` (#299).
 *
 * The action is registered with a *conditional spread* gated on
 * `isTauriRuntime()` — it exists in the registry only inside the Tauri desktop
 * runtime (detected via `window.__TAURI_INTERNALS__`). Registration is a
 * top-level side effect of importing the module, so we set the runtime sentinel
 * BEFORE the single dynamic import. `vi.isolateModulesAsync` gives this file its
 * own module realm so the sentinel is observed at registration time even though
 * sibling action tests (e.g. launcher-commands) import the same module without
 * it. We do NOT call `vi.resetModules()` per-test — re-running the BUILTINS
 * registration loop against a shared registry throws on id collision.
 *
 * The Tauri-vs-browser *gating* (action present on desktop, hidden in the
 * browser) is asserted by the Playwright/claude-in-chrome E2E recipe for #299,
 * not here — toggling the sentinel across a shared module realm is what the
 * isolated import above avoids.
 *
 * `showInFileManager` is module-private; we reach it through the registered
 * action's `run()`. The `@tauri-apps/api/core` `invoke` is mocked so we assert
 * the command name + `{ path }` payload without a real Tauri bridge.
 *
 * NOTE: the *actual* OS reveal (Explorer / Finder / file-manager opening)
 * cannot be auto-verified — that requires a manual desktop check.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "../../../src/client/actions/registry.svelte.js";

const invokeSpy = vi.fn(async () => undefined);

// Mock the Tauri core invoke so the lazy `import("@tauri-apps/api/core")` in
// showInFileManager resolves to our spy instead of the real bridge.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy }));

const ACTION_ID = "show-in-file-explorer";

/** Build the full ActionDeps bag. `docPath` drives the enable/disable gate. */
function depsBag(docPath: string | null, notify: ReturnType<typeof vi.fn>) {
  return {
    getActiveTabId: () => "doc-1",
    getActiveDocumentPath: () => docPath,
    notify,
    openSettings: vi.fn(),
    openSettingsModal: vi.fn(),
    toggleSoloMode: vi.fn(),
    openFindBar: vi.fn(),
    openFindBarTabs: vi.fn(),
    findNext: vi.fn(),
    findPrev: vi.fn(),
    closeActiveTab: vi.fn(),
    openFileDialog: vi.fn(),
    toggleLeftPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    reopenClosedTab: vi.fn(),
    annotationNext: vi.fn(),
    annotationPrev: vi.fn(),
    annotationAccept: vi.fn(),
    annotationDismiss: vi.fn(),
    selectBlock: vi.fn(),
    toggleAuthorship: vi.fn(),
    saveAs: vi.fn(async () => {}),
  };
}

// Module seams captured once from an isolated import with the Tauri sentinel set.
let wireActionDeps: (deps: ReturnType<typeof depsBag>) => void;
let getActionsMap: () => ReadonlyMap<string, Action>;

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // Reset the module graph so builtin re-evaluates with the sentinel set — a
  // sibling action test may have imported it first (caching it without the
  // sentinel). resetModules + a single re-import is safe here: this file never
  // re-runs the registration loop a second time, so there is no id collision.
  vi.resetModules();
  const builtin = await import("../../../src/client/actions/builtin.svelte.js");
  const registry = await import("../../../src/client/actions/registry.svelte.js");
  wireActionDeps = builtin.wireActionDeps;
  getActionsMap = registry.getActionsMap;
});

beforeEach(() => {
  invokeSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("show-in-file-explorer — run behavior", () => {
  it("registers under the document group in the Tauri runtime", () => {
    const action = getActionsMap().get(ACTION_ID);
    expect(action, "action should register inside Tauri").toBeDefined();
    expect(action?.group).toBe("document");
    expect(action?.label).toBe("Show in file explorer");
  });

  it("invokes show_in_file_manager with the active document path", async () => {
    const notify = vi.fn();
    wireActionDeps(depsBag("/home/user/project/notes.md", notify));

    const action = getActionsMap().get(ACTION_ID) as Action;
    action.run();
    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalled());

    expect(invokeSpy).toHaveBeenCalledWith("show_in_file_manager", {
      path: "/home/user/project/notes.md",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies and does NOT invoke when the doc has no on-disk path", async () => {
    const notify = vi.fn();
    wireActionDeps(depsBag(null, notify));

    const action = getActionsMap().get(ACTION_ID) as Action;
    action.run();
    // The null-path guard is synchronous; flush a microtask to be safe.
    await Promise.resolve();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("warning", expect.stringContaining("isn't saved"));
  });

  it("notifies an error when the native invoke rejects", async () => {
    invokeSpy.mockRejectedValueOnce(new Error("explorer not found"));
    const notify = vi.fn();
    wireActionDeps(depsBag("/home/user/project/notes.md", notify));

    const action = getActionsMap().get(ACTION_ID) as Action;
    action.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("explorer not found"));
  });
});
