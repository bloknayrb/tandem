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
 *  - `unusable` — the user has a local model that should answer and cannot:
 *    its endpoint is missing or rejected, or two or more enabled local models
 *    are saved and none is marked Default. The collaborator tells the user
 *    why, once per state.
 *
 * **Which entry answers** (Bryan, 2026-11-11): the default, when one is set.
 * With no default, a SOLE enabled local model answers without being marked —
 * adding a model from Settings does not set a default, and the client's label
 * already treats a lone model as the active one. A default that is set but
 * disabled or cloud is never overridden by a spare local model: that is the
 * user saying "Claude is my collaborator".
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
  | { kind: "ok"; config: LocalModelConfig; entryId: string }
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
    const chosen =
      file.defaultModelId === null
        ? undefined
        : file.models.find((m) => m.id === file.defaultModelId);
    let entry = chosen;
    if (!entry) {
      // No default (or one naming no entry). A sole enabled local model answers
      // unmarked; two or more with none marked is the one "choose a default"
      // state; none is an ordinary "no local model". The key is the reason
      // alone, so adding a third while still default-less is not a new state.
      const locals = file.models.filter((m) => m.enabled && isLocalProvider(m.provider));
      if (locals.length === 0) return { kind: "none" };
      if (locals.length > 1) {
        return unusable("no-default-chosen", [], "several local models, no default chosen");
      }
      entry = locals[0];
    }
    // A disabled or cloud default is an ordinary resting state, not a fault.
    if (!entry.enabled) return { kind: "none" };
    if (!isLocalProvider(entry.provider)) return { kind: "none" };
    if (!entry.endpoint) {
      return unusable("no-endpoint", [entry.id], `entry ${logId(entry.id)} has no endpoint`);
    }
    const check = validateEndpoint(entry.endpoint);
    if (!check.ok) {
      return unusable(
        "endpoint-rejected",
        [entry.id, entry.endpoint, check.code],
        `entry ${logId(entry.id)} endpoint rejected (${check.code})`,
      );
    }
    return {
      kind: "ok",
      entryId: entry.id,
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

/** Which saved entry would answer the next chat, and where it points. */
export interface AnsweringLocalModel {
  entryId: string;
  endpoint: string;
  modelId: string;
  displayName: string;
}

/**
 * The local model that would answer the next chat, or null when none would.
 * The collaborator watches this across registry writes to tell the user when
 * it changes (#2404): since a saved model takes effect with no restart, a
 * write the user did not make must not be silent.
 */
export function answeringLocalModel(): AnsweringLocalModel | null {
  const r = resolveLocalModel();
  if (r.kind !== "ok") return null;
  return {
    entryId: r.entryId,
    endpoint: r.config.endpoint,
    modelId: r.config.modelId,
    displayName: r.config.agentIdentity.displayName,
  };
}
