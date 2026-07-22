/**
 * Local-model config resolution (#1123 M1a, ADR-039).
 *
 * Resolves the collaborator loop's `{endpoint, modelId, transport}` from the
 * server-side Models registry (`src/server/models/`) — no browser session
 * required. Reads the in-memory registry cache SYNCHRONOUSLY (the collaborator's
 * `resolveConfig` seam is `() => LocalModelConfig | null`); the cache is warmed
 * at boot by `primeModelStoreCache()` before the collaborator starts.
 *
 * The collaborator still resolves this ONCE at boot and caches it (M1a makes no
 * collaborator change, per D-C). Dynamic re-resolution after a post-boot config
 * change is deferred to M4 (see the TODO(M4) in collaborator.ts) — while
 * `BYO_MODELS_ENABLED` is false the loop never subscribes, so this is inert.
 *
 * Inert (returns null) when: no default set, the default entry is missing or
 * disabled, the default is a CLOUD provider (cloud BYO keys are v1.1 — the loop
 * only drives local endpoints), the entry has no endpoint, or the endpoint
 * fails the loopback check. The engine re-validates the endpoint at fetch time
 * (validate-at-use / TOCTOU); this resolve-time check is defense-in-depth.
 */
import { isLocalProvider } from "../../shared/models/contract.js";
import { AGENT_DISPLAY_NAME_MAX } from "../../shared/types.js";
import { getCachedModelsFile } from "../models/registry.js";
import { type LocalModelConfig, validateEndpoint } from "./config.js";

export function resolveLocalModelConfig(): LocalModelConfig | null {
  try {
    const file = getCachedModelsFile();
    // "No default configured" is a legitimate resting state → stay silent.
    if (!file.defaultModelId) return null;
    // Every branch below is a *present-but-broken* default: the user asked for a
    // collaborator and won't get one. The resolver has no return channel for a
    // reason, so log one to stderr (this runs only under BYO_MODELS_ENABLED, so
    // it never fires when dark) — otherwise the loop is silently inert at M4.
    const entry = file.models.find((m) => m.id === file.defaultModelId);
    if (!entry) {
      console.error(
        `[tandem] local-model: defaultModelId "${file.defaultModelId}" matches no registry entry; loop inert.`,
      );
      return null;
    }
    if (!entry.enabled) {
      console.error(`[tandem] local-model: default entry "${entry.id}" is disabled; loop inert.`);
      return null;
    }
    if (!isLocalProvider(entry.provider)) {
      // Cloud BYO keys are v1.1 — the loop only drives local endpoints for now.
      console.error(
        `[tandem] local-model: default entry "${entry.id}" is a cloud provider (${entry.provider}); cloud collaborators are not yet supported, loop inert.`,
      );
      return null;
    }
    if (!entry.endpoint) {
      console.error(
        `[tandem] local-model: default entry "${entry.id}" has no endpoint; loop inert.`,
      );
      return null;
    }
    const check = validateEndpoint(entry.endpoint);
    if (!check.ok) {
      console.error(
        `[tandem] local-model: default entry "${entry.id}" endpoint rejected (${check.code}); loop inert.`,
      );
      return null;
    }
    return {
      endpoint: entry.endpoint,
      modelId: entry.modelId,
      // Both local kinds (Ollama, llama.cpp) expose an OpenAI-compatible
      // `/v1/chat/completions`, so `v1` is uniform for now. Ollama-native
      // `/api/chat` can become an optional per-entry transport later (M2/M4).
      transport: "v1",
      // #1123 M3: build the byline identity ONCE here (the entry's provider +
      // displayName were previously read and discarded). Threaded whole to both
      // write paths so the fields are never re-bundled downstream. CLAMP the
      // displayName: the registry permits longer names (client ≤256, server
      // schema unbounded) than the durable-record bound, and an over-long
      // agentIdentity fails AnnotationRecordSchemaV1 on reload — corrupting the
      // WHOLE annotations file (parseAnnotationDoc → corrupt → quarantine), not
      // just the one record. Clamping here is the sole guard, since this is the
      // only site that builds an agentIdentity.
      agentIdentity: {
        provider: entry.provider,
        displayName: entry.displayName.slice(0, AGENT_DISPLAY_NAME_MAX),
      },
    };
  } catch (err) {
    // No error channel on this seam — a resolution failure means "inert". Today
    // every call above is non-throwing, so reaching here means a real bug, not a
    // config problem: log it rather than resolving null indistinguishably.
    console.error(
      `[tandem] local-model: unexpected error resolving config (${
        err instanceof Error ? err.message : String(err)
      }); loop inert.`,
    );
    return null;
  }
}
