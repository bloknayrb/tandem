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

/**
 * Pinned to keyring v3.6.3's `Display` impl (see `error.rs:64-67`). The
 * substrings come from the crate's actual formatted output — NOT the Debug
 * variant names. Update this list if the crate's error formatting changes.
 */
const KEYRING_UNAVAILABLE_MARKERS = [
  // Rust-side init guard (account-empty or Entry::new failure).
  "keychain-init",
  // keyring::Error::PlatformFailure — e.g. libsecret missing on Linux.
  "Platform secure storage failure",
  // keyring::Error::NoStorageAccess — e.g. dbus not reachable, keychain locked.
  "Couldn't access platform secure storage",
];

function isKeychainUnavailableMessage(message: string): boolean {
  return KEYRING_UNAVAILABLE_MARKERS.some((marker) => message.includes(marker));
}

export function createTauriKeychainBackend(opts: TauriBackendOptions = {}): ClientKeychainBackend {
  // Don't memoize the result of `loadInvoke()` — when it fails to import
  // `@tauri-apps/api/core` it returns a permanently-rejecting stub that
  // emits TAURI_NOT_AVAILABLE. Caching that would poison the backend for
  // the process lifetime. The ESM module loader caches successful imports
  // by spec, so calling `loadInvoke()` per request is cheap in the happy
  // path while preserving the ability to recover from a transient import
  // failure (e.g. dev-time package reinstall).
  const getInvoke = (): Promise<InvokeFn> => {
    if (opts.invoke) return Promise.resolve(opts.invoke);
    return loadInvoke();
  };

  return {
    async set(ref, secret) {
      try {
        const invoke = await getInvoke();
        await keychainSet(invoke, ref, secret);
        return { status: "ok" };
      } catch (err) {
        // Tauri commands surface a string. We map to `unavailable` only when
        // we can confirm the keyring crate itself is the failing layer (init
        // error or the platform's secure storage is unreachable). Other
        // errors are real and should be reported, not swallowed.
        //
        // Substring choices are pinned to keyring v3.6.3's Display impl
        // (`error.rs` lines 64-67) — the actual emitted strings, not the
        // Debug variant names. See PR 3c-tauri-keychain's adversarial review
        // for the bug this catches.
        const message = err instanceof Error ? err.message : String(err);
        if (isKeychainUnavailableMessage(message)) return { status: "unavailable" };
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
  /**
   * **Tests only.** Force a specific backend, overriding the Tauri-runtime
   * detection. Production call sites should leave this undefined — the
   * default (`isTauriRuntime()` → Tauri, else HTTP) is the only correct
   * choice for the npm CLI install path and the desktop app respectively.
   */
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
