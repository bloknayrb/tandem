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

/** S6: the first-run picker's subtitle while a local provider is selected. */
export const PICKER_LOCAL_SUBTITLE =
  "Step 1 of 2 — Tandem can use a model server on this computer.";
