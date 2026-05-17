/**
 * Typed Tauri-command wrappers for integration keychain access
 * (#477 PR 3c-tauri-keychain). Mirrors the `cowork-invoke.ts` pattern.
 *
 * The wizard (`useIntegrationWizard.svelte.ts`) detects whether we're in
 * Tauri at construction time and chooses between the HTTP backend (which
 * proxies through the Node sidecar — the only option for npm CLI installs)
 * and the Tauri backend (which dispatches directly to Rust, bypassing the
 * sidecar entirely so secrets never traverse the loopback HTTP boundary).
 *
 * The Rust commands live in `src-tauri/src/keychain.rs` and use the
 * `keyring` crate to talk to:
 *   - macOS:   Keychain Services
 *   - Windows: Credential Manager
 *   - Linux:   Secret Service (libsecret/dbus)
 *
 * Service namespace `"tandem-integrations"` matches `KEYCHAIN_SERVICE` in
 * `src/server/integrations/keychain.ts` so the npm CLI path and the Tauri
 * path share keychain entries when a user runs both.
 */

import { isTauriRuntime } from "../cowork/cowork-helpers";

export type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const TAURI_NOT_AVAILABLE = "Tauri runtime not available";

/**
 * Lazily resolve the real Tauri `invoke`. Falls back to a rejecting stub
 * when not running inside Tauri — callers must guard with `isTauriRuntime()`
 * before using this backend.
 */
export async function loadInvoke(): Promise<InvokeFn> {
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke as InvokeFn;
  } catch (err) {
    if (isTauriRuntime()) {
      console.error("[keychain] Failed to load @tauri-apps/api/core:", err);
    }
    return (() => Promise.reject(new Error(TAURI_NOT_AVAILABLE))) as InvokeFn;
  }
}

/**
 * Read a stored secret. Returns `null` if no entry exists under `account`
 * (Tauri command returns `Option<String>` which serializes to JSON `null`).
 * Throws when the keychain itself is inaccessible.
 */
export function keychainGet(invoke: InvokeFn, account: string): Promise<string | null> {
  return invoke<string | null>("keychain_get", { account });
}

/** Store or overwrite a secret. */
export function keychainSet(invoke: InvokeFn, account: string, secret: string): Promise<void> {
  return invoke<void>("keychain_set", { account, secret });
}

/** Remove a secret. Returns `true` if one was deleted, `false` if absent. */
export function keychainDelete(invoke: InvokeFn, account: string): Promise<boolean> {
  return invoke<boolean>("keychain_delete", { account });
}
