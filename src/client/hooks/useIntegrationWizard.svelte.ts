/**
 * Integration wizard state machine (#477 PR 3c-i).
 *
 * Drives the wizard modal through four steps:
 *   detect   — `GET /api/integrations/existing` populates the "we found these"
 *              preview from `~/.claude.json` + Claude Desktop config.
 *   pick     — user toggles which integrations to register. The picked list
 *              starts pre-selected with whatever was detected.
 *   secrets  — for each picked integration, optionally enter an auth token.
 *              The token is sent to `POST /api/integrations/secrets/:ref` and
 *              the resulting opaque `ref` is stored on the integration record.
 *              `KEYCHAIN_UNAVAILABLE` (503) flips the step into env-var
 *              fallback guidance — the user is told to set
 *              `TANDEM_INTEGRATION_<id>_TOKEN` instead, and the integration
 *              is saved without a `tokenSecretRef`.
 *   review   — final confirmation; `POST /api/integrations` writes the file.
 *
 * The wizard never owns secrets in memory beyond the duration of the
 * secrets step — each `setSecret` POST happens immediately on submit, not
 * batched, so an interrupted session doesn't strand a secret in the page's
 * heap.
 *
 * **Tauri keychain limitation:** when the Tauri sidecar bundle can't
 * resolve `@napi-rs/keyring` (until the Rust bridge follow-up ships),
 * the server returns 503 + KEYCHAIN_UNAVAILABLE on every `setSecret`
 * call and the wizard surfaces env-var fallback guidance.
 */

import {
  API_INTEGRATIONS,
  API_INTEGRATIONS_EXISTING,
  type ExistingMcpInstall,
  INTEGRATIONS_SCHEMA_VERSION,
  type IntegrationConfig,
  type IntegrationsFile,
} from "../../shared/integrations/contract.js";
import {
  type ClientKeychainBackend,
  createDefaultKeychainBackend,
} from "../keychain/keychain-backend.js";

export type WizardStep = "detect" | "pick" | "secrets" | "review" | "saving" | "done" | "error";

export interface PickedIntegration {
  /** Stable client-side id, mirrored into `IntegrationConfig.id` on save. */
  id: string;
  config: IntegrationConfig;
  /** User-entered secret pending submission. Cleared once the secret is POSTed. */
  pendingSecret?: string;
  /** Server-issued ref returned from `POST /api/integrations/secrets/:ref` (we send our own ref). */
  hasStoredSecret: boolean;
  /** True iff the server returned 503 KEYCHAIN_UNAVAILABLE for this integration's setSecret. */
  keychainUnavailable: boolean;
}

export interface IntegrationWizardState {
  readonly step: WizardStep;
  readonly existing: ExistingMcpInstall[];
  readonly picked: PickedIntegration[];
  readonly errorMessage: string | null;
  /** Whether the keychain is known-unavailable on this server (set after first 503). */
  readonly keychainUnavailable: boolean;
  begin(): Promise<void>;
  advanceToPick(): void;
  setPicked(picked: PickedIntegration[]): void;
  advanceToSecrets(): void;
  submitSecret(picked: PickedIntegration, secret: string): Promise<void>;
  advanceToReview(): void;
  save(): Promise<void>;
  reset(): void;
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

export interface IntegrationWizardOptions {
  /** Override `window.fetch` for tests. */
  fetchFn?: typeof fetch;
  /**
   * Override the base URL for API calls. Defaults to same-origin (empty string),
   * which is what the dev Vite server proxies and what production serves.
   */
  baseUrl?: string;
  /**
   * Inject a custom keychain backend (#477 PR 3c-tauri-keychain). Defaults to
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

  let step = $state<WizardStep>("detect");
  let existing = $state<ExistingMcpInstall[]>([]);
  let picked = $state<PickedIntegration[]>([]);
  let errorMessage = $state<string | null>(null);
  let keychainUnavailable = $state(false);
  // Monotonic generation counter for `begin()` — a later run invalidates
  // earlier in-flight responses so rapid open/close/reopen can't have the
  // earlier request's response clobber the later one's state.
  let beginGen = 0;

  const setError = (msg: string) => {
    errorMessage = msg;
    step = "error";
  };

  const begin = async () => {
    const myGen = ++beginGen;
    step = "detect";
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
    } catch (err) {
      if (myGen !== beginGen) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const advanceToPick = () => {
    step = "pick";
  };

  const setPicked = (next: PickedIntegration[]) => {
    picked = next;
  };

  const advanceToSecrets = () => {
    step = "secrets";
  };

  const submitSecret = async (target: PickedIntegration, secret: string) => {
    const ref = makeSecretRef(target.id);
    const result = await keychainBackend.set(ref, secret);
    if (result.status === "unavailable") {
      keychainUnavailable = true;
      picked = picked.map((p) =>
        p.id === target.id ? { ...p, keychainUnavailable: true, pendingSecret: undefined } : p,
      );
      return;
    }
    if (result.status === "error") {
      setError(`Could not store secret: ${result.message}`);
      return;
    }
    picked = picked.map((p) =>
      p.id === target.id
        ? {
            ...p,
            config: { ...p.config, tokenSecretRef: ref } as IntegrationConfig,
            hasStoredSecret: true,
            pendingSecret: undefined,
            keychainUnavailable: false,
          }
        : p,
    );
  };

  const advanceToReview = () => {
    step = "review";
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

  const save = async () => {
    step = "saving";
    const file: IntegrationsFile = {
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: picked.map((p) => p.config),
    };
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(file),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        await cleanupStoredSecrets();
        setError(body?.message ?? `Could not save (HTTP ${res.status}).`);
        return;
      }
      step = "done";
    } catch (err) {
      await cleanupStoredSecrets();
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    step = "detect";
    existing = [];
    picked = [];
    errorMessage = null;
    keychainUnavailable = false;
  };

  return {
    get step() {
      return step;
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
    get keychainUnavailable() {
      return keychainUnavailable;
    },
    begin,
    advanceToPick,
    setPicked,
    advanceToSecrets,
    submitSecret,
    advanceToReview,
    save,
    reset,
  };
}
