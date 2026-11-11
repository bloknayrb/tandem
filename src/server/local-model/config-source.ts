/**
 * Local-model config resolution (#1123 M1a, ADR-039).
 *
 * Resolves the collaborator loop's `{endpoint, modelId, transport}` from the
 * server-side Models registry (`src/server/models/`) — no browser session
 * required. Reads the in-memory registry cache SYNCHRONOUSLY; the cache is
 * warmed at boot by `primeModelStoreCache()` and replaced on every successful
 * `POST /api/models` (`persistModelsFile`), so the collaborator can resolve
 * again on every chat event and pick up a model saved a moment ago with no
 * restart and no extra invalidation.
 *
 * Three outcomes, because "no config" means two different things to the user:
 *
 *  - `ok` — an enabled local default with an endpoint that passes the loopback
 *    check. The engine re-validates the endpoint at fetch time (validate-at-use
 *    / TOCTOU); this resolve-time check is defense-in-depth.
 *  - `none` — the ordinary ways of saying "Claude is my collaborator": nothing
 *    saved, a disabled default, a cloud default (cloud BYO keys are v1.1), or no
 *    default with no enabled local model. The user is told nothing.
 *  - `unusable` — the user has an enabled local model selected, or one saved
 *    with no default chosen, and it cannot be used. The collaborator tells the
 *    user why, once per state.
 *
 * A default naming no entry is the same state as no default: the store clears
 * it on every read and write, so it is only reachable at this seam.
 *
 * This module logs nothing on the ordinary paths. It runs on every chat
 * message, so a line here would repeat per chat; the collaborator prints one
 * breadcrumb per changed state instead. `stateKey` is a hash, never the
 * endpoint itself, because a rejected endpoint may hold a user name and
 * password.
 */
import { createHash } from "node:crypto";

import { isLocalProvider } from "../../shared/models/contract.js";
import { AGENT_DISPLAY_NAME_MAX } from "../../shared/types.js";
import { getCachedModelsFile } from "../models/registry.js";
import { type LocalModelConfig, validateEndpoint } from "./config.js";

export type LocalModelUnusableReason = "no-default-chosen" | "no-endpoint" | "endpoint-rejected";

export interface LocalModelUnusable {
  reason: LocalModelUnusableReason;
  /** Identity of this broken state, for once-per-state dedup. Opaque (a hash). */
  stateKey: string;
  /** Safe-to-log detail: the entry id and reject code. Never the endpoint. */
  detail: string;
}

export type LocalModelResolution =
  | { kind: "ok"; config: LocalModelConfig }
  | { kind: "none" }
  | ({ kind: "unusable" } & LocalModelUnusable);

/** An entry id for a log line: bounded, and quoted so a newline cannot forge one. */
function logId(id: string): string {
  return JSON.stringify(id.slice(0, 64));
}

function unusable(
  reason: LocalModelUnusableReason,
  keyParts: readonly string[],
  detail: string,
): LocalModelResolution {
  const stateKey = createHash("sha256")
    .update(JSON.stringify([reason, ...keyParts]))
    .digest("hex");
  return { kind: "unusable", reason, stateKey, detail };
}

export function resolveLocalModel(): LocalModelResolution {
  try {
    const file = getCachedModelsFile();
    const entry =
      file.defaultModelId === null
        ? undefined
        : file.models.find((m) => m.id === file.defaultModelId);
    if (!entry) {
      // No default (or one naming no entry). Silent unless the user has saved an
      // enabled local model: adding a model from Settings does not set a default
      // and deleting the default clears it, so this is how "I added a model and
      // nothing answers" looks from here. The key is the reason alone, so adding
      // or removing another local model while still default-less is not a new
      // state.
      const hasEnabledLocal = file.models.some((m) => m.enabled && isLocalProvider(m.provider));
      return hasEnabledLocal
        ? unusable("no-default-chosen", [], "no default chosen")
        : { kind: "none" };
    }
    // A disabled or cloud default is an ordinary resting state, not a fault.
    if (!entry.enabled) return { kind: "none" };
    if (!isLocalProvider(entry.provider)) return { kind: "none" };
    if (!entry.endpoint) {
      return unusable(
        "no-endpoint",
        [entry.id],
        `default entry ${logId(entry.id)} has no endpoint`,
      );
    }
    const check = validateEndpoint(entry.endpoint);
    if (!check.ok) {
      return unusable(
        "endpoint-rejected",
        [entry.id, entry.endpoint, check.code],
        `default entry ${logId(entry.id)} endpoint rejected (${check.code})`,
      );
    }
    return {
      kind: "ok",
      config: {
        endpoint: entry.endpoint,
        modelId: entry.modelId,
        // Both local kinds (Ollama, llama.cpp) expose an OpenAI-compatible
        // `/v1/chat/completions`, so `v1` is uniform for now.
        transport: "v1",
        // #1123 M3: build the byline identity ONCE here. CLAMP the displayName:
        // the registry permits longer names (client ≤256, server schema
        // unbounded) than the durable-record bound, and an over-long
        // agentIdentity fails AnnotationRecordSchemaV1 on reload — corrupting the
        // WHOLE annotations file (parseAnnotationDoc → corrupt → quarantine), not
        // just the one record. Clamping here is the sole guard, since this is the
        // only site that builds an agentIdentity.
        agentIdentity: {
          provider: entry.provider,
          displayName: entry.displayName.slice(0, AGENT_DISPLAY_NAME_MAX),
        },
      },
    };
  } catch (err) {
    // Every call above is non-throwing today, so reaching here means a real
    // bug, not a config problem: log it rather than resolving `none` silently.
    // It cannot be reported as `unusable`, because nothing here knows whether a
    // local model was selected.
    console.error(
      `[tandem] local-model: unexpected error resolving config (${
        err instanceof Error ? err.message : String(err)
      }); loop inert.`,
    );
    return { kind: "none" };
  }
}

/** The usable config, or null. The collaborator's `resolveConfig` seam. */
export function resolveLocalModelConfig(): LocalModelConfig | null {
  const r = resolveLocalModel();
  return r.kind === "ok" ? r.config : null;
}

/**
 * Why a selected local model cannot be used, or null when there is nothing to
 * tell the user (it resolved, or the state is an ordinary "no local model").
 * Reads the same synchronous cache as {@link resolveLocalModelConfig}, so two
 * calls in one tick cannot disagree.
 */
export function diagnoseLocalModel(): LocalModelUnusable | null {
  const r = resolveLocalModel();
  if (r.kind !== "unusable") return null;
  return { reason: r.reason, stateKey: r.stateKey, detail: r.detail };
}
