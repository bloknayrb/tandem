import { describe, expect, it, vi } from "vitest";
import { saveExactTarget } from "../../src/client/tabs/target-save";

type Target = { id: string; generation: object };

function setup(sourceView: boolean, intent: "save" | "save-as" = "save") {
  const target: Target = { id: "doc-a", generation: {} };
  let live: Target | null = target;
  const commands = { save: vi.fn(async () => true) };
  const saveCommitted = vi.fn(async () => true);
  const activateTarget = vi.fn();
  const deps = {
    tabId: "doc-a",
    intent,
    resolveTarget: () => live,
    isSameTarget: (before: Target, after: Target) => before.generation === after.generation,
    isSourceView: () => sourceView,
    activateTarget,
    afterActivate: vi.fn(async () => {}),
    getSourceCommands: () => commands,
    saveCommitted,
  };
  return {
    deps,
    target,
    commands,
    saveCommitted,
    activateTarget,
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

  it("no-ops when activation reveals a closed or reopened target", async () => {
    const closed = setup(true);
    closed.deps.afterActivate = async () => closed.setLive(null);
    await expect(saveExactTarget(closed.deps)).resolves.toBe(false);
    expect(closed.commands.save).not.toHaveBeenCalled();

    const reopened = setup(true);
    reopened.deps.afterActivate = async () => reopened.setLive({ id: "doc-a", generation: {} });
    await expect(saveExactTarget(reopened.deps)).resolves.toBe(false);
    expect(reopened.commands.save).not.toHaveBeenCalled();
  });
});
