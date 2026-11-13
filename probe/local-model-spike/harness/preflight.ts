/**
 * Before the first trial (brief R3.2): is the endpoint one the product would
 * accept, does the model exist, does it say it supports tools, and one
 * unscored warm-up call so the first trial is not charged the model's load.
 */
import { chat, type LocalModelConfig, validateEndpoint } from "../../../src/server/local-model/index.js";
import { type ModelFacts, readLoadedContextLength, readModelFacts, UNKNOWN } from "./ollama-meta.js";

/** How long the warm-up call may take: a large model loading from a slow disk. */
export const WARMUP_TIMEOUT_MS = 10 * 60_000;

export interface PreflightResult {
  ok: boolean;
  /** Why the run must not start (when `ok` is false). */
  stop?: string;
  facts: ModelFacts;
  /** Lines to print before the first trial. */
  notes: string[];
}

export interface PreflightDeps {
  readFacts?: typeof readModelFacts;
  readContext?: typeof readLoadedContextLength;
  warmUp?: (config: LocalModelConfig) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The warm-up: one call through the SHIPPED client, streamed like a real turn,
 * with no tools and a one-line user message. It is not a trial, is never
 * scored, and its text is thrown away. (Named exemption in the source pin:
 * this is the only message text the harness writes for a model, and it never
 * reaches a trial.)
 */
export async function warmUp(config: LocalModelConfig): Promise<void> {
  await chat({
    config,
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
    tools: [],
    timeoutMs: WARMUP_TIMEOUT_MS,
    onContentDelta: () => {},
  });
}

export async function preflight(
  config: LocalModelConfig,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  const notes: string[] = [];
  const emptyFacts: ModelFacts = {
    exists: UNKNOWN,
    toolSupport: UNKNOWN,
    digest: UNKNOWN,
    ollamaVersion: UNKNOWN,
    contextLength: UNKNOWN,
    serverSettings: UNKNOWN,
  };
  const env = deps.env ?? process.env;
  if (env.TANDEM_LICENSE_GATE) {
    return {
      ok: false,
      stop: "TANDEM_LICENSE_GATE is set in this shell. With the licence gate armed every chat write is refused and every trial would end with no reply. Unset it and start again.",
      facts: emptyFacts,
      notes,
    };
  }
  const validated = validateEndpoint(config.endpoint);
  if (!validated.ok) {
    return { ok: false, stop: `endpoint refused (${validated.code}): ${validated.message}`, facts: emptyFacts, notes };
  }

  const facts = await (deps.readFacts ?? readModelFacts)(validated.url, config.modelId);
  if (facts.exists === false) {
    return {
      ok: false,
      stop: `the server says it has no model named ${JSON.stringify(config.modelId)}. Pull it first (ollama pull …).`,
      facts,
      notes,
    };
  }
  if (facts.toolSupport === false) {
    return {
      ok: false,
      stop: `the server lists this model's capabilities and tools is not among them. Both tiers offer tools, so it cannot be measured.`,
      facts,
      notes,
    };
  }
  if (facts.exists === UNKNOWN) notes.push("Could not confirm the model exists (the server did not answer the metadata calls as expected). Continuing.");
  if (facts.toolSupport === UNKNOWN) notes.push("Tool support: unknown (the server did not list capabilities). Continuing.");
  notes.push(`Model digest: ${facts.digest}`);
  if (facts.digest === UNKNOWN) {
    notes.push("The digest is unknown, so THIS RUN CANNOT BE RESUMED: a resume must show it is the same model.");
  }
  notes.push(`Ollama version: ${facts.ollamaVersion}`);

  notes.push(`Warming the model up (one unscored call, up to ${WARMUP_TIMEOUT_MS / 60_000} minutes)…`);
  try {
    await (deps.warmUp ?? warmUp)(config);
  } catch (err) {
    return {
      ok: false,
      stop: `the warm-up call failed: ${err instanceof Error ? err.message : String(err)}`,
      facts,
      notes,
    };
  }
  const loaded = await (deps.readContext ?? readLoadedContextLength)(validated.url, config.modelId);
  if (loaded !== UNKNOWN) facts.contextLength = loaded;
  notes.push(`Context length: ${facts.contextLength}`);
  return { ok: true, facts, notes };
}
