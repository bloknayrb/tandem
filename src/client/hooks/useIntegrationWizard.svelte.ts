/**
 * Integration wizard state machine.
 *
 * Drives the wizard modal through three steps (+ error):
 *   connect  — `GET /api/integrations/existing` populates the "we found these"
 *              card list from `~/.claude.json` + Claude Desktop config.
 *              Selectable installs are preselected as soon as detection
 *              resolves (`isSelectable` — see below). The user toggles cards
 *              and may optionally store an auth token per integration under
 *              an Advanced disclosure: the token goes to the keychain backend
 *              under a client-generated opaque `ref` (`makeSecretRef`), which
 *              is then recorded on the integration config as `tokenSecretRef`.
 *              A `KEYCHAIN_UNAVAILABLE` result flips the disclosure into
 *              env-var fallback guidance — the user is told to set
 *              `TANDEM_INTEGRATION_<id>_TOKEN` instead, and the integration
 *              is saved without a `tokenSecretRef`.
 *   applying — `save()` in flight: `POST /api/integrations` persists, then
 *              `POST /api/integrations/apply` writes Claude's config.
 *   done     — per-integration apply outcomes.
 *
 * The wizard never owns secrets in memory beyond the duration of the
 * Advanced disclosure — each `setSecret` happens immediately on submit, not
 * batched, so an interrupted session doesn't strand a secret in the page's
 * heap. The keychain backend abstracts the transport: HTTP loopback to
 * `POST /api/integrations/secrets/:ref` on the npm CLI path, and a direct Rust
 * `invoke` in the desktop app (secrets never cross the loopback boundary
 * there — see `keychain-backend.ts`). `KEYCHAIN_UNAVAILABLE` is one possible
 * backend outcome, not a guaranteed desktop one.
 */

import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import {
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_EXISTING,
  type ApplyItemResult,
  type ApplyResponse,
  type ExistingMcpInstall,
  INTEGRATIONS_SCHEMA_VERSION,
  type IntegrationConfig,
  type IntegrationsFile,
} from "../../shared/integrations/contract.js";
import {
  type ClientKeychainBackend,
  createDefaultKeychainBackend,
} from "../keychain/keychain-backend.js";

export type WizardStep = "connect" | "applying" | "done" | "error";

export interface PickedIntegration {
  /** Stable client-side id, mirrored into `IntegrationConfig.id` on save. */
  id: string;
  config: IntegrationConfig;
  /** True once a token has been stored in the keychain for this integration
   *  (the ref itself lives on `config.tokenSecretRef`); drives the "Token
   *  saved" UI state. */
  hasStoredSecret: boolean;
  /** True iff the server returned 503 KEYCHAIN_UNAVAILABLE for this integration's setSecret. */
  keychainUnavailable: boolean;
}

export interface IntegrationWizardState {
  readonly step: WizardStep;
  /** True while `begin()`'s detection fetch is in flight. Distinguishes the
   *  connect screen's loading sub-state from a genuine "nothing detected"
   *  empty state (`existing` is `[]` in both). Initializes `true` so the
   *  first paint (before the open-effect's `begin()` runs) shows loading
   *  rather than flashing the empty state. */
  readonly detecting: boolean;
  readonly existing: ExistingMcpInstall[];
  readonly picked: PickedIntegration[];
  readonly errorMessage: string | null;
  /** Per-integration apply outcomes after save() succeeds. Populated only when
   *  step === "done"; consult the `status === "error"` items to surface
   *  per-row error UX in the wizard's done step. */
  readonly applyResults: ApplyItemResult[];
  /**
   * Whether real-time push (the `tandem-channel` shim entry) actually landed on
   * disk for an applied claude-code target, determined by a post-apply re-read
   * of the detected entries (WS-B). `true` → push configured (Claude gets pushed
   * events after a restart); `false` → polling only; `null` → not yet
   * determined (or no claude-code target), so the done step shows nothing rather
   * than flashing a wrong label. This is a CONFIG-presence fact, never a runtime
   * "push is live now" claim — the shim still needs Claude to restart + connect.
   */
  readonly channelRegistered: boolean | null;
  /** Whether the keychain is known-unavailable on this server (set after first 503). */
  readonly keychainUnavailable: boolean;
  begin(): Promise<void>;
  setPicked(picked: PickedIntegration[]): void;
  submitSecret(picked: PickedIntegration, secret: string): Promise<void>;
  save(): Promise<void>;
  reset(): void;
  /** Delete keychain secrets stored under Advanced but never persisted (the
   *  user dismissed before saving). No-op unless step === "connect", so it can
   *  never delete a live, file-referenced ref. Call BEFORE reset(). */
  cleanupUnsavedSecrets(): Promise<void>;
}

/**
 * The single source of truth for "the on-disk tandem entry is hand-edited /
 * invalid, leave it alone". Shared by `isSelectable` (preselection), `save()`
 * (apply: "skip"), and the card's status line — these three must never
 * diverge or the UI lies about what apply will do.
 */
export function tandemEntryValidationFailed(install: ExistingMcpInstall): boolean {
  return install.tandemValidation !== undefined && install.tandemValidation.status !== "valid";
}

/**
 * Whether a detected install should be offered (and preselected) for
 * connection — readable on disk AND not locked by a failed entry validation.
 */
export function isSelectable(install: ExistingMcpInstall): boolean {
  const readable = install.status === "ok" || install.status === "missing";
  return readable && !tandemEntryValidationFailed(install);
}

/**
 * Generate a tokenSecretRef for a picked integration. Uses the integration's
 * `id` + a CSPRNG-derived suffix so the keychain entry is identifiable in OS
 * keychain UIs ("tandem-integrations / cc-1-9f3a…") and a refused-write retry
 * doesn't reuse a stale ref.
 *
 * `crypto.randomUUID()` provides 122 bits of CSPRNG entropy — far more than
 * needed for collision resistance among a single user's keychain entries.
 * Math.random() is not cryptographically secure (CodeQL js/insecure-randomness)
 * and would be misleading in this security context even if practically safe.
 */
function makeSecretRef(integrationId: string): string {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${integrationId}-${suffix}`;
}

/**
 * Build a stable id. `Date.now()` has only millisecond resolution and
 * `IntegrationsFileSchema` doesn't reject duplicate ids — two rapid picks
 * in the same tick would silently overwrite each other downstream.
 */
function newPickedId(kindPrefix: string): string {
  return `${kindPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Map a detected install to a fresh `PickedIntegration`. Returns null for
 * target kinds the wizard can't auto-configure (none today — detection only
 * surfaces claude-code / claude-desktop — but the shape is future-proof).
 */
export function detectedToPicked(install: ExistingMcpInstall): PickedIntegration | null {
  if (install.target.kind === "claude-code") {
    const url = install.tandemEntry?.url ?? `http://127.0.0.1:${DEFAULT_MCP_PORT}`;
    const id = newPickedId("claude-code");
    return {
      id,
      config: {
        kind: "claude-code",
        id,
        label: install.target.label,
        configPath: install.target.configPath,
        transport: "http",
        url,
      },
      hasStoredSecret: false,
      keychainUnavailable: false,
    };
  }
  if (install.target.kind === "claude-desktop") {
    const id = newPickedId("claude-desktop");
    return {
      id,
      config: {
        kind: "claude-desktop",
        id,
        label: install.target.label,
        configPath: install.target.configPath,
        transport: "stdio",
      },
      hasStoredSecret: false,
      keychainUnavailable: false,
    };
  }
  return null;
}

export interface IntegrationWizardOptions {
  /** Override `window.fetch` for tests. */
  fetchFn?: typeof fetch;
  /**
   * Override the base URL for API calls. Defaults to same-origin (empty string),
   * which is what the dev Vite server proxies and what production serves.
   */
  baseUrl?: string;
  /**
   * Inject a custom keychain backend. Defaults to
   * `createDefaultKeychainBackend()` which picks Tauri commands when running
   * inside the desktop app and the HTTP loopback elsewhere. Tests pass a
   * stub backend so the wizard logic can be verified without either transport.
   */
  keychainBackend?: ClientKeychainBackend;
}

export function createIntegrationWizard(
  opts: IntegrationWizardOptions = {},
): IntegrationWizardState {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.baseUrl ?? "";
  const keychainBackend =
    opts.keychainBackend ?? createDefaultKeychainBackend({ fetchFn, baseUrl });

  let step = $state<WizardStep>("connect");
  // True so the first paint (before the open-effect's begin()) shows the
  // loading sub-state instead of flashing "nothing detected".
  let detecting = $state(true);
  let existing = $state<ExistingMcpInstall[]>([]);
  let picked = $state<PickedIntegration[]>([]);
  let errorMessage = $state<string | null>(null);
  let applyResults = $state<ApplyItemResult[]>([]);
  // Post-apply push-vs-polling readout (WS-B). `null` until the post-apply
  // re-read of detected entries resolves — never flash a wrong label.
  let channelRegistered = $state<boolean | null>(null);
  let keychainUnavailable = $state(false);
  // Monotonic generation counter for `begin()` — a later run invalidates
  // earlier in-flight responses so rapid open/close/reopen can't have the
  // earlier request's response clobber the later one's state.
  let beginGen = 0;

  const setError = (msg: string) => {
    errorMessage = msg;
    step = "error";
    detecting = false;
  };

  const begin = async () => {
    const myGen = ++beginGen;
    detecting = true;
    step = "connect";
    errorMessage = null;
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_EXISTING}`);
      if (myGen !== beginGen) return; // a newer begin() ran; drop this response
      if (!res.ok) {
        setError(`Could not load existing entries (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as { installs: ExistingMcpInstall[] };
      if (myGen !== beginGen) return;
      existing = body.installs;
      // Preselect everything connectable as soon as detection resolves —
      // the connect screen renders cards pre-checked, no separate pick step.
      picked = body.installs
        .filter(isSelectable)
        .map(detectedToPicked)
        .filter((p): p is PickedIntegration => p !== null);
    } catch (err) {
      if (myGen !== beginGen) return;
      // A network failure (server not up yet — common on first launch) rejects
      // with a TypeError whose message varies by engine: Chromium "Failed to
      // fetch", WKWebView (Tauri macOS) "Load failed", Firefox "NetworkError
      // when attempting to fetch resource". Match those so we surface an
      // actionable message — but gate on the message so a genuine programming
      // TypeError (e.g. a structural error in the preselect chain above) falls
      // through to its real text instead of being mislabeled "server unreachable".
      if (err instanceof TypeError && /fetch|load failed|network/i.test(err.message)) {
        setError("Could not reach the Tandem server. Make sure Tandem is running, then try again.");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only the winning generation clears the loading flag — a superseded
      // begin() finishing late must not hide the newer run's loading state.
      if (myGen === beginGen) detecting = false;
    }
  };

  const setPicked = (next: PickedIntegration[]) => {
    // Best-effort: if an entry that already stored a secret is removed from
    // the selection (unchecking a card after entering a token under Advanced),
    // delete its keychain ref so it isn't orphaned. The single-screen redesign
    // makes store-then-unpick reachable; the old multi-step flow picked before
    // the separate secrets step, so this couldn't happen. Errors are swallowed
    // — an unreferenced ref in the user's own keychain isn't worth a toast.
    const dropped = picked.filter(
      (prev) => prev.config.tokenSecretRef && !next.some((n) => n.id === prev.id),
    );
    picked = next;
    for (const p of dropped) {
      const ref = p.config.tokenSecretRef;
      if (ref) void keychainBackend.delete(ref);
    }
  };

  const submitSecret = async (target: PickedIntegration, secret: string) => {
    const ref = makeSecretRef(target.id);
    const result = await keychainBackend.set(ref, secret);
    if (result.status === "unavailable") {
      keychainUnavailable = true;
      picked = picked.map((p) => (p.id === target.id ? { ...p, keychainUnavailable: true } : p));
      return;
    }
    if (result.status === "error") {
      // The ref is never recorded on the picked entry below, so neither
      // cleanupStoredSecrets nor the unpick cleanup could ever find it if the
      // backend wrote it but then failed the response. Best-effort delete of
      // the freshly-generated ref undoes a possible partial write (a no-op if
      // nothing was stored).
      void keychainBackend.delete(ref);
      setError(`Could not store secret: ${result.message}`);
      return;
    }
    picked = picked.map((p) =>
      p.id === target.id
        ? {
            ...p,
            config: { ...p.config, tokenSecretRef: ref } as IntegrationConfig,
            hasStoredSecret: true,
            keychainUnavailable: false,
          }
        : p,
    );
  };

  /**
   * Best-effort cleanup: when save fails after `submitSecret` calls have
   * already stored secrets in the OS keychain, delete each one so the user
   * isn't left with orphan credentials referenced by no integrations file.
   * Errors are swallowed because cleanup is post-failure — surfacing a
   * second error would replace the more actionable original.
   */
  const cleanupStoredSecrets = async (): Promise<void> => {
    const storedRefs = picked
      .map((p) => p.config.tokenSecretRef)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    await Promise.all(storedRefs.map((ref) => keychainBackend.delete(ref)));
  };

  /**
   * Two-call sequence separating intent (persist) from side-effect (apply)
   * — see ADR-038 §2b. The apply response flows back through
   * `applyResults` so the done step can surface per-integration failures.
   */
  /**
   * Post-apply re-read of detected entries, to report whether the channel-shim
   * (real-time push) entry actually landed on disk. Best-effort: a failed read
   * leaves `channelRegistered` null and the done step simply omits the line. The
   * `step === "done"` guard stops a late resolve from writing after a
   * close/reopen. NOT keyed per-target — an aggregate "any applied claude-code
   * target got a valid channel entry" is enough for the single info line.
   */
  const refreshChannelRegistered = async () => {
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_EXISTING}`);
      if (!res.ok) return;
      const body = (await res.json()) as { installs: ExistingMcpInstall[] };
      if (step !== "done") return;
      channelRegistered = body.installs.some(
        (i) =>
          i.target.kind === "claude-code" &&
          i.channelEntry !== undefined &&
          i.channelValidation?.status === "valid",
      );
    } catch {
      // best-effort — leave channelRegistered null
    }
  };

  const save = async () => {
    step = "applying";
    channelRegistered = null;
    // Determine apply intent per picked integration. Failed-validation
    // existing entries pre-set to "skip" so re-validated entries don't
    // get overwritten with a wizard-generated shape that differs (the
    // user hand-edited a tandem entry to a custom shape; the apply path
    // would silently replace it with our canonical shape and erase the
    // customization).
    const integrations: IntegrationConfig[] = picked.map((p) => {
      // `other-mcp` is constrained to apply: "skip" by the schema.
      if (p.config.kind === "other-mcp") {
        return { ...p.config, apply: "skip" } as IntegrationConfig;
      }
      // Match the picked entry against the existing-config validation
      // result by configPath (the natural key for both claude-code and
      // claude-desktop). If the on-disk entry exists and failed
      // validation, apply: "skip".
      const configPath = p.config.configPath;
      const matched = existing.find((e) => e.target.configPath === configPath);
      const validationFailed = matched !== undefined && tandemEntryValidationFailed(matched);
      return {
        ...p.config,
        apply: validationFailed ? "skip" : "create",
      } as IntegrationConfig;
    });
    const file: IntegrationsFile = {
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations,
    };
    // Once persist returns 200 the integrations file on disk durably
    // references the stored keychain refs, so the catch below must NOT delete
    // them — doing so would dangle the persisted config (and, if apply also
    // ran, Claude's freshly-written config), surfacing as a SECRET_MISSING
    // failure on next use with no trace of the deletion. Only the pre-persist
    // failure path cleans up. Realistic post-persist throw vectors: a network
    // drop before/after the apply fetch, or an unguarded `.json()` parse of a
    // malformed 200 body (lines below).
    let persisted = false;
    try {
      const persistRes = await fetchFn(`${baseUrl}${API_INTEGRATIONS}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(file),
      });
      if (!persistRes.ok) {
        const body = (await persistRes.json().catch(() => null)) as { message?: string } | null;
        await cleanupStoredSecrets();
        setError(body?.message ?? `Could not save (HTTP ${persistRes.status}).`);
        return;
      }
      persisted = true;
      const persistBody = (await persistRes.json()) as {
        ids: string[];
        confirmationNonce: string;
      };

      // Apply — write the persisted entries to Claude's config.
      const applyRes = await fetchFn(`${baseUrl}${API_INTEGRATIONS_APPLY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: persistBody.ids,
          confirmationNonce: persistBody.confirmationNonce,
        }),
      });
      if (!applyRes.ok) {
        const body = (await applyRes.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `Could not apply (HTTP ${applyRes.status}).`);
        return;
      }
      const applyBody = (await applyRes.json()) as ApplyResponse;
      applyResults = applyBody.results;
      step = "done";
      // Re-read entries so the done step can honestly report push-vs-polling —
      // the pre-apply `existing` snapshot predates the channel-entry write.
      void refreshChannelRegistered();
    } catch (err) {
      // Skip cleanup once persisted — see the comment above the try.
      if (!persisted) await cleanupStoredSecrets();
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    step = "connect";
    detecting = false;
    existing = [];
    picked = [];
    errorMessage = null;
    applyResults = [];
    channelRegistered = null;
    keychainUnavailable = false;
  };

  /**
   * Delete keychain secrets stored under Advanced but never persisted — the
   * user pasted a token then dismissed before saving. Gated on `step ===
   * "connect"`: a live, file-referenced ref only exists once persist succeeds,
   * after which step is "done" or "error" — never "connect" — so this can
   * never re-introduce the SECRET_MISSING orphan that 498b7bb fixed. Reads
   * `picked` synchronously (via cleanupStoredSecrets) so callers may invoke it
   * immediately before reset() clears `picked`.
   */
  const cleanupUnsavedSecrets = async (): Promise<void> => {
    if (step !== "connect") return;
    await cleanupStoredSecrets();
  };

  return {
    get step() {
      return step;
    },
    get detecting() {
      return detecting;
    },
    get existing() {
      return existing;
    },
    get picked() {
      return picked;
    },
    get errorMessage() {
      return errorMessage;
    },
    get applyResults() {
      return applyResults;
    },
    get channelRegistered() {
      return channelRegistered;
    },
    get keychainUnavailable() {
      return keychainUnavailable;
    },
    begin,
    setPicked,
    submitSecret,
    save,
    reset,
    cleanupUnsavedSecrets,
  };
}
