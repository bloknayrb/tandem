import { describe, expect, it, vi } from "vitest";
import { saveExactTarget } from "../../src/client/tabs/target-save";

type Target = { id: string; generation: object };

function setup(sourceView: boolean, intent: "save" | "save-as" = "save") {
  const target: Target = { id: "doc-a", generation: {} };
  let live: Target | null = target;
  const commands = { save: vi.fn(async () => true) };
  const saveCommitted = vi.fn(async () => true);
  const activateTarget = vi.fn();
  const onRefused = vi.fn();
  const deps = {
    tabId: "doc-a",
    intent,
    resolveTarget: () => live,
    isSameTarget: (before: Target, after: Target) => before.generation === after.generation,
    isSourceView: () => sourceView,
    activateTarget,
    afterActivate: vi.fn(async () => {}),
    getSourceCommands: (): typeof commands | null => commands,
    saveCommitted,
    onRefused,
  };
  return {
    deps,
    target,
    commands,
    saveCommitted,
    activateTarget,
    onRefused,
    setLive: (next: Target | null) => (live = next),
  };
}

describe("saveExactTarget", () => {
  it("activates a source-view target and delegates commit ordering to its commands", async () => {
    const { deps, commands, saveCommitted, activateTarget } = setup(true);
    await expect(saveExactTarget(deps)).resolves.toBe(true);
    expect(activateTarget).toHaveBeenCalledWith("doc-a");
    expect(commands.save).toHaveBeenCalledWith("save");
    expect(saveCommitted).not.toHaveBeenCalled();
  });

  it("preserves Save As intent when mounting an inactive source view", async () => {
    const { deps, commands, saveCommitted } = setup(true, "save-as");
    await expect(saveExactTarget(deps)).resolves.toBe(true);
    expect(commands.save).toHaveBeenCalledWith("save-as");
    expect(saveCommitted).not.toHaveBeenCalled();
  });

  it("propagates an explicit no-op or failure result", async () => {
    const source = setup(true);
    source.commands.save.mockResolvedValueOnce(false);
    await expect(saveExactTarget(source.deps)).resolves.toBe(false);

    const formatted = setup(false);
    formatted.saveCommitted.mockResolvedValueOnce(false);
    await expect(saveExactTarget(formatted.deps)).resolves.toBe(false);
  });

  it("persists formatted targets through the post-commit helper", async () => {
    const { deps, target, commands, saveCommitted } = setup(false);
    await expect(saveExactTarget(deps)).resolves.toBe(true);
    expect(saveCommitted).toHaveBeenCalledWith(target, "save");
    expect(commands.save).not.toHaveBeenCalled();
  });

  // #1708 item 1. The bare `false`s above are now named, and the naming is the
  // point: a user whose tab is gone must not be told to expect a reload, and a
  // user whose source editor had not mounted must not be told the tab vanished.
  // Collapsing any two of these onto one reason produces exactly that.
  it("names the tab that stopped resolving before activation", async () => {
    const h = setup(true);
    h.setLive(null);
    await expect(saveExactTarget(h.deps)).resolves.toBe(false);
    expect(h.onRefused.mock.calls).toEqual([["no-such-tab"]]);
  });

  it("splits the post-activation guard: gone is not the same as replaced", async () => {
    const closed = setup(true);
    closed.deps.afterActivate = vi.fn(async () => {
      closed.setLive(null);
    });
    await expect(saveExactTarget(closed.deps)).resolves.toBe(false);
    expect(closed.onRefused.mock.calls).toEqual([["no-such-tab"]]);

    const reopened = setup(true);
    reopened.deps.afterActivate = vi.fn(async () => {
      reopened.setLive({ id: "doc-a", generation: {} });
    });
    await expect(saveExactTarget(reopened.deps)).resolves.toBe(false);
    expect(reopened.onRefused.mock.calls).toEqual([["tab-changed"]]);
  });

  it("names an unregistered source editor", async () => {
    const h = setup(true);
    h.deps.getSourceCommands = () => null;
    await expect(saveExactTarget(h.deps)).resolves.toBe(false);
    expect(h.onRefused.mock.calls).toEqual([["no-source-commands"]]);
  });

  it("splits the formatted branch's guard the same way", async () => {
    // Defensive rather than live: this branch awaits nothing between its two
    // resolves, so `current` is necessarily `before`. Driven here through a
    // scripted `resolveTarget` so a future `await` added above cannot silently
    // reintroduce an unnamed refusal.
    const gone = setup(false);
    const goneValues: (Target | null)[] = [gone.target, null];
    gone.deps.resolveTarget = () => goneValues.shift() ?? null;
    await expect(saveExactTarget(gone.deps)).resolves.toBe(false);
    expect(gone.onRefused.mock.calls).toEqual([["no-such-tab"]]);

    const replaced = setup(false);
    const replacedValues: (Target | null)[] = [replaced.target, { id: "doc-a", generation: {} }];
    replaced.deps.resolveTarget = () => replacedValues.shift() ?? null;
    await expect(saveExactTarget(replaced.deps)).resolves.toBe(false);
    expect(replaced.onRefused.mock.calls).toEqual([["tab-changed"]]);
  });

  it("stays quiet when a DELEGATE declines — that refusal is already reported", async () => {
    // `commands.save` is SourceView and `saveCommitted` is the workspace's
    // post-commit helper; both report their own refusals. A blanket call here
    // would double-toast one refusal.
    const source = setup(true);
    source.commands.save.mockResolvedValueOnce(false);
    await expect(saveExactTarget(source.deps)).resolves.toBe(false);
    expect(source.onRefused).not.toHaveBeenCalled();

    const formatted = setup(false);
    formatted.saveCommitted.mockResolvedValueOnce(false);
    await expect(saveExactTarget(formatted.deps)).resolves.toBe(false);
    expect(formatted.onRefused).not.toHaveBeenCalled();
  });

  it("no-ops when activation reveals a closed or reopened target", async () => {
    const closed = setup(true);
    closed.deps.afterActivate = vi.fn(async () => {
      closed.setLive(null);
    });
    await expect(saveExactTarget(closed.deps)).resolves.toBe(false);
    expect(closed.commands.save).not.toHaveBeenCalled();

    const reopened = setup(true);
    reopened.deps.afterActivate = vi.fn(async () => {
      reopened.setLive({ id: "doc-a", generation: {} });
    });
    await expect(saveExactTarget(reopened.deps)).resolves.toBe(false);
    expect(reopened.commands.save).not.toHaveBeenCalled();
  });
});
