import {
  API_INTEGRATIONS_CLAUDE_CLI_STATUS,
  API_INTEGRATIONS_INSTALL_CLAUDE_CODE,
} from "../../shared/integrations/contract.js";
import { type CliStatusState, createCliStatus } from "./useCliStatus.svelte.js";

/** Compatibility name retained for callers of the original Claude-only hook. */
export type ClaudeCliStatusState = CliStatusState;

/** Probe and optionally install the Claude CLI for the integration wizard. */
export function createClaudeCliStatus(
  getActive: () => boolean,
  baseUrl = "",
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): ClaudeCliStatusState {
  return createCliStatus(getActive, baseUrl, fetchFn, {
    name: "Claude",
    statusPath: API_INTEGRATIONS_CLAUDE_CLI_STATUS,
    installPath: API_INTEGRATIONS_INSTALL_CLAUDE_CODE,
  });
}
