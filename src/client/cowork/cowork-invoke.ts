/**
 * Typed wrappers around Tauri's cowork invoke commands. Each wrapper accepts
 * an `InvokeFn` so tests can mock the call without needing the
 * `@tauri-apps/api/core` import to resolve under vitest.
 */

import {
  firewallErrorHint,
  isTauriRuntime,
  parseFirewallErrorVariant,
} from "../cowork/cowork-helpers";
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

/**
 * Mirrors `WINDOWS_ONLY_ERR` in `src-tauri/src/lib.rs`. Used only to keep an
 * expected rejection out of `console.error` — a drift here costs a noisy log
 * line, never behaviour, so it is deliberately not pinned by a test.
 */
export const COWORK_WINDOWS_ONLY = "Cowork integration is Windows-only";

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

/**
 * Read-only pre-flight for the enable path (#1298).
 *
 * The command has existed since Cowork shipped but had no caller, so the UI
 * offered an Enable button it could have known would fail: `cowork_toggle_
 * integration` runs this same detection as its second step, and a failure there
 * surfaced as a blanket "is Cowork set up on this machine?" — in one case under
 * a dialog literally titled "Claude Desktop Cowork detected".
 *
 * Advisory only. It does not replace the check inside the enable path, which
 * still runs and is still what fails closed; the VM can stop between the two.
 */
export function coworkDetectVethernetSubnet(invoke: InvokeFn): Promise<string> {
  return invoke<string>("cowork_detect_vethernet_subnet");
}

/**
 * Outcome of the enable pre-flight. Three states, not two, because "the probe
 * failed" and "enabling would fail" are different claims:
 *
 * - `ok` — a subnet was detected; the enable path's own detection should agree.
 * - `blocked` — the probe returned a structured `FirewallError`, so we can say
 *   what is wrong and offer a retry instead of a button that cannot work.
 * - `unknown` — the probe itself couldn't run. Never block on this; a broken
 *   probe must not stop a user whose enable would have succeeded.
 *
 * The same reasoning applies while a probe is still in flight: callers must
 * leave Enable **clickable** during the probe, not merely re-enable it
 * afterwards. Disabling it means a probe that never returns — PowerShell
 * hanging, a wedged WMI service — blocks enabling forever, which is a worse
 * failure than the blanket error message this whole change exists to fix.
 * Clicking Enable mid-probe is safe: the enable path runs this same detection
 * itself and fails closed with the same honest reason.
 */
export type SubnetPreflight =
  | { status: "ok"; cidr: string }
  | { status: "blocked"; hint: string }
  | { status: "unknown" };

export async function coworkPreflightSubnet(invoke: InvokeFn): Promise<SubnetPreflight> {
  try {
    return { status: "ok", cidr: await coworkDetectVethernetSubnet(invoke) };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const variant = parseFirewallErrorVariant(rawMsg);
    if (!variant) {
      // `unknown` is deliberately never rendered, so an unparseable failure is
      // invisible to the user by design — but it is also how an unregistered
      // command or a serde downgrade on the Rust side would present, and those
      // are bugs. Log everything except the two expected cases so a real fault
      // is diagnosable from a pasted console rather than indistinguishable
      // from "we couldn't tell".
      //
      // Safe to log verbatim, but NOT for the reason this comment used to
      // give. Since #1372 this command's `subnetDetectionFailed` does carry a
      // `stderrTail`, so "payload-free on the wire" is no longer true. What
      // makes it safe is the branch: nothing reaches here unless
      // `parseFirewallErrorVariant` already returned null, i.e. `rawMsg` did
      // not parse as JSON with a string `kind`. Keep that ordering if this is
      // ever restructured.
      //
      // One caveat, so nobody reads that as stronger than it is. `lib.rs` sends
      // `serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())`, and the
      // `Display` fallback DOES embed `stderr_tail` while not being JSON — so
      // it would take this branch. Serialising this enum cannot actually fail
      // (every field is a `String`), so the fallback is unreachable today; the
      // ordering argument is what holds, not the payload-free claim.
      //
      // The Rust side still keeps the raw `io::Error` from a failed spawn off
      // the wire entirely (it names the resolved executable path); the wire
      // carries only the closed `AdapterEnumerationReason`. Do not widen that.
      if (rawMsg === TAURI_NOT_AVAILABLE || rawMsg.includes(COWORK_WINDOWS_ONLY)) {
        console.debug("[cowork] subnet pre-flight unavailable:", rawMsg);
      } else {
        console.error("[cowork] subnet pre-flight could not be classified:", rawMsg);
      }
      return { status: "unknown" };
    }
    return { status: "blocked", hint: firewallErrorHint(variant) };
  }
}
