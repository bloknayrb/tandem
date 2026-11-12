/**
 * The model config a trial runs with. In the product it comes from the saved
 * Models registry (`resolveLocalModel` in `config-source.ts`); here it comes
 * from the command line. The transport and the identity's shape are the ones
 * the product's resolver produces for a saved Ollama entry — pinned by
 * `tests/server/local-model/harness/model-config.test.ts`, which compares this
 * function's result with the resolver's.
 */
import type { LocalModelConfig } from "../../../src/server/local-model/index.js";
import { AGENT_DISPLAY_NAME_MAX } from "../../../src/shared/types.js";

export function harnessConfig(modelId: string, endpoint: string): LocalModelConfig {
  return {
    endpoint,
    modelId,
    transport: "v1",
    agentIdentity: { provider: "local-ollama", displayName: modelId.slice(0, AGENT_DISPLAY_NAME_MAX) },
  };
}
