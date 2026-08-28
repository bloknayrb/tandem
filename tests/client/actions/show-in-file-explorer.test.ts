// @vitest-environment happy-dom

/**
 * Unit coverage for the "Show in file explorer" palette command registered by
 * `src/client/actions/builtin.svelte.ts` (#299).
 *
 * The action is registered with a *conditional spread* gated on
 * `isTauriRuntime()` — it exists in the registry only inside the Tauri desktop
 * runtime (detected via `window.__TAURI_INTERNALS__`). Registration is a
 * top-level side effect of importing the module, so we set the runtime sentinel
 * BEFORE the single dynamic import. A one-shot `vi.resetModules()` gives this
 * file its own module realm so the sentinel is observed at registration time
 * even though sibling action tests (e.g. launcher-commands) import the same
 * module without it. It is done ONCE, in `beforeAll`, not per test: each reset
 * re-runs the BUILTINS registration against the shared registry, and while
 * `{ replace: true }` makes that legal it also silently repoints every id at a
 * fresh realm's action objects, which the sibling suites are still holding.
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
import { makeActionDeps } from "./deps-bag.js";

const invokeSpy = vi.fn(async () => undefined);

// Mock the Tauri core invoke so the lazy `import("@tauri-apps/api/core")` in
// showInFileManager resolves to our spy instead of the real bridge.
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy }));

const ACTION_ID = "show-in-file-explorer";

/** `docPath` drives the enable/disable gate; `notify` is what the specs read.
 * `makeActionDeps` imports the `ActionDeps` TYPE only, so it pulls no executor
 * module into this file's pre-reset realm. */
function depsBag(
  docPath: string | null,
  notify: ReturnType<
    typeof vi.fn<(severity: "info" | "warning" | "error", message: string) => void>
  >,
) {
  return makeActionDeps({ getActiveDocumentPath: () => docPath, notify });
}

// Module seams captured once from an isolated import with the Tauri sentinel set.
let mountActionExecutor: (deps: ReturnType<typeof depsBag>) => { dispose(): void };
let getActionsMap: () => ReadonlyMap<string, Action>;
let executor: { dispose(): void } | null = null;

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  // Reset the module graph so builtin re-evaluates with the sentinel set — a
  // sibling action test may have imported it first (caching it without the
  // sentinel). resetModules + a single re-import is safe here: this file never
  // re-runs the registration loop a second time, so there is no id collision.
  vi.resetModules();
  // Imported for its side effect only — registration is a top-level statement
  // of the module body, and the sentinel above is what gates the action in.
  await import("../../../src/client/actions/builtin.svelte.js");
  const registry = await import("../../../src/client/actions/registry.svelte.js");
  // The executor seam MUST come from this same post-reset realm. `current` is
  // module-level state: a static import would bind the bag on the PRE-reset
  // executor module while the post-reset `builtin` reads a different instance's
  // `current`, so every action would report "before App mounted" and no-op —
  // and the two negative specs below would then pass vacuously while only the
  // positive one failed.
  const executorModule = await import("../../../src/client/actions/executor.js");
  mountActionExecutor = executorModule.mountActionExecutor as typeof mountActionExecutor;
  getActionsMap = registry.getActionsMap;
});

beforeEach(() => {
  invokeSpy.mockClear();
});

afterEach(() => {
  executor?.dispose();
  executor = null;
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
    const notify = vi.fn<(severity: "info" | "warning" | "error", message: string) => void>();
    executor = mountActionExecutor(depsBag("/home/user/project/notes.md", notify));

    const action = getActionsMap().get(ACTION_ID) as Action;
    action.run();
    await vi.waitFor(() => expect(invokeSpy).toHaveBeenCalled());

    expect(invokeSpy).toHaveBeenCalledWith("show_in_file_manager", {
      path: "/home/user/project/notes.md",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies and does NOT invoke when the doc has no on-disk path", async () => {
    const notify = vi.fn<(severity: "info" | "warning" | "error", message: string) => void>();
    executor = mountActionExecutor(depsBag(null, notify));

    const action = getActionsMap().get(ACTION_ID) as Action;
    action.run();
    // The null-path guard is synchronous; flush a microtask to be safe.
    await Promise.resolve();

    expect(invokeSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("warning", expect.stringContaining("isn't saved"));
  });

  it("notifies an error when the native invoke rejects", async () => {
    invokeSpy.mockRejectedValueOnce(new Error("explorer not found"));
    const notify = vi.fn<(severity: "info" | "warning" | "error", message: string) => void>();
    executor = mountActionExecutor(depsBag("/home/user/project/notes.md", notify));

    const action = getActionsMap().get(ACTION_ID) as Action;
    action.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("explorer not found"));
  });
});
