import { validateEndpoint } from "../../shared/models/local-endpoint.js";

/**
 * The copy that says what a local model can be and what Tandem sends it
 * (#1123, LM Studio and "another local server", R4: S1, S2, S3, S6).
 *
 * Each sentence states a fact that holds in every state it can be shown in —
 * chat set to Claude or to the local model, any licence state, Solo or Tandem,
 * any saved models — so none says what is happening now or tells the user to
 * change a setting (Ruling B-18: "your local model", never that one
 * "answers"). None promises quality or names a model.
 */

/**
 * The name a model's row is known by (#1123, ADR-039 item 27): the first
 * non-blank of its display name, model ID and id, so an entry saved with a
 * blank name is still told apart by its model ID. "" only when all three are
 * blank (a hand-edited file). Trimmed.
 */
/** A row control's accessible name: its visible word, then the row's name
 *  (WCAG 2.5.3: the name starts with the visible text). With no row name, the
 *  visible word alone, never a dangling separator. */
export function rowControlName(visible: string, rowName: string, joiner = " "): string {
  return rowName === "" ? visible : `${visible}${joiner}${rowName}`;
}

export function modelRowName(entry: {
  displayName?: string;
  modelId?: string;
  id?: string;
}): string {
  for (const v of [entry.displayName, entry.modelId, entry.id]) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/** S1: what can be used. */
export const LOCAL_SERVERS_LINE =
  "Tandem can use a model server on this computer that offers the OpenAI-compatible chat API, such as Ollama, LM Studio or llama.cpp. Hugging Face models can be used through one of these if the server runs them. Tandem does not download models.";

/**
 * S2: what to expect. A capability statement, true while nothing is sent.
 * Reading tools are offered on every run, and the text inline only up to
 * `INLINE_CHAR_LIMIT` (`collaborator.ts`); a run that starts in Solo, or with
 * editing off, gets only the reading tools (`local-model/index.ts`).
 */
export const LOCAL_REQUEST_LINE =
  'When Tandem sends your local model a message, it includes your document\'s text when the document is short, tools for reading your document, and, in Tandem mode if you allow it under "Local models and your document", tools for adding comments and suggestions. Tandem reads the reply as a stream. A server or model that does not support tool calling may fail. Models differ in how well they do this.';

/** S3: the address hint, under the Endpoint field. `prefill` is the selected
 *  provider's documented address, or `""` when it has none. */
export function endpointHint(prefill: string): string {
  const example =
    prefill === ""
      ? "including its port, for example http://127.0.0.1 followed by the port"
      : `for example ${prefill}`;
  return `The server's address on this computer, ${example}. Leave off /chat/completions; a trailing /v1 is ignored.`;
}

/** The first-run window's title, and its dialog's accessible name (#1123,
 *  ADR-039 item 21: reworded to say it is optional). */
export const PICKER_TITLE = "Add a local model (optional)";

/** The first-run window's subtitle (#1123 item 21; the name is S6's, kept so
 *  the dark test still finds it absent). Two sentences; no step count. */
export const PICKER_LOCAL_SUBTITLE =
  "Chat stays set to Claude. Your model server must be running on this computer for Tandem to use the model; you can also add models any time in Settings → Models.";

/** Under the first-run window's Model ID field (V8): names no model. */
export const PICKER_MODEL_ID_HINT = "The model's name exactly as your server lists it.";

/**
 * Why the first-run window's Save cannot save yet (V14), or null when it can.
 * Trims both fields itself, so the window's `canSave` is derived from this and
 * the two never disagree on a whitespace-only field.
 */
export function pickerSaveReason(fields: { endpoint: string; modelId: string }): string | null {
  const noEndpoint = fields.endpoint.trim() === "";
  const noModelId = fields.modelId.trim() === "";
  if (noEndpoint && noModelId) return "Enter an Endpoint URL and a Model ID to save.";
  if (noEndpoint) return "Enter an Endpoint URL to save.";
  if (noModelId) return "Enter a Model ID to save.";
  return null;
}

/** The add-model window's Save reasons (#1123, ADR-039 P10(5), V2, V9). Each
 *  is true in every state it shows in, and none says the server will accept
 *  the entry. */
export const MODEL_SAVE_REASON = {
  /** U1: no Model ID (the first-run window's sentence for that state). */
  noModelId: "Enter a Model ID to save.",
  /** U2: no Endpoint. */
  noEndpoint: "Enter an Endpoint to save.",
  /** U3: any refusal U4 does not cover; each fails a part it names. */
  notThisComputer:
    "The Endpoint must start with http:// and name this computer as 127.0.0.1, localhost or [::1], with no user name or password.",
  /** U4: starts with http:// but is not a complete address. */
  incomplete:
    "The Endpoint is not a complete address. Check it, including the port number (for example http://127.0.0.1:11434).",
} as const;

/**
 * Why the add-model window's Save cannot save (a local provider), or null when
 * it can. First match wins, one reason at a time, Model ID first. Trims both
 * fields itself. The address check is the server's own `validateEndpoint`,
 * called here for the Save reason only; the server checks again at resolve and
 * at fetch and never sees this answer.
 */
export function modelSaveReason(fields: { modelId: string; endpoint: string }): string | null {
  if (fields.modelId.trim() === "") return MODEL_SAVE_REASON.noModelId;
  const endpoint = fields.endpoint.trim();
  if (endpoint === "") return MODEL_SAVE_REASON.noEndpoint;
  const check = validateEndpoint(endpoint);
  if (check.ok) return null;
  if (check.code === "MALFORMED_URL" && /^http:\/\//i.test(endpoint)) {
    return MODEL_SAVE_REASON.incomplete;
  }
  return MODEL_SAVE_REASON.notThisComputer;
}
