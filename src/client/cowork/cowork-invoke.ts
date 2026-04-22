/**
 * Typed wrappers around Tauri's cowork invoke commands. Each wrapper accepts
 * an `InvokeFn` so tests can mock the call without needing the
 * `@tauri-apps/api/core` import to resolve under vitest.
 */

import { isTauriRuntime } from "../cowork/cowork-helpers";
import type { CoworkStatus } from "../types";

/**
 * The shape of `@tauri-apps/api/core` `invoke`. Kept minimal so tests can
 * supply a stub without importing Tauri.
 */
export type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Lazily resolve the real Tauri `invoke`. Falls back to a rejecting stub
 * when not running inside Tauri — callers must guard with `isTauriRuntime()`
 * or handle the rejection and surface a toast.
 */
export const TAURI_NOT_AVAILABLE = "Tauri runtime not available";

export async function loadInvoke(): Promise<InvokeFn> {
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke as InvokeFn;
  } catch (err) {
    if (isTauriRuntime()) {
      console.error("[cowork] Failed to load @tauri-apps/api/core:", err);
    }
    return (() => Promise.reject(new Error(TAURI_NOT_AVAILABLE))) as InvokeFn;
  }
}

// ----- Wrappers -----------------------------------------------------------

export function coworkGetStatus(invoke: InvokeFn): Promise<CoworkStatus> {
  return invoke<CoworkStatus>("cowork_get_status");
}

export function coworkToggleIntegration(invoke: InvokeFn, enabled: boolean): Promise<{ ok: true }> {
  return invoke<{ ok: true }>("cowork_toggle_integration", { enabled });
}

export function coworkRescan(invoke: InvokeFn): Promise<string> {
  return invoke<string>("cowork_rescan");
}

export function coworkSetLanIpOverride(invoke: InvokeFn, enabled: boolean): Promise<{ ok: true }> {
  return invoke<{ ok: true }>("cowork_set_lan_ip_override", { enabled });
}

export function coworkRetryAdminElevation(invoke: InvokeFn): Promise<{ ok: true }> {
  return invoke<{ ok: true }>("cowork_retry_admin_elevation");
}
