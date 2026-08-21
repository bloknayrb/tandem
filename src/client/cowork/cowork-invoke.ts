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
import type { CoworkStatus, CoworkToggleReport } from "../types";

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
 * Mirrors `WINDOWS_ONLY_ERR` in `src-tauri/src/lib.rs`.
 *
 * Since #1436 this string SELECTS BEHAVIOUR, not just a log level: it is what
 * routes the non-Windows rejection to `unavailable` (silent) rather than
 * `failed` (a visible hedged line). A drift here used to cost a noisy log line;
 * it now paints a warning on a routine path, so the substring match and its
 * fixtures are load-bearing.
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

export function coworkToggleIntegration(
  invoke: InvokeFn,
  enabled: boolean,
): Promise<CoworkToggleReport> {
  return invoke<CoworkToggleReport>("cowork_toggle_integration", { enabled });
}

export function coworkRescan(invoke: InvokeFn): Promise<string> {
  return invoke<string>("cowork_rescan");
}

// Both of these resolve with a plain string, not an object. Their Rust
// commands are `Result<String, String>`, which Tauri resolves with the `String`
// itself; the previous `{ ok: true }` annotation described a shape the wire has
// never produced. Nothing read it — both call sites discard the value — so the
// lie type-checked indefinitely. It matters now because #1560 makes the retry's
// success payload meaningful: it is the toggle's own "Cowork enabled: N
// workspace(s) configured".
export function coworkSetLanIpOverride(invoke: InvokeFn, enabled: boolean): Promise<string> {
  return invoke<string>("cowork_set_lan_ip_override", { enabled });
}

export function coworkRetryAdminElevation(invoke: InvokeFn): Promise<string> {
  return invoke<string>("cowork_retry_admin_elevation");
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
 * Outcome of the enable pre-flight. Four states, because "the probe failed"
 * and "enabling would fail" are different claims, and so are the two reasons a
 * probe does not answer:
 *
 * - `ok` — a subnet was detected; the enable path's own detection should agree.
 * - `blocked` — the probe returned a structured `FirewallError`, so we can say
 *   what is wrong and offer a retry instead of a button that cannot work.
 * - `unavailable` / `failed` — the probe itself couldn't run. Never block on
 *   either; a broken probe must not stop a user whose enable would have
 *   succeeded. Their per-variant notes below carry the rest.
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
  /**
   * The probe cannot run in this environment — not Windows, or no Tauri bridge
   * in a session that never claimed to have one. Renders nothing, which is
   * correct: nothing has gone wrong, and a warning would be permanent noise.
   *
   * Every surface that probes today is already gated on `isTauriRuntime()` and
   * on `osSupported`, so in the shipped app this is effectively unreachable —
   * it is the answer for a caller that probes WITHOUT those gates (the Svelte
   * harness does) and the reason the `failed` arm can be as loud as it is.
   * Do not "simplify" it away by folding it into `failed`: the moment a surface
   * probes ungated, that fold paints a warning on every browser session.
   */
  | { status: "unavailable" }
  /**
   * The probe ran and broke: an unregistered command, a serde shape drift, a
   * throw from the bridge. Renders a hedged line (#1436) — the `ok` case is
   * silent, and silence is only readable if the failure case is not.
   *
   * These were one `unknown` value until #1436, which made a genuine fault
   * pixel-identical to a pass. Splitting them is the whole fix: the two halves
   * were already distinguished HERE (one logs at `error`, the other at
   * `debug`), and that distinction simply never reached the wire.
   */
  | { status: "failed" };

export async function coworkPreflightSubnet(invoke: InvokeFn): Promise<SubnetPreflight> {
  try {
    return { status: "ok", cidr: await coworkDetectVethernetSubnet(invoke) };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const variant = parseFirewallErrorVariant(rawMsg);
    if (!variant) {
      // #1436: the two arms below already existed — one logs at `error`, the
      // other at `debug` — and the fact that both then returned one `unknown`
      // is what made a real fault indistinguishable from an environment the
      // probe was never going to run in.
      //
      // `TAURI_NOT_AVAILABLE` alone is NOT enough to call it an environment,
      // and reading it that way was the first cut's bug. `loadInvoke` emits
      // that string from its own catch when `import("@tauri-apps/api/core")`
      // fails — so OUTSIDE Tauri it is the ordinary no-bridge case, but INSIDE
      // Tauri it means a chunk that should exist did not load (a partial
      // update, a CSP block), which is a fault and the single most likely way
      // a shipped desktop build reaches this function at all. Every surface
      // that probes is already gated on `isTauriRuntime()`, so treating it as
      // an environment sent the one reachable fault straight back to the
      // silence #1436 is about.
      //
      // Logging `rawMsg` verbatim is safe, but NOT for the reason this comment
      // used to give. Since #1372 this command's `subnetDetectionFailed` does
      // carry a `stderrTail`, so "payload-free on the wire" is no longer true.
      // What makes it safe is the BRANCH: nothing reaches here unless
      // `parseFirewallErrorVariant` already returned null, i.e. `rawMsg` did
      // not parse as JSON with a string `kind`. Keep that ordering if this is
      // ever restructured, and do not widen the logging to the parsed variants.
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
      if (
        rawMsg.includes(COWORK_WINDOWS_ONLY) ||
        (rawMsg === TAURI_NOT_AVAILABLE && !isTauriRuntime())
      ) {
        console.debug("[cowork] subnet pre-flight unavailable:", rawMsg);
        return { status: "unavailable" };
      }
      console.error("[cowork] subnet pre-flight could not be classified:", rawMsg);
      return { status: "failed" };
    }
    return { status: "blocked", hint: firewallErrorHint(variant) };
  }
}
