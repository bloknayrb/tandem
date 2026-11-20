/**
 * The words the local-model E2E specs expect to see (#1123 PR 8a; ADR-039's
 * amendment on E2E for the Models specs).
 *
 * Re-exported where Playwright's loader can import the source module (plain
 * TypeScript under `src/shared` or `src/client/utils`); copied where it cannot
 * or should not (a Svelte runes module, a `.svelte` component, a server module
 * that would pull the server's state into the test runner). Every copy is
 * pinned to its source by `tests/scripts/e2e-local-model-strings.test.ts`,
 * which runs in `check` with the flag off, so a reworded string fails dark CI
 * rather than only the lit E2E run.
 */

export { MODEL_SAVE_REASON, PICKER_TITLE } from "../../src/client/utils/local-model-copy.js";
export { nameFallback, providerHeading } from "../../src/shared/models/provider-ui.js";

/** `FIRST_LOCAL_MODEL_TOAST_TEXT`, `src/client/hooks/useChatAnswerer.svelte.ts`. */
export const FIRST_LOCAL_MODEL_TOAST_TEXT =
  "Chat is still set to Claude. To use your local model for chat, choose Local model under Who answers your chat in Settings → Models.";

/** `USE_IT_FOR_CHAT_LABEL`, `src/client/hooks/useChatAnswerer.svelte.ts`. */
export const USE_IT_FOR_CHAT_LABEL = "Use it for chat";

/** `ANSWERER_LOCAL_NOTICE`, `src/server/models/chat-answerer.ts`. */
export const ANSWERER_LOCAL_NOTICE =
  "Your chat was set to be answered by a local model. If you did not do this, set who answers your chat back to Claude in Settings → Models.";

/** `UNAVAILABLE_TITLE`, `src/client/components/ModelEditModal.svelte`. */
export const MODEL_UNAVAILABLE_TITLE = "Model unavailable";

/** `UNAVAILABLE_TEXT` in `ModelEditModal.svelte`, and the Models tab row's sentence. */
export const MODEL_UNAVAILABLE_TEXT = "This provider can't be used in Tandem.";

/** The "Who answers your chat" status line for Claude, `SettingsModelsTab.svelte`. */
export const CHAT_ANSWERER_CLAUDE_STATUS =
  "Chat is set to Claude. Local models are not sent your chat.";

/**
 * The Models tab's line when a cloud Default (enabled, named) keeps local
 * models from answering (DD1), as `defaultBlocksLocalLine` in
 * `SettingsModelsTab.svelte` builds its first sentence.
 */
export function defaultIsCloudLine(name: string): string {
  return `Your Default model, ${name}, is a cloud model, so your local models won't answer chat.`;
}

// --- #1123 PR 8b: chat against a stubbed local model ---------------------------

export { LOCAL_COMMENT_INFO_TEXT } from "../../src/client/status/addressed-ai-notice.js";

/** `LOCAL_PERIOD_STATUS_LINE`, `src/server/mcp/awareness.ts`. */
export const LOCAL_PERIOD_STATUS_LINE =
  "Tandem chat is set to be answered by a local model, and nothing in Tandem is handed to you while it is. Finish the step you are on and take no new work from Tandem. You do not need to wait for this; a later poll will no longer carry this line once chat is answered by Claude again. If you already have a Tandem wake watch running, leave it running.";

/** `RUN_FAILURE_TEXT["not-found"]`, `src/server/local-model/collaborator.ts`. */
export const RUN_FAILURE_NOT_FOUND =
  "Your local model's server could not find the model or address Tandem asked for. Check that the model is downloaded, then check its Model ID and Endpoint in Settings → Models.";

/** Save's label while a save is in flight, `ModelEditModal.svelte` (Ruling R-b). */
export const SAVING_LABEL = "Saving…";
