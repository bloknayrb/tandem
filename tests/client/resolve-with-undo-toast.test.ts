import { describe, expect, it, vi } from "vitest";
import { resolveWithUndoToast } from "../../src/client/panels/resolve-with-undo-toast.js";
import type { TandemNotification } from "../../src/shared/types.js";

/**
 * A stateful fake of the record store, mirroring the real `resolveAnnotation`:
 * it writes `dismissed` only over a `pending` record and is otherwise a silent
 * no-op. A stub that always "lands" would never exercise the guard.
 */
function setup(activeAtUndo: string | undefined, initial: Record<string, string> = {}) {
  const status = new Map<string, string>(
    Object.entries({ c1: "pending", c2: "pending", ...initial }),
  );
  const pushed: Array<{ n: TandemNotification; action?: { label: string; onClick: () => void } }> =
    [];
  const resolve = vi.fn((id: string) => {
    if (status.get(id) === "pending") status.set(id, "dismissed");
  });
  const undo = vi.fn((id: string) => {
    if (status.get(id) === "pending" || !status.has(id)) return false;
    status.set(id, "pending");
    return true;
  });
  const run = (id: string) =>
    resolveWithUndoToast(id, {
      resolve,
      undo,
      getStatus: (i) => status.get(i),
      push: (n, action) => pushed.push({ n, action }),
      docId: "doc-a",
      getActiveDocId: () => activeAtUndo,
    });
  return { pushed, resolve, undo, run, status };
}

describe("resolveWithUndoToast (#2360 margin Resolve)", () => {
  it("resolves, then offers an Undo toast that undoes that annotation", () => {
    const { pushed, resolve, undo, run, status } = setup("doc-a");
    run("c1");
    expect(resolve).toHaveBeenCalledWith("c1");
    expect(pushed).toHaveLength(1);
    expect(pushed[0].n).toMatchObject({ type: "annotation-resolved", severity: "info" });
    expect(pushed[0].action?.label).toBe("Undo");
    pushed[0].action?.onClick();
    expect(undo).toHaveBeenCalledWith("c1");
    expect(status.get("c1")).toBe("pending");
  });

  it("gives every resolve its own id and no dedupKey, so two Undos never coalesce", () => {
    const { pushed, run } = setup("doc-a", { c3: "pending" });
    run("c1");
    run("c2");
    run("c3");
    expect(new Set(pushed.map((p) => p.n.id)).size).toBe(3);
    expect(pushed.every((p) => p.n.dedupKey === undefined)).toBe(true);
  });

  it("a comment Claude already dismissed: no toast, and nothing for Undo to reopen", () => {
    const { pushed, run, status } = setup("doc-a", { c1: "dismissed" });
    run("c1");
    expect(pushed).toEqual([]);
    expect(status.get("c1")).toBe("dismissed");
  });

  it("a double click toasts once", () => {
    const { pushed, run } = setup("doc-a");
    run("c1");
    run("c1");
    expect(pushed).toHaveLength(1);
  });

  it("Undo after the comment was removed says so, not that it changed", () => {
    const { pushed, run, status } = setup("doc-a");
    run("c1");
    status.delete("c1"); // removed from the side panel's resolved list
    pushed[0].action?.onClick();
    expect(pushed[1].n.message).toBe("That comment was removed.");
  });

  it("a missing record yields no toast", () => {
    const { pushed, run } = setup("doc-a");
    run("gone");
    expect(pushed).toEqual([]);
  });

  it("declines after a tab switch and says so, instead of undoing in the wrong document", () => {
    const { pushed, undo, run } = setup("doc-b");
    run("c1");
    pushed[0].action?.onClick();
    expect(undo).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(2);
    expect(pushed[1].n.message).toMatch(/switch back/i);
  });

  it("a failed Undo says so instead of closing silently", () => {
    const { pushed, undo, run } = setup("doc-a");
    run("c1");
    // Still resolved, but the undo itself declines (its text changed). A removed
    // record has its own message, pinned above.
    undo.mockReturnValueOnce(false);
    pushed[0].action?.onClick();
    expect(pushed).toHaveLength(2);
    expect(pushed[1].n.message).toMatch(/couldn't undo/i);
  });
});
