import { describe, expect, it, vi } from "vitest";
import {
  type CollaboratorDeps,
  createLocalModelCollaborator,
} from "../../../src/server/local-model/collaborator.js";
import type { LocalModelConfig } from "../../../src/server/local-model/config.js";

/**
 * The collaborator's dark gate (#1123), moved out of `collaborator.test.ts` so
 * that file holds in either state of the flag. The guard pinned: `start()`'s
 * `BYO_MODELS_ENABLED` return in `src/server/local-model/collaborator.ts`.
 */

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const CONFIG: LocalModelConfig = {
  endpoint: "http://127.0.0.1:11434",
  modelId: "m",
  transport: "v1",
  agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
};

function makeDeps(over: Partial<CollaboratorDeps> = {}): CollaboratorDeps {
  return {
    runTurn: async () => {
      throw new Error("no run while dark");
    },
    resolveConfig: () => CONFIG,
    subscribe: () => {},
    unsubscribe: () => {},
    chatAnswerer: () => "local",
    ...over,
  };
}

describe("collaborator — dark gating", () => {
  it("start() does not subscribe or read config while BYO_MODELS_ENABLED is false", () => {
    const subscribeSpy = vi.fn();
    const resolveSpy = vi.fn(() => CONFIG);
    const collab = createLocalModelCollaborator(
      makeDeps({ subscribe: subscribeSpy, resolveConfig: resolveSpy }),
    );
    collab.start();
    // This file forces the flag false → the subscriber is never registered and
    // config is never resolved. This is the load-bearing dark gate.
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
