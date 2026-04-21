/**
 * Typed wrappers around the Tauri invoke commands shipped by PR e. Each
 * wrapper accepts an `InvokeFn` so tests can mock the call without needing
 * the `@tauri-apps/api/core` import to resolve under vitest.
 */

import type { CoworkStatus, WorkspaceStatus } from "../types";

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
export async function loadInvoke(): Promise<InvokeFn> {
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke as InvokeFn;
  } catch {
    return (() => Promise.reject(new Error("Tauri runtime not available"))) as InvokeFn;
  }
}

// ----- Wrappers -----------------------------------------------------------

export function coworkGetStatus(invoke: InvokeFn): Promise<CoworkStatus> {
  return invoke<CoworkStatus>("cowork_get_status");
}

export function coworkToggleIntegration(invoke: InvokeFn, enabled: boolean): Promise<{ ok: true }> {
  return invoke<{ ok: true }>("cowork_toggle_integration", { enabled });
}

export function coworkRescan(invoke: InvokeFn): Promise<{ workspaces: WorkspaceStatus[] }> {
  return invoke<{ workspaces: WorkspaceStatus[] }>("cowork_rescan");
}

export function coworkSetLanIpOverride(invoke: InvokeFn, enabled: boolean): Promise<{ ok: true }> {
  return invoke<{ ok: true }>("cowork_set_lan_ip_override", { enabled });
}

export function coworkRetryAdminElevation(invoke: InvokeFn): Promise<{ ok: true }> {
  return invoke<{ ok: true }>("cowork_retry_admin_elevation");
}
