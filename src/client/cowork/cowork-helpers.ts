/**
 * Pure helpers for the Cowork Settings UI (PR f). Extracted from the React
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
 * Render a distinct user-facing recovery hint per `FirewallError` variant
 * (security invariant §13). Kept pure so `tests/client/cowork-settings.test.ts`
 * can exhaustively cover the variant → hint mapping.
 */
export function firewallErrorHint(variant: FirewallErrorVariant): string {
  switch (variant.kind) {
    case "AdminDeclined":
      return "Admin permission was denied. Retry with admin, or disable Cowork integration.";
    case "NetshNotFound":
      return "Windows Firewall command (netsh) was not found on PATH. Confirm your Windows install is intact.";
    case "NetshFailure":
      return `Windows Firewall command failed (exit ${variant.exitCode}). Details: ${truncateStderr(
        variant.stderrTail,
      )}`;
    case "SubnetDetectionFailed":
      return "Could not detect the Hyper-V / Cowork VM subnet. Is Claude Desktop Cowork actually set up on this machine?";
    case "AdapterEnumerationFailed":
      return "Could not enumerate Hyper-V network adapters. Run Tandem as administrator or reboot to refresh the adapter list.";
  }
}

function truncateStderr(tail: string): string {
  const s = tail.trim();
  if (s.length === 0) return "(no output)";
  if (s.length <= 200) return s;
  return `${s.slice(0, 197)}...`;
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
  }
}

/**
 * Semantic token family driving the row background / icon color for a
 * per-file status. `success` = green, `warning` = amber, `error` = red.
 */
export type StatusTokenFamily = "success" | "warning" | "error";

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
    "alreadyPresent",
    "ok",
  ];
  const statuses = [ws.installedPlugins, ws.knownMarketplaces, ws.coworkSettings];
  for (const s of order) if (statuses.includes(s)) return s;
  return "ok";
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
