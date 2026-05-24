import { describe, expect, it } from "vitest";
import { resolveActiveTabId } from "../../src/client/hooks/tab-reconcile.js";

// Pure decision logic extracted from yjsSync's handleDocumentList so the
// activation-epoch gate can be tested without a live Hocuspocus provider.
// Background: the server's active doc id is broadcast on every reconcile, but a
// local (keyboard/click) tab switch is NOT propagated to the server. A stale
// CRDT re-broadcast of an unchanged active id must NOT clobber the local switch;
// a genuine (re)activation — signalled by an advanced epoch — must apply.

describe("resolveActiveTabId", () => {
  const serverIds = new Set(["a", "b", "c"]);

  it("preserves a local switch when the server re-broadcasts an unchanged active (stale replay = the flake)", () => {
    // User pressed Ctrl+1 → local active = "a". A late per-tab sync re-broadcasts
    // the server's active "c" with the SAME epoch already applied.
    const next = resolveActiveTabId({
      prev: "a",
      serverActiveId: "c",
      serverIds,
      removedCount: 0,
      serverEpoch: 3,
      lastAppliedEpoch: 3,
    });
    expect(next).toBe("a");
  });

  it("applies the server active when the epoch advances (genuine re-activation / re-open focus-steal = F1)", () => {
    // Same shape as above but the epoch advanced — Claude re-opened "c", an
    // intentional focus event that must move the active tab.
    const next = resolveActiveTabId({
      prev: "a",
      serverActiveId: "c",
      serverIds,
      removedCount: 0,
      serverEpoch: 4,
      lastAppliedEpoch: 3,
    });
    expect(next).toBe("c");
  });

  it("applies the server active on first reconcile (prev === null)", () => {
    const next = resolveActiveTabId({
      prev: null,
      serverActiveId: "c",
      serverIds,
      removedCount: 0,
      serverEpoch: 3,
      lastAppliedEpoch: null,
    });
    expect(next).toBe("c");
  });

  it("follows the server when the locally-active tab was removed, regardless of epoch", () => {
    const next = resolveActiveTabId({
      prev: "z", // not in serverIds — was closed
      serverActiveId: "c",
      serverIds,
      removedCount: 1,
      serverEpoch: 3,
      lastAppliedEpoch: 3, // epoch unchanged, but we must still follow
    });
    expect(next).toBe("c");
  });

  it("keeps the current tab when another tab closed and the server active equals the current tab", () => {
    const next = resolveActiveTabId({
      prev: "b",
      serverActiveId: "b",
      serverIds,
      removedCount: 1,
      serverEpoch: 3,
      lastAppliedEpoch: 3,
    });
    expect(next).toBe("b");
  });

  it("applies a genuine switch to a different doc (epoch advanced)", () => {
    const next = resolveActiveTabId({
      prev: "a",
      serverActiveId: "b",
      serverIds,
      removedCount: 0,
      serverEpoch: 5,
      lastAppliedEpoch: 4,
    });
    expect(next).toBe("b");
  });

  it("treats a null lastAppliedEpoch as an advance (epoch differs)", () => {
    const next = resolveActiveTabId({
      prev: "a",
      serverActiveId: "c",
      serverIds,
      removedCount: 0,
      serverEpoch: 1,
      lastAppliedEpoch: null,
    });
    expect(next).toBe("c");
  });
});
