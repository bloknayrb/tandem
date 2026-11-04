import { describe, expect, it, vi } from "vitest";
import { resolveWithUndoToast } from "../../src/client/panels/resolve-with-undo-toast.js";
import type { TandemNotification } from "../../src/shared/types.js";

function setup(activeAtUndo: string | undefined, landed = true) {
  const pushed: Array<{ n: TandemNotification; action?: { label: string; onClick: () => void } }> =
    [];
  const resolve = vi.fn();
  const undo = vi.fn(() => true);
  const run = (id: string) =>
    resolveWithUndoToast(id, {
      resolve,
      undo,
      wasResolved: () => landed,
      push: (n, action) => pushed.push({ n, action }),
      docId: "doc-a",
      getActiveDocId: () => activeAtUndo,
    });
  return { pushed, resolve, undo, run };
}

describe("resolveWithUndoToast (#2360 margin Resolve)", () => {
  it("resolves, then offers an Undo toast that undoes that annotation", () => {
    const { pushed, resolve, undo, run } = setup("doc-a");
    run("c1");
    expect(resolve).toHaveBeenCalledWith("c1");
    expect(pushed).toHaveLength(1);
    expect(pushed[0].n).toMatchObject({ type: "annotation-resolved", severity: "info" });
    expect(pushed[0].action?.label).toBe("Undo");
    pushed[0].action?.onClick();
    expect(undo).toHaveBeenCalledWith("c1");
  });

  it("gives every resolve its own id and no dedupKey, so two Undos never coalesce", () => {
    const { pushed, run } = setup("doc-a");
    run("c1");
    run("c2");
    run("c1");
    const ids = new Set(pushed.map((p) => p.n.id));
    expect(ids.size).toBe(3);
    expect(pushed.every((p) => p.n.dedupKey === undefined)).toBe(true);
  });

  it("offers no toast when the write did not land (no Undo for someone else's dismissal)", () => {
    const { pushed, resolve, run } = setup("doc-a", false);
    run("c1");
    expect(resolve).toHaveBeenCalledWith("c1");
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
});
