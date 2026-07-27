/**
 * Typed wrappers around the start-at-login Tauri commands (#1236).
 *
 * Mirrors `src/client/cowork/cowork-invoke.ts`: each wrapper takes an
 * `InvokeFn` so vitest can stub the call without resolving
 * `@tauri-apps/api/core`.
 *
 * These are app-defined commands (`src-tauri/src/autostart.rs`), not the
 * `tauri-plugin-autostart` JS API — so there is no npm dependency on the
 * plugin and no `autostart:default` capability grant. The Rust side owns
 * readback-after-write and error redaction.
 */

import { type InvokeFn, loadInvoke } from "../cowork/cowork-invoke";

export type { InvokeFn };
export { loadInvoke };

/** Path-free error codes. Mirrors the `ERR_*` consts in `autostart.rs`. */
export type AutostartErrorCode = "io-error" | "readback-mismatch" | "plugin-error";

export interface AutostartStatus {
  /** Read live from the OS on every call — never mirrored into
   * `tandem:settings`, because the registration is mutable outside Tandem. */
  enabled: boolean;
  /** False when no tray icon could be constructed. A boot launch would then be
   * unreachable, so the toggle is disabled rather than silently useless. */
  trayAvailable: boolean;
  error: AutostartErrorCode | null;
}

export function autostartGetStatus(invoke: InvokeFn): Promise<AutostartStatus> {
  return invoke<AutostartStatus>("autostart_get_status");
}

/**
 * Enable or disable start-at-login.
 *
 * The returned `enabled` is the value read back FROM THE OS after the write,
 * not the value requested — so a write that silently didn't take surfaces as an
 * unchanged toggle plus `readback-mismatch`.
 */
export function autostartSetEnabled(invoke: InvokeFn, enabled: boolean): Promise<AutostartStatus> {
  return invoke<AutostartStatus>("autostart_set_enabled", { enabled });
}

/** User-facing message for a redacted error code. */
export function autostartErrorMessage(code: AutostartErrorCode): string {
  switch (code) {
    case "readback-mismatch":
      return "The setting didn't stick. Your system may be blocking startup items.";
    case "io-error":
      return "Couldn't write the startup entry. Check your system permissions.";
    default:
      return "Couldn't change the startup setting.";
  }
}
