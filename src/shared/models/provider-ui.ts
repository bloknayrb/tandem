/**
 * Per-provider labels, order and address prefills for the Models surfaces
 * (#1123, LM Studio and "another local server", 2026-11-15).
 *
 * Every map is a `Record<ModelProvider, …>`, so a provider added to the
 * contract is a type error here until it has a label and a prefill; every list
 * is DERIVED from `VALID_MODEL_PROVIDERS` / `LOCAL_MODEL_PROVIDERS`, so no list
 * can drop a provider silently (the Models tab used to list only the providers
 * in a hand-written array, and an entry of any other provider was not shown).
 *
 * Pure data: the client bundles it and the server tests import it beside
 * `validateEndpoint`. The provider never reaches the wire (`config-source.ts`
 * sets the same `v1` transport for every local kind).
 */
import {
  isLocalProvider,
  LOCAL_MODEL_PROVIDERS,
  type ModelProvider,
  VALID_MODEL_PROVIDERS,
} from "./contract.js";

/** The provider's name in the Models tab heading and the edit modal's option. */
export const PROVIDER_LABEL: Readonly<Record<ModelProvider, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  "local-ollama": "Ollama (local)",
  "local-llamacpp": "llama.cpp (local)",
  "local-lmstudio": "LM Studio (local)",
  "local-other": "Other local server (OpenAI-compatible)",
};

/**
 * The address a local provider's server is documented at, written with
 * `127.0.0.1` (Ruling L-b), never with `/v1`; `""` means "no prefill".
 *
 * Ruling L-1: a port only from the project's own documentation or source.
 *  - Ollama: the address Tandem has always prefilled (port 11434).
 *  - LM Studio: https://lmstudio.ai/docs/developer/openai-compat uses
 *    `http://localhost:1234/v1` in its examples.
 *  - llama.cpp: none. Its own source changed the server's default port
 *    between releases (`common/common.h`: 8080 through tag b11000, 9931 at
 *    b12000), so no single address is its default.
 *  - Other: none, by design (Decision L2).
 * Every non-empty value must pass `validateEndpoint` (pinned by a test);
 * enforcement still happens only at resolve and fetch time.
 */
export const LOCAL_ENDPOINT_PREFILL: Readonly<Record<ModelProvider, string>> = {
  anthropic: "",
  openai: "",
  gemini: "",
  "local-ollama": "http://127.0.0.1:11434",
  "local-llamacpp": "",
  "local-lmstudio": "http://127.0.0.1:1234",
  "local-other": "",
};

export function endpointPrefill(provider: ModelProvider): string {
  return LOCAL_ENDPOINT_PREFILL[provider];
}

/** Option order for the edit modal and the first-run picker: every local
 *  provider first, in contract order, then the cloud ones. */
export const PROVIDER_OPTION_ORDER: readonly ModelProvider[] = [
  ...LOCAL_MODEL_PROVIDERS,
  ...VALID_MODEL_PROVIDERS.filter((p) => !isLocalProvider(p)),
];

/** Group order for the Models tab: Anthropic first (the D4 ordering anchor),
 *  the rest in contract order. */
export const MODELS_TAB_ORDER: readonly ModelProvider[] = [
  "anthropic",
  ...VALID_MODEL_PROVIDERS.filter((p) => p !== "anthropic"),
];

/** The heading a provider's entries are listed under in the Models tab, and
 *  the Provider line of an old cloud entry's window (#1123, cloud providers
 *  hidden): a cloud provider reads "<name> (API key)", parallel to the local
 *  labels' "(local)", so "This provider can't be used in Tandem." under
 *  "Anthropic" never reads as Claude being unusable. */
export function providerHeading(p: ModelProvider): string {
  return isLocalProvider(p) ? PROVIDER_LABEL[p] : `${PROVIDER_LABEL[p]} (API key)`;
}
