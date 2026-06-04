/**
 * #999 (#923 Phase 3) — the shared gesture singleton + refcounted Tauri listener that
 * routes `context-menu-action` events into the right-clicked card's dispatch. Covers the
 * security/svelte review concerns: last-writer-wins across panels, null-guard on a forged
 * event with no gesture, and idempotent refcounted teardown (no underflow → no dead menu).
 *
 * The Tauri runtime + event bus are mocked: `listen` captures the registered handler so a
 * test can fire an action; `__TAURI_INTERNALS__` makes `isTauriRuntime()` true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let capturedHandler: ((e: { payload?: { id?: string } }) => void) | null = null;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (e: { payload?: { id?: string } }) => void) => {
    capturedHandler = handler;
    return Promise.resolve(unlisten);
  }),
}));

import {
  __resetAnnotationContextMenuHostForTest,
  runAnnotationAction,
  setAnnotationGesture,
  subscribeAnnotationActions,
} from "../../src/client/panels/annotation-context-menu-host.js";
import type { Annotation, AnnotationStatus } from "../../src/shared/types.js";

function ann(
  type: Annotation["type"],
  author: Annotation["author"],
  status: AnnotationStatus = "pending",
  content = "body",
): Annotation {
  return {
    id: "a1",
    author,
    range: { start: 0, end: 1 },
    content,
    status,
    timestamp: 0,
    type,
  } as Annotation;
}

/** Subscribe and wait for the dynamic import("@tauri-apps/api/event") + listen() to land. */
async function subscribeAndSettle(): Promise<() => void> {
  const off = subscribeAnnotationActions();
  await vi.waitFor(() => expect(capturedHandler).not.toBeNull());
  return off;
}

function fire(id: string): void {
  capturedHandler?.({ payload: { id } });
}

beforeEach(() => {
  // @ts-expect-error — test shim to flip isTauriRuntime() true.
  globalThis.window = { __TAURI_INTERNALS__: {} };
  capturedHandler = null;
  vi.clearAllMocks(); // clears listen + unlisten call history (keeps implementations)
  __resetAnnotationContextMenuHostForTest();
});

afterEach(() => {
  // @ts-expect-error — clean up the shim.
  globalThis.window = undefined;
});

describe("annotation-context-menu-host", () => {
  it("routes a valid action id into the current gesture's run", async () => {
    const off = await subscribeAndSettle();
    const run = vi.fn();
    setAnnotationGesture({ run });

    fire("ctx:annotation:accept");
    expect(run).toHaveBeenCalledWith("ctx:annotation:accept");

    off();
  });

  it("drops non-annotation ids (editor/tab cross-delivery)", async () => {
    const off = await subscribeAndSettle();
    const run = vi.fn();
    setAnnotationGesture({ run });

    fire("ctx:tab:close");
    fire("ctx:link:open");
    expect(run).not.toHaveBeenCalled();

    off();
  });

  it("last-writer-wins: the most recent right-click's gesture handles the action", async () => {
    const off = await subscribeAndSettle();
    const first = vi.fn();
    const second = vi.fn();
    setAnnotationGesture({ run: first });
    setAnnotationGesture({ run: second }); // a second right-click overwrites

    fire("ctx:annotation:remove");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("ctx:annotation:remove");

    off();
  });

  it("null-guards a forged event that arrives with no gesture", async () => {
    const off = await subscribeAndSettle();
    // No setAnnotationGesture call.
    expect(() => fire("ctx:annotation:remove")).not.toThrow();
    off();
  });

  it("refcount: two subscribers share one listener; it survives the first unsubscribe", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const off1 = await subscribeAndSettle();
    const off2 = subscribeAnnotationActions(); // refCount 2, no new listen()
    expect(listen).toHaveBeenCalledTimes(1);

    off1();
    expect(unlisten).not.toHaveBeenCalled(); // still mounted via off2

    // The listener still routes after the first unsubscribe.
    const run = vi.fn();
    setAnnotationGesture({ run });
    fire("ctx:annotation:edit");
    expect(run).toHaveBeenCalledWith("ctx:annotation:edit");

    off2();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("teardown is idempotent — a double cleanup cannot underflow the refcount", async () => {
    const off1 = await subscribeAndSettle();
    const off2 = subscribeAnnotationActions();

    off1();
    off1(); // double cleanup of the SAME subscription — must be a no-op
    expect(unlisten).not.toHaveBeenCalled(); // off2 still holds the refcount

    off2();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("no-op outside the Tauri runtime (browser keeps its native menu)", () => {
    // @ts-expect-error — drop the Tauri shim.
    globalThis.window = {};
    const off = subscribeAnnotationActions();
    expect(typeof off).toBe("function");
    off(); // must not throw
  });
});

describe("runAnnotationAction (shared re-validating dispatcher)", () => {
  function handlers() {
    return {
      accept: vi.fn(),
      dismiss: vi.fn(),
      sendToClaude: vi.fn(),
      remove: vi.fn(),
      openEdit: vi.fn(),
      openReply: vi.fn(),
    };
  }

  it("routes each action to its handler when the predicate holds", () => {
    const h = handlers();
    runAnnotationAction("ctx:annotation:accept", ann("comment", "claude"), h);
    runAnnotationAction("ctx:annotation:dismiss", ann("comment", "claude"), h);
    runAnnotationAction("ctx:annotation:sendToClaude", ann("note", "user"), h);
    runAnnotationAction("ctx:annotation:remove", ann("highlight", "user"), h);
    runAnnotationAction("ctx:annotation:edit", ann("note", "user"), h);
    runAnnotationAction("ctx:annotation:reply", ann("comment", "claude"), h);
    expect(h.accept).toHaveBeenCalledWith("a1");
    expect(h.dismiss).toHaveBeenCalledWith("a1");
    expect(h.sendToClaude).toHaveBeenCalledWith("a1");
    expect(h.remove).toHaveBeenCalledWith("a1");
    expect(h.openEdit).toHaveBeenCalledWith("a1");
    expect(h.openReply).toHaveBeenCalledWith("a1");
  });

  it("re-validates: drops an action the LIVE annotation no longer qualifies for", () => {
    const h = handlers();
    // Resolved → accept/dismiss gated off (stale menu held open across resolution).
    runAnnotationAction("ctx:annotation:accept", ann("comment", "claude", "accepted"), h);
    expect(h.accept).not.toHaveBeenCalled();
    // remove on a claude comment → canRemove false (the client gate for the gateless POST).
    runAnnotationAction("ctx:annotation:remove", ann("comment", "claude"), h);
    expect(h.remove).not.toHaveBeenCalled();
    // edit on an import note → canEdit false.
    runAnnotationAction("ctx:annotation:edit", ann("note", "import"), h);
    expect(h.openEdit).not.toHaveBeenCalled();
  });

  it("copy writes the body to the clipboard; missing handlers are a safe no-op", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error — minimal clipboard shim for jsdom.
    globalThis.navigator = { clipboard: { writeText } };
    runAnnotationAction("ctx:annotation:copy", ann("note", "user", "pending", "secret"), {});
    expect(writeText).toHaveBeenCalledWith("secret");
  });
});
