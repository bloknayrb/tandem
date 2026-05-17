/**
 * Client-side keychain backend (#477 PR 3c-tauri-keychain).
 *
 * The wizard manipulates secrets via this interface so the underlying
 * transport — HTTP (loopback to the Node sidecar) vs Tauri commands
 * (direct to Rust) — is invisible to the wizard logic.
 *
 * - **HttpKeychainBackend** — POSTs/DELETEs to `/api/integrations/secrets/:ref`.
 *   Used by the npm CLI install path where the Node sidecar has direct OS
 *   keychain access via `@napi-rs/keyring`.
 *
 * - **TauriKeychainBackend** — invokes Rust commands (`keychain_set`,
 *   `keychain_delete`) via `@tauri-apps/api/core`. Used by the Tauri desktop
 *   build where `@napi-rs/keyring` isn't bundled into the sidecar but the
 *   Rust side already has the `keyring` crate. Secrets never traverse the
 *   loopback HTTP boundary in this mode.
 *
 * Both backends share the same return contract — `{ status: "ok" }` |
 * `{ status: "unavailable" }` | `{ status: "error"; message }` — so the
 * wizard never has to branch on transport.
 */

import {
  apiIntegrationsSecretPath,
  ERROR_CODE_KEYCHAIN_UNAVAILABLE,
} from "../../shared/integrations/contract";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { type InvokeFn, keychainDelete, keychainSet, loadInvoke } from "./keychain-invoke";

/** Outcome of a `set` call. The wizard branches on this to drive UX. */
export type KeychainSetResult =
  | { status: "ok" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface ClientKeychainBackend {
  set(ref: string, secret: string): Promise<KeychainSetResult>;
  /** Best-effort. Errors are swallowed because cleanup runs post-failure. */
  delete(ref: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP backend (npm CLI install path)
// ---------------------------------------------------------------------------

interface HttpBackendOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

export function createHttpKeychainBackend(opts: HttpBackendOptions = {}): ClientKeychainBackend {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.baseUrl ?? "";
  return {
    async set(ref, secret) {
      try {
        const res = await fetchFn(`${baseUrl}${apiIntegrationsSecretPath(ref)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
        });
        if (res.status === 503) {
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          if (body?.code === ERROR_CODE_KEYCHAIN_UNAVAILABLE) return { status: "unavailable" };
        }
        if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };
        return { status: "ok" };
      } catch (err) {
        return { status: "error", message: err instanceof Error ? err.message : String(err) };
      }
    },
    async delete(ref) {
      await fetchFn(`${baseUrl}${apiIntegrationsSecretPath(ref)}`, { method: "DELETE" }).catch(
        () => {
          /* best-effort */
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tauri backend (Tauri desktop app)
// ---------------------------------------------------------------------------

interface TauriBackendOptions {
  /** Test seam — production loads `@tauri-apps/api/core`. */
  invoke?: InvokeFn;
}

export function createTauriKeychainBackend(opts: TauriBackendOptions = {}): ClientKeychainBackend {
  // Cache the invoke resolution — there's no reason to re-import per call.
  let invokePromise: Promise<InvokeFn> | null = null;
  const getInvoke = (): Promise<InvokeFn> => {
    if (opts.invoke) return Promise.resolve(opts.invoke);
    invokePromise ??= loadInvoke();
    return invokePromise;
  };

  return {
    async set(ref, secret) {
      try {
        const invoke = await getInvoke();
        await keychainSet(invoke, ref, secret);
        return { status: "ok" };
      } catch (err) {
        // Tauri commands surface a string; the wizard maps "keychain-*" prefixes
        // to a generic "unavailable" only when we can confirm the keyring crate
        // itself failed (init error or platform unsupported). Any other error
        // is a real failure that should be reported, not swallowed.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("keychain-init") || message.includes("PlatformFailure")) {
          return { status: "unavailable" };
        }
        return { status: "error", message };
      }
    },
    async delete(ref) {
      try {
        const invoke = await getInvoke();
        await keychainDelete(invoke, ref);
      } catch {
        /* best-effort */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

interface DefaultBackendOptions extends HttpBackendOptions, TauriBackendOptions {
  /** Force a specific backend, overriding the Tauri-runtime detection. */
  force?: "http" | "tauri";
}

/**
 * Pick the right backend for the current runtime. Tauri context uses the
 * Rust bridge; everything else (browser, npm CLI install) uses the HTTP
 * loopback to the Node sidecar.
 */
export function createDefaultKeychainBackend(
  opts: DefaultBackendOptions = {},
): ClientKeychainBackend {
  const useTauri = opts.force === "tauri" || (opts.force !== "http" && isTauriRuntime());
  return useTauri
    ? createTauriKeychainBackend({ invoke: opts.invoke })
    : createHttpKeychainBackend({ fetchFn: opts.fetchFn, baseUrl: opts.baseUrl });
}
