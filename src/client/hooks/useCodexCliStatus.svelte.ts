import {
  API_INTEGRATIONS_CODEX_CLI_STATUS,
  API_INTEGRATIONS_INSTALL_CODEX,
} from "../../shared/integrations/contract.js";
import type { ClaudeCliStatusState } from "./useClaudeCliStatus.svelte.js";
import { createCliStatus } from "./useCliStatus.svelte.js";

export function createCodexCliStatus(
  getActive: () => boolean,
  baseUrl = "",
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): ClaudeCliStatusState {
  return createCliStatus(getActive, baseUrl, fetchFn, {
    name: "Codex",
    statusPath: API_INTEGRATIONS_CODEX_CLI_STATUS,
    installPath: API_INTEGRATIONS_INSTALL_CODEX,
  });
}
