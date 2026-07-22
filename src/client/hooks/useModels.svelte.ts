import { BYO_MODELS_ENABLED, DEFAULT_MCP_PORT } from "../../shared/constants.js";
import { apiModelsSecretPath } from "../../shared/integrations/contract.js";
import {
  API_MODELS,
  ERROR_CODE_MODELS_BUSY,
  ERROR_CODE_MODELS_STALE,
  type ModelsGetResponse,
  type ModelsPostBody,
  type ModelsPostResponse,
} from "../../shared/models/contract.js";
import { reconcileModelsToServerOnce } from "../actions/reconcile-models-registry.js";
import { createDefaultKeychainBackend } from "../keychain/keychain-backend.js";
import { projectModelsFile } from "../models/project.js";
import type { AgentLabelSource } from "../utils/agentLabel.js";
import { API_BASE } from "../utils/fileUpload.js";
import {
  loadSettings,
  type ModelRegistryEntry,
  VALID_MODEL_PROVIDERS,
} from "./useTandemSettings.js";

/**
 * Server-authoritative Models registry store (#1123 M2).
 *
 * Historically the registry lived in `TandemSettings.models` (localStorage); M1a
 * relocated the *resolver* to `models.json` but left the client reading/writing
 * localStorage. M2 collapses this to **one authority — the server** (§2). This
 * module is that authority's client mirror: a module-level `$state` singleton
 * loaded from `GET /api/models`, written through on every CRUD op with
 * optimistic-then-reconcile against a content-hash ETag.
 *
 * **Three access shapes over ONE `$state`** (§2.1):
 *  - reactive getters (`createModels()` facade) for Svelte consumers;
 *  - `getModelsSnapshot()` — a synchronous, subscription-free accessor for the
 *    non-Svelte ProseMirror decoration path (`annotation.ts`);
 *  - mutators, all optimistic-then-reconcile.
 *
 * **Dark guarantee (`BYO_MODELS_ENABLED=false`, until M4).** `loadFromServer` is
 * flag-gated → a dark boot fetches nothing and `_models` stays `[]`. But the
 * agent LABEL must NOT read the empty store while dark: users who configured a
 * model under v0.13.x (before `BYO_MODELS_ENABLED` existed) carry it in
 * localStorage, and pre-M2 the label resolved from there. `agentLabelSource()`
 * therefore reads localStorage settings while dark (byte-identical to pre-M2) and
 * the store only when lit — that is the real dark invariant, NOT "store is empty
 * → Assistant" (which regressed the v0.13.x cohort's "GPT"/"Claude" byline to
 * "Assistant"). The localStorage→server *reconcile* runs un-gated (it does NOT
 * touch this store's `$state`); see `actions/reconcile-models-registry.ts`.
 *
 * Plaintext keys travel through `addModel`/`updateModel` as `plaintextApiKey` and
 * are stored via the OS-keychain abstraction; only the opaque `apiKeyRef` is
 * persisted (server schema is `.strict()`; there is no client read path for the
 * plaintext).
 */
export interface ModelsState {
  readonly models: readonly ModelRegistryEntry[];
  readonly defaultModelId: string | null;
  /** Last write/load failure message, or null. Cleared on the next success. */
  readonly saveError: string | null;
  addModel: (
    entry: Omit<ModelRegistryEntry, "id" | "apiKeyRef" | "_legacyApiKey">,
    plaintextApiKey?: string,
  ) => Promise<string>;
  updateModel: (
    id: string,
    patch: Partial<Omit<ModelRegistryEntry, "id" | "apiKeyRef" | "_legacyApiKey">>,
    plaintextApiKey?: string,
  ) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  toggleEnabled: (id: string) => Promise<void>;
  setDefault: (id: string | null) => Promise<void>;
  /**
   * Legacy-key migration is vestigial now that the store loads from the server:
   * the server schema is `.strict()` and never carries `_legacyApiKey`, so the
   * store's entries never do either. Kept as a no-op so `SettingsModelsTab`'s
   * legacy-migration banner still compiles; the banner + these methods are
   * removed together in M2b when the Models UI is unhidden. (Legacy plaintext
   * keys in localStorage are dropped by the reconcile's `projectEntry` — a
   * pre-existing silent drop while the Models UI is dark; R2-D.)
   */
  migrateLegacyKeys: () => Promise<{ migrated: number; failed: number }>;
  readonly hasLegacyKeys: boolean;
}

// --- Module-level singleton state -------------------------------------------

let _models = $state<ModelRegistryEntry[]>([]);
let _defaultModelId = $state<string | null>(null);
let _etag: string | null = null; // last-seen server ETag (not reactive — no UI reads it)
let _saveError = $state<string | null>(null);
let _loadInFlight: Promise<void> | null = null;

// Reconcile gate (R2-B): every mutator awaits this before its POST, so a CRUD
// write can never precede the localStorage→server reconcile at M4 (which would
// let the reconcile clobber a fresh edit). Settled by `initializeStore` when the
// reconcile COMPLETES — success, confirmed skip, OR failure alike — because the
// gate's only job is to keep a CRUD POST from racing an IN-FLIGHT reconcile POST;
// once reconcile has returned there is nothing left to race. Leaving it pending
// on failure would strand every mutator on this await forever (a permanent CRUD
// deadlock at M4). Whether to re-attempt the reconcile next boot is governed
// separately by the reconcile FLAG (per-session gate vs cross-boot flag).
let _resolveReconcile: (() => void) | null = null;
let _reconcileSettled: Promise<void> = new Promise<void>((resolve) => {
  _resolveReconcile = resolve;
});

/** Resolve the reconcile gate. Test seam + called once by `initializeStore`. */
export function _settleReconcile(): void {
  _resolveReconcile?.();
}

// Vite dev server does not proxy `/api/*` so we hit the backend port directly.
const keychain = createDefaultKeychainBackend({
  baseUrl: `http://127.0.0.1:${DEFAULT_MCP_PORT}`,
  pathFor: apiModelsSecretPath,
});

// --- Helpers ----------------------------------------------------------------

/** Opaque 128-bit URL-safe ref. Matches the server-side ref shape. */
function generateKeyRef(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateModelId(): string {
  return crypto.randomUUID();
}

/**
 * Runtime guard against caller bugs. The error message MUST NOT include
 * `apiKey` / `endpoint` values from the patch —
 * `tests/client/use-models-no-key-leak.test.ts` pins this invariant.
 */
function assertValidPatch(patch: { provider?: unknown }): void {
  if (patch.provider !== undefined && !VALID_MODEL_PROVIDERS.includes(patch.provider as never)) {
    throw new Error(`Invalid model provider: ${String(patch.provider)}`);
  }
}

/** Store a plaintext secret in the keychain. Throws on failure. */
async function storeSecret(ref: string, plaintext: string): Promise<void> {
  const result = await keychain.set(ref, plaintext);
  if (result.status === "ok") return;
  const code = result.status === "unavailable" ? "KEYCHAIN_UNAVAILABLE" : "STORE_FAILED";
  throw new Error(`Failed to store model key (${code})`);
}

/**
 * The server distinguishes three write failures the client must NOT collapse
 * (contract §"HTTP error codes"):
 *   - `stale` (409 MODELS_STALE)  — our `ifMatch` lost a race; re-GET + reconcile;
 *   - `busy`  (429 MODELS_BUSY)   — a concurrent write held the single-flight;
 *                                   TRANSIENT, a re-POST clears it (do NOT reload);
 *   - `failed` (400/500/network)  — terminal; roll back.
 * Folding `busy` into `failed` (the pre-review behavior) turned a retryable
 * two-window collision into silent data loss.
 */
type PostFailure = "stale" | "busy" | "failed";
type PostOutcome = { ok: true; etag: string } | { ok: false; kind: PostFailure };

/** How many times to re-POST through a `busy` (single-flight) collision before giving up. */
const BUSY_RETRY_LIMIT = 3;
const BUSY_RETRY_DELAY_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST the current `$state` to the server with the last-seen ETag as `ifMatch`. */
async function postCurrent(): Promise<PostOutcome> {
  const body: ModelsPostBody = {
    file: projectModelsFile(_models, _defaultModelId),
    ifMatch: _etag ?? "",
  };
  const res = await fetch(`${API_BASE}${API_MODELS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const parsed = (await res.json()) as ModelsPostResponse;
    return { ok: true, etag: parsed.etag };
  }
  const parsed = (await res.json().catch(() => ({}))) as { code?: string };
  if (res.status === 409 && parsed.code === ERROR_CODE_MODELS_STALE) {
    return { ok: false, kind: "stale" };
  }
  if (res.status === 429 && parsed.code === ERROR_CODE_MODELS_BUSY) {
    return { ok: false, kind: "busy" };
  }
  return { ok: false, kind: "failed" };
}

/**
 * `postCurrent` with a bounded retry through `busy` (429) collisions. A `busy`
 * means another writer holds the single-flight; the same body + `ifMatch` is
 * still valid, so a short backoff + re-POST wins once the other write clears —
 * no reload needed. Returns the final outcome (which may itself be `busy` if the
 * limit is exhausted, so the caller can surface a distinct "try again" message).
 */
async function postCurrentWithBusyRetry(): Promise<PostOutcome> {
  let outcome = await postCurrent();
  for (
    let attempt = 1;
    attempt < BUSY_RETRY_LIMIT && !outcome.ok && outcome.kind === "busy";
    attempt++
  ) {
    await delay(BUSY_RETRY_DELAY_MS);
    outcome = await postCurrent();
  }
  return outcome;
}

/**
 * The disposition of a write-through, returned so a caller (e.g. `addModel`) can
 * decide keychain cleanup from an authoritative signal instead of reconstructing
 * it from side effects:
 *   - `committed`   — the user's entry landed on the server (200);
 *   - `reconciled`  — a concurrent writer won; we adopted server state and the
 *                     user's entry did NOT land (persistent 409);
 *   - `rolledback`  — a non-409 failure; `$state` reverted to the pre-mutation snapshot.
 */
type WriteOutcome = "committed" | "reconciled" | "rolledback";

/**
 * Optimistic-then-reconcile server write-through (§3.2). `apply` expresses the
 * user's single intent as an **absolute** (idempotent) mutation of the live
 * `$state` — it runs synchronously FIRST (before any `await`; kills the
 * controlled-input bounce), then the POST is gated on `_reconcileSettled`.
 *   200        → adopt the new etag, clear the error (`committed`);
 *   409 stale  → reload fresh server state, re-apply the intent once, re-POST; if
 *                that still fails → adopt the reconciled server state (never leave
 *                the optimistic mutation standing) + surface the error (`reconciled`);
 *   429 busy   → bounded re-POST in `postCurrentWithBusyRetry`; only if the limit
 *                is exhausted does it fall through to a rollback;
 *   400/500/network → rollback to the pre-mutation snapshot + surface the error.
 */
async function writeThrough(apply: () => void): Promise<WriteOutcome> {
  const commit = (etag: string): "committed" => {
    _etag = etag;
    _saveError = null;
    return "committed";
  };
  const snapshot = { models: _models, defaultModelId: _defaultModelId, etag: _etag };
  const rollback = (message: string): "rolledback" => {
    _models = snapshot.models;
    _defaultModelId = snapshot.defaultModelId;
    _etag = snapshot.etag;
    _saveError = message;
    return "rolledback";
  };
  apply(); // optimistic — synchronous, before any await
  await _reconcileSettled; // R2-B: never POST before reconcile settles
  try {
    const first = await postCurrentWithBusyRetry();
    if (first.ok) return commit(first.etag);
    if (first.kind === "stale") {
      await fetchAndApply(); // adopt fresh server state + etag (ungated — see below)
      apply(); // re-apply the user's single intent against fresh state
      const retry = await postCurrentWithBusyRetry();
      if (retry.ok) return commit(retry.etag);
      // Still stale/busy/failed after a reload+retry — adopt the reconciled
      // server state, don't diverge.
      await fetchAndApply();
      _saveError = "Model registry changed elsewhere; reloaded.";
      return "reconciled";
    }
    // `busy` (retries exhausted) is transient — tell the user to retry rather
    // than implying their change was rejected. `failed` is terminal.
    return rollback(
      first.kind === "busy"
        ? "Model registry is busy; please try again."
        : "Failed to save model changes.",
    );
  } catch (err) {
    // A thrown fetch/JSON error (network drop, unparseable body) — log the cause
    // (the generic `_saveError` string alone is undebuggable) and roll back.
    console.warn("[models] write-through failed", err);
    return rollback("Failed to save model changes.");
  }
}

// --- Load -------------------------------------------------------------------

/**
 * Fetch `GET /api/models` and adopt the result into `$state` (models + default +
 * etag). The UNGATED core: it is only reached from `loadFromServer` (which adds
 * the flag gate) and from `writeThrough`'s 409-reload — and the latter only runs
 * inside a mutator, which is only reachable when the Models UI is mounted (flag
 * on). Throws on a non-OK response so callers can decide (loadFromServer swallows;
 * writeThrough rolls back).
 */
async function fetchAndApply(): Promise<void> {
  const res = await fetch(`${API_BASE}${API_MODELS}`, { method: "GET" });
  if (!res.ok) throw new Error(`GET ${API_MODELS} → ${res.status}`);
  const { file, etag } = (await res.json()) as ModelsGetResponse;
  _models = file.models as ModelRegistryEntry[];
  _defaultModelId = file.defaultModelId;
  _etag = etag;
}

/**
 * Load the registry from the server at boot. Deduped via `_loadInFlight`.
 * `BYO_MODELS_ENABLED`-gated → a dark boot does zero fetch. Driven by
 * `initializeStore` (not an `$effect`/`onMount`). The `$state` writes land in a
 * promise microtask (no active reaction → not a `state_unsafe_mutation`).
 */
export function loadFromServer(): Promise<void> {
  if (!BYO_MODELS_ENABLED) return Promise.resolve();
  if (_loadInFlight) return _loadInFlight;
  _loadInFlight = (async () => {
    try {
      await fetchAndApply();
      _saveError = null;
    } catch {
      // Surface a load error; `_loadInFlight` clears in `finally` so a later
      // load retries.
      _saveError = "Failed to load models from the server.";
    } finally {
      _loadInFlight = null;
    }
  })();
  return _loadInFlight;
}

/**
 * Boot orchestration (owns the reconcile→gate→load ordering in ONE place). Runs
 * the localStorage→server reconcile (un-gated — see the reconcile action),
 * settles the CRUD gate in a `finally` so it opens whenever reconcile COMPLETES
 * (any outcome, or even a throw) — never a permanent CRUD deadlock — then loads
 * the store (BYO-gated, no-op while dark). Fire-and-forget from `main.ts`.
 */
export async function initializeStore(): Promise<void> {
  try {
    await reconcileModelsToServerOnce();
  } finally {
    _settleReconcile();
  }
  await loadFromServer();
}

/**
 * Synchronous snapshot of the store `$state` for non-Svelte callers (the
 * ProseMirror decoration path in `annotation.ts`). Subscription-free read.
 */
export function getModelsSnapshot(): AgentLabelSource {
  return { models: _models, defaultModelId: _defaultModelId };
}

/**
 * The registry the agent LABEL resolves against. While dark the store is never
 * loaded, but v0.13.x users (before `BYO_MODELS_ENABLED` existed) may carry a
 * configured model in localStorage that pre-M2 drove the label — so read
 * localStorage settings while dark (byte-identical to pre-M2) and the
 * server-authoritative store only when lit. This is the load-bearing dark
 * invariant: an empty store must NOT blank a v0.13.x cohort's "GPT"/"Claude"
 * byline to "Assistant".
 *
 * The dark branch reads `loadSettings()` (a plain, NON-reactive localStorage
 * read), so a `$derived` over `agentLabelSource()` does not track settings
 * changes while dark — a deliberate reactivity downgrade from pre-M2. It is
 * unobservable ONLY because every Models edit surface is unmounted while dark
 * (nothing mutates `settings.models` in-session). If a future dark surface writes
 * `settings.models` live, the byline would go stale until remount — surface it
 * through a reactive read then, don't reintroduce a silent staleness.
 */
export function agentLabelSource(): AgentLabelSource {
  if (!BYO_MODELS_ENABLED) {
    const s = loadSettings();
    return { models: s.models, defaultModelId: s.defaultModelId };
  }
  return { models: _models, defaultModelId: _defaultModelId };
}

// --- Facade -----------------------------------------------------------------

export function createModels(): ModelsState {
  return {
    get models() {
      return _models;
    },
    get defaultModelId() {
      return _defaultModelId;
    },
    get saveError() {
      return _saveError;
    },
    get hasLegacyKeys() {
      // Server-backed entries never carry `_legacyApiKey`; always false. See interface doc.
      return _models.some((m) => typeof m._legacyApiKey === "string");
    },
    async addModel(entry, plaintextApiKey) {
      assertValidPatch(entry);
      const id = generateModelId();
      let apiKeyRef: string | undefined;
      if (plaintextApiKey && plaintextApiKey.length > 0) {
        // Secret-before-registry (keychain order): mint + store the secret, then
        // write the registry. If the write does NOT commit, the ref is orphaned.
        apiKeyRef = generateKeyRef();
        await storeSecret(apiKeyRef, plaintextApiKey);
      }
      const next: ModelRegistryEntry = { ...entry, id, ...(apiKeyRef ? { apiKeyRef } : {}) };
      const outcome = await writeThrough(() => {
        _models = [..._models, next];
      });
      // Terminal-only cleanup: the entry landed only when `committed`; on a
      // rollback OR a reconcile-adopt the minted ref backs nothing. Best-effort
      // delete (never throws). Keying on the outcome (not reconstructed side
      // effects) also covers the reconcile-adopt orphan the old guard missed.
      if (apiKeyRef && outcome !== "committed") await keychain.delete(apiKeyRef);
      return id;
    },
    async updateModel(id, patch, plaintextApiKey) {
      assertValidPatch(patch);
      const existing = _models.find((m) => m.id === id);
      if (!existing) return;
      let newRef: string | undefined;
      if (plaintextApiKey !== undefined && plaintextApiKey.length > 0) {
        // Store the NEW secret but do NOT delete the old ref yet — a failed write
        // rolls the entry back to reference `existing.apiKeyRef`, so deleting it
        // eagerly would strand the reverted entry against a missing secret.
        newRef = generateKeyRef();
        await storeSecret(newRef, plaintextApiKey);
      }
      const outcome = await writeThrough(() => {
        _models = _models.map((m) =>
          m.id === id ? { ...m, ...patch, ...(newRef ? { apiKeyRef: newRef } : {}) } : m,
        );
      });
      if (newRef) {
        // The new ref is live only if the entry actually persisted REFERENCING it.
        // `committed` usually implies that — but a concurrent delete of `id`
        // (adopted on the stale-reload path) makes the retry POST an entry-less
        // registry that still 200s "committed", leaving `newRef` referenced by
        // nothing. So confirm the entry+ref survived the write before dropping the
        // old ref; otherwise drop `newRef` (no orphan) and keep the old. Best-effort.
        const landed =
          outcome === "committed" && _models.some((m) => m.id === id && m.apiKeyRef === newRef);
        if (landed) {
          if (existing.apiKeyRef) await keychain.delete(existing.apiKeyRef);
        } else {
          await keychain.delete(newRef);
        }
      }
    },
    async deleteModel(id) {
      const ref = _models.find((m) => m.id === id)?.apiKeyRef;
      const outcome = await writeThrough(() => {
        _models = _models.filter((m) => m.id !== id);
        if (_defaultModelId === id) _defaultModelId = null;
      });
      // Only drop the secret once the delete actually committed; a rollback or a
      // reconcile-adopt may leave the entry (and its ref) still live.
      if (ref && outcome === "committed") await keychain.delete(ref);
    },
    async toggleEnabled(id) {
      // Absolute (idempotent) intent: capture the target so a 409 re-apply after
      // reload flips to the same value, not relative to whatever the server held.
      const target = !_models.find((m) => m.id === id)?.enabled;
      await writeThrough(() => {
        _models = _models.map((m) => (m.id === id ? { ...m, enabled: target } : m));
      });
    },
    async setDefault(id) {
      await writeThrough(() => {
        _defaultModelId = id;
      });
    },
    async migrateLegacyKeys() {
      // No-op: the store loads from the `.strict()` server, which never carries
      // `_legacyApiKey`. Kept for interface stability (SettingsModelsTab wiring).
      return { migrated: 0, failed: 0 };
    },
  };
}

/**
 * Test seam — reset the module singleton to a clean, pre-load state and rearm
 * the reconcile gate. Call in `beforeEach`.
 */
export function _resetModelsStoreForTests(): void {
  _models = [];
  _defaultModelId = null;
  _etag = null;
  _saveError = null;
  _loadInFlight = null;
  _reconcileSettled = new Promise<void>((resolve) => {
    _resolveReconcile = resolve;
  });
}
