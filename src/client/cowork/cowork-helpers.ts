/**
 * Pure helpers for the Cowork Settings UI. Extracted from the React
 * components so they can be unit-tested with vitest in the existing node
 * environment — no DOM / testing-library required.
 */

import { COWORK_ONBOARDING_SKIPPED_KEY } from "../../shared/constants";
import type {
  CoworkStatus,
  FirewallErrorVariant,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "../types";

/**
 * High-level branch the Settings UI renders. Collapses the `osSupported` /
 * `coworkDetected` / `uacDeclined` / normal states into a single label.
 */
export type CoworkSettingsVariant =
  | "loading"
  | "unsupported" // non-Windows
  | "undetected" // Windows, but no Cowork workspaces visible
  | "normal"; // Windows + Cowork present (toggle, status table, etc.)

export function coworkSettingsVariant(status: CoworkStatus | null): CoworkSettingsVariant {
  if (!status) return "loading";
  if (!status.osSupported) return "unsupported";
  if (!status.coworkDetected) return "undetected";
  return "normal";
}

/**
 * Sub-state of the `undetected` variant, driving honest copy instead of a
 * blanket "not detected":
 *
 * - `noClaude` — Claude Desktop itself wasn't found; install it first.
 * - `noWorkspacesYet` — Claude Desktop is present but no Cowork session has
 *   ever run, so no workspace dirs exist yet. Running Cowork once fixes it.
 * - `blocked` — session dirs WERE found but every one was rejected by the
 *   path security guard (network-redirected or cloud-synced AppData); telling
 *   the user "run Cowork once" would be a promise Tandem can never keep.
 *
 * Fields are optional on `CoworkStatus` for stale-sidecar tolerance; both
 * default to the conservative value here.
 */
export type UndetectedDetail = "noClaude" | "noWorkspacesYet" | "blocked";

export function undetectedDetail(status: CoworkStatus): UndetectedDetail {
  if (!(status.claudeDesktopDetected ?? false)) return "noClaude";
  if ((status.workspacesBlocked ?? 0) > 0) return "blocked";
  return "noWorkspacesYet";
}

/**
 * Render a distinct user-facing recovery hint per `FirewallError` variant.
 * Kept pure so `tests/client/cowork-settings.test.ts`
 * can exhaustively cover the variant → hint mapping.
 */
export function firewallErrorHint(variant: FirewallErrorVariant): string {
  switch (variant.kind) {
    case "adminDeclined":
      return "Tandem couldn't update Windows Firewall — that needs administrator rights, and Tandem doesn't run as admin. Nothing was changed, and your documents stay on this computer (the server is only reachable locally).";
    case "netshNotFound":
      return "Windows Firewall command (netsh) was not found on PATH. Confirm your Windows install is intact.";
    case "netshFailure":
      return `Windows Firewall command failed (exit ${variant.exitCode}). Details: ${truncateStderr(
        variant.stderrTail,
      )}`;
    case "subnetDetectionFailed":
      return "Could not detect the Hyper-V / Cowork VM subnet. Is Claude Desktop Cowork actually set up on this machine?";
    case "adapterEnumerationFailed":
      return "Could not enumerate Hyper-V network adapters. Run Tandem as administrator or reboot to refresh the adapter list.";
    default:
      return `Unexpected firewall error (${(variant as { kind: string }).kind}). Please restart Tandem.`;
  }
}

function truncateStderr(tail: string): string {
  const s = tail.trim();
  if (s.length === 0) return "(no output)";
  if (s.length <= 200) return s;
  return `${s.slice(0, 197)}...`;
}

export function formatCoworkError(rawMsg: string): string {
  try {
    const parsed: unknown = JSON.parse(rawMsg);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      typeof (parsed as Record<string, unknown>).kind === "string"
    ) {
      try {
        return firewallErrorHint(parsed as FirewallErrorVariant);
      } catch (hintErr) {
        console.error("[cowork] firewallErrorHint failed for:", parsed, hintErr);
        return rawMsg;
      }
    }
    return rawMsg;
  } catch {
    return rawMsg;
  }
}

/**
 * Label rendered next to each per-file status in the workspace table. Kept as
 * a single switch so a future Rust-side variant rename shows up as a compile
 * error in exactly one place.
 */
export function workspaceFileStatusLabel(status: WorkspaceFileStatus): string {
  switch (status) {
    case "ok":
      return "Installed";
    case "alreadyPresent":
      return "Already installed";
    case "locked":
      return "Locked (retrying)";
    case "schemaDrift":
      return "Schema drift";
    case "insecureAcl":
      return "Insecure ACL";
    case "failed":
      return "Failed";
    case "notConfigured":
      return "Not configured";
  }
}

/**
 * Semantic token family driving the row background / icon color for a
 * per-file status. `success` = green, `warning` = amber, `error` = red.
 */
export type StatusTokenFamily = "success" | "warning" | "error" | "neutral";

export function workspaceFileStatusFamily(status: WorkspaceFileStatus): StatusTokenFamily {
  switch (status) {
    case "ok":
    case "alreadyPresent":
      return "success";
    case "locked":
      return "warning";
    case "schemaDrift":
    case "insecureAcl":
    case "failed":
      return "error";
    case "notConfigured":
      return "neutral";
  }
}

/**
 * Roll the three per-file statuses into one "worst" status for a workspace
 * row. `failed` beats `schemaDrift`/`insecureAcl` beats `locked` beats
 * `alreadyPresent` beats `ok`.
 */
export function aggregateWorkspaceStatus(ws: WorkspaceStatus): WorkspaceFileStatus {
  const order: WorkspaceFileStatus[] = [
    "failed",
    "schemaDrift",
    "insecureAcl",
    "locked",
    "notConfigured",
    "alreadyPresent",
    "ok",
  ];
  const statuses = [ws.installedPlugins, ws.knownMarketplaces, ws.coworkSettings];
  for (const s of order) if (statuses.includes(s)) return s;
  return "ok";
}

/**
 * Post-enable reachability of the Cowork stdio channel (#1174 gap #3).
 *
 * `enabled` only means "a firewall rule was added and ≥1 plugin install
 * succeeded at enable time" — a write-succeeded signal, not proof a Cowork
 * session can actually find and load the Tandem plugin now. This derives a
 * reachability verdict from the on-disk truth the status scan already reports,
 * so the UI can show more than a bare `enabled` boolean.
 *
 * - `reachable` — ≥1 workspace has all three registry files installed, so a
 *   Cowork session launched there will discover and load the Tandem plugin.
 * - `unreachable` — enabled, but no workspace is fully installed AND at least
 *   one shows a hard install problem (failed / schema drift / insecure ACL).
 *   Actionable: re-scan or re-enable.
 * - `pending` — enabled, but nothing to confirm yet (no workspaces, or the
 *   registry just hasn't been populated — the background heal-pass installs
 *   into a workspace the first time a Cowork session opens). Informational.
 * - `not-applicable` — integration not enabled; nothing to verify.
 *
 * Note: this is a host-side, on-disk reachability signal. It cannot observe the
 * VM→host network hop directly (the Cowork VM doesn't forward loopback, ADR-023);
 * that hop is what the enable-time firewall rule — verified fail-closed — covers.
 */
export type CoworkReachability = "reachable" | "unreachable" | "pending" | "not-applicable";

/** True when every plugin-registry file for this workspace is present + valid. */
export function coworkWorkspaceReachable(ws: WorkspaceStatus): boolean {
  const installed = (s: WorkspaceFileStatus): boolean => s === "ok" || s === "alreadyPresent";
  return (
    installed(ws.installedPlugins) &&
    installed(ws.knownMarketplaces) &&
    installed(ws.coworkSettings)
  );
}

export function coworkReachability(status: CoworkStatus | null): CoworkReachability {
  if (!status || !status.enabled) return "not-applicable";
  const workspaces = status.workspaces ?? [];
  if (workspaces.some(coworkWorkspaceReachable)) return "reachable";
  // No fully-installed workspace. A hard install error is actionable now; a
  // bare "not configured" / "locked (retrying)" just means the heal-pass hasn't
  // populated the registry yet, which is expected before the first session.
  const anyHardError = workspaces.some(
    (ws) => workspaceFileStatusFamily(aggregateWorkspaceStatus(ws)) === "error",
  );
  return anyHardError ? "unreachable" : "pending";
}

/** User-facing copy + token family for a reachability verdict. */
export function coworkReachabilityCopy(r: CoworkReachability): {
  title: string;
  detail: string;
  family: StatusTokenFamily;
} {
  switch (r) {
    case "reachable":
      return {
        title: "Tandem is reachable from Cowork",
        detail:
          "At least one Cowork workspace has the Tandem plugin installed — a Cowork session can find and load it.",
        family: "success",
      };
    case "unreachable":
      return {
        title: "Tandem isn't reachable yet",
        detail:
          "Cowork is enabled, but a workspace install didn't complete. Re-scan workspaces, or restart Claude Desktop and re-enable.",
        family: "error",
      };
    case "pending":
      return {
        title: "Waiting for a Cowork session",
        detail:
          "Cowork is enabled. The Tandem plugin installs into a workspace the first time you open a Cowork session.",
        family: "warning",
      };
    case "not-applicable":
      return { title: "", detail: "", family: "neutral" };
  }
}

/**
 * Decide whether the first-launch onboarding should insert the Cowork step.
 * Centralizes the gating so tests cover all branches without mounting the
 * tutorial.
 */
export function shouldShowCoworkOnboarding(
  status: CoworkStatus | null,
  skippedFlag: boolean,
): boolean {
  if (!status) return false;
  if (skippedFlag) return false;
  if (!status.osSupported) return false;
  if (!status.coworkDetected) return false;
  if (status.enabled) return false; // already on — nothing to prompt
  return true;
}

/**
 * Persistent skip flag — read/write via localStorage with try/catch so
 * incognito / storage-disabled browsers don't crash the tutorial.
 */
export function readCoworkOnboardingSkipped(): boolean {
  try {
    return localStorage.getItem(COWORK_ONBOARDING_SKIPPED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeCoworkOnboardingSkipped(): void {
  try {
    localStorage.setItem(COWORK_ONBOARDING_SKIPPED_KEY, "true");
  } catch {
    // Storage unavailable — step will reappear next launch.
  }
}

/**
 * Synchronous Tauri-runtime detection. Tauri v2 exposes `__TAURI_INTERNALS__`
 * on `window`; v1's `__TAURI__` global is legacy. This check is intentionally
 * sync so `<SettingsPopover>` can decide at render time whether to load the
 * Cowork section without a round-trip.
 */
export function isTauriRuntime(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/**
 * Minimal debouncer — `schedule(fn)` replaces any pending call, `cancel()`
 * drops the pending call. Pure (no React, no DOM) so fake-timer tests can
 * cover the behavior without mounting a component.
 */
export interface Debouncer {
  schedule: (fn: () => void) => void;
  cancel: () => void;
}

export function makeDebouncer(ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(fn: () => void) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
