/**
 * Pure helpers for the Cowork Settings UI. Extracted from the React
 * components so they can be unit-tested with vitest in the existing node
 * environment — no DOM / testing-library required.
 */

import { COWORK_ONBOARDING_SKIPPED_KEY } from "../../shared/constants";
import type {
  AdapterEnumerationReason,
  CoworkStatus,
  FirewallErrorVariant,
  SubnetDetectionReason,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "../types";

/**
 * In-flight text for the subnet pre-flight's live region (#1376).
 *
 * Shared because all three Enable surfaces announce the same probe, and a
 * screen-reader user who moves between Settings, onboarding and the wizard
 * should not hear three descriptions of one operation.
 *
 * The STRING is what is shared, and only that — the three surfaces still style
 * it three ways (`.cs-help-text`, `.cos-checking`, `.iw-hint-text`), because
 * each sits in a differently-tinted container. Sharing the text is what a
 * screen reader hears; sharing the CSS would be a visual regression.
 */
export const COWORK_PREFLIGHT_CHECKING = "Checking your network…";

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
 * Recovery copy per subnet-detection reason (#1298).
 *
 * A `Record` over the union rather than a `switch`: it is exhaustive at compile
 * time, so a change to the TypeScript union is a type error in exactly one
 * place — the property `workspaceFileStatusLabel` gets from having no `default`
 * arm. `firewallErrorHint` still needs a runtime fallback (the field is
 * optional for stale sidecars), and a `switch` cannot be both.
 *
 * It does NOT catch a rename on the Rust side. `SubnetDetectionReason` in
 * `src/client/types.ts` is hand-maintained against `src-tauri/src/firewall.rs`,
 * so a Rust-side rename produces zero TypeScript errors and degrades silently
 * to the fallback hint — which is why the fallback has to stay honest, and why
 * `tests/build/firewall-reason-alignment.test.ts` pins the two lists together.
 *
 * None of these may say "is Cowork set up on this machine?" — the workspace
 * scan has already succeeded before any of the three surfaces can reach this
 * code, and one of them (`CoworkOnboardingStep`) is literally titled "Claude
 * Desktop Cowork detected". That sentence was the defect.
 */
const SUBNET_REASON_HINT: Record<SubnetDetectionReason, string> = {
  // Deliberately says what Tandem observed, not what is true of the machine.
  // Three different situations produce a zero match and the code cannot tell
  // them apart, so asserting "no adapter exists" would be false for two of them.
  noAdapter:
    "Tandem didn't find a Hyper-V virtual network adapter, so it can't tell which subnet to allow. Usually that means no Cowork session is running — start one and try again. It can also mean WSL is using mirrored networking (no adapter is ever created), or that Tandem doesn't recognise the adapter's name on this edition of Windows.",
  noIpv4:
    "A Hyper-V virtual network adapter is there, but it doesn't have an IPv4 address yet. Start a Cowork session and try again.",
  prefixTooBroad:
    "The Hyper-V subnet Tandem found is wider than /20. Tandem won't open the firewall that broadly, so it stopped rather than allow more of the network than Cowork needs.",
  queryFailed:
    "Windows couldn't list Hyper-V network adapters, so Tandem can't tell which subnet to allow. Try again, and if it keeps happening, check that PowerShell runs normally on this machine.",
  // #1371. Names the wait, deliberately WITHOUT a number: the pre-flight and the
  // Enable path give the query different budgets (`SUBNET_PROBE_TIMEOUT_ADVISORY`
  // vs `SUBNET_PROBE_TIMEOUT_ENABLE` in `firewall.rs`), so any numeral here would
  // be wrong on one of the two paths. The exact seconds go to `tandem.log`.
  timeout:
    "Tandem asked Windows to list its Hyper-V network adapters and gave up waiting rather than freeze. That usually means the Windows Management Instrumentation service is stuck — restarting the machine clears it. You can also just try again.",
};

/**
 * Recovery copy per adapter-enumeration reason (#1372).
 *
 * The old single sentence — "Could not enumerate Hyper-V network adapters. Run
 * Tandem as administrator or reboot to refresh the adapter list." — covered two
 * causes with opposite remedies, and asserted an enumeration had been attempted
 * when the interpreter never launched. Same defect shape as #1298 next door.
 *
 * Every entry says PowerShell never started, because that is the one thing all
 * three have in common and it is what makes "reboot to refresh the adapter
 * list" visibly the wrong advice. None of them mentions administrator rights:
 * elevation has nothing to do with whether a process can be spawned, and that
 * sentence sent people to a UAC prompt that could not have helped.
 */
const ADAPTER_REASON_HINT: Record<AdapterEnumerationReason, string> = {
  notFound:
    "Tandem couldn't find Windows PowerShell, so it couldn't look up the Hyper-V subnet to allow. Check that powershell.exe is on your PATH — Nano Server and other stripped-down Windows images don't ship it.",
  permissionDenied:
    "Windows refused to start PowerShell, so Tandem couldn't look up the Hyper-V subnet to allow. That is usually an application-control policy (AppLocker, WDAC or Software Restriction Policies) — on a managed machine your IT team controls it.",
  spawnFailed:
    "Tandem couldn't start Windows PowerShell, so it couldn't look up the Hyper-V subnet to allow. Try again, and if it keeps happening, check that PowerShell runs normally on this machine.",
};

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
      // `||`, not `??`: the left operand is `""` when `reason` is an empty
      // string, and `??` passes that straight through — rendering an empty
      // warning box while still removing the Enable button. `||` also covers an
      // absent `reason` and one this build doesn't recognise, and no entry in
      // the table is falsy, so nothing valid is lost. The fallback still names
      // the subnet, because that is the one thing every case has in common.
      //
      // Not for version skew: `firewall.rs` runs in the Tauri shell and the
      // WebView loads `frontendDist`, so the Rust and the TypeScript ship as
      // one artifact and cannot disagree. This is defence against a hand-edited
      // payload and against a Rust-side rename that TypeScript cannot see —
      // which is a real hazard, since the union is hand-maintained.
      return withQueryDiagnostics(
        (variant.reason && SUBNET_REASON_HINT[variant.reason]) ||
          "Tandem couldn't work out the Hyper-V subnet Cowork is using, so it didn't change the firewall. Start a Cowork session and try again.",
        variant,
      );
    case "adapterEnumerationFailed":
      // Same `||` reasoning as the subnet arm above: an absent `reason`, an
      // empty string, or one this build doesn't recognise all fall to copy that
      // is still true of every case.
      return (
        (variant.reason && ADAPTER_REASON_HINT[variant.reason]) ||
        "Tandem couldn't start Windows PowerShell, so it couldn't look up the Hyper-V subnet to allow."
      );
    default:
      return `Unexpected firewall error (${(variant as { kind: string }).kind}). Please restart Tandem.`;
  }
}

/**
 * Append the query's own diagnostics to a subnet hint, when it has any (#1372).
 *
 * The Rust side attaches these only when the PowerShell process actually
 * failed, so in practice only `queryFailed` from a non-zero exit carries them.
 * This keys on the fields rather than on the reason, which is the same thing
 * and stays right if the Rust side ever populates them for another reason.
 *
 * **A zero exit code is not evidence and must not be rendered.** An earlier cut
 * keyed the Rust side on the reason instead of on the process, which gave the
 * zero-exit/unparseable-output path `exitCode: 0` and an empty stderr — and
 * this function turned that into "(PowerShell exit 0: (no output))" appended to
 * "Windows couldn't list Hyper-V network adapters". Self-contradictory, and
 * strictly worse than the bare hint. The server is where that was fixed; the
 * guard here is defence in depth, because the failure was invisible from either
 * side alone.
 *
 * The tail has already had the user's home directory collapsed to `~` on the
 * Rust side. That is a narrowing, not a guarantee: PowerShell can name paths
 * outside the home directory, and this string is written for a user to paste
 * into a public issue.
 */
function withQueryDiagnostics(
  hint: string,
  variant: Extract<FirewallErrorVariant, { kind: "subnetDetectionFailed" }>,
): string {
  const hasExit = typeof variant.exitCode === "number" && variant.exitCode !== 0;
  const hasStderr = (variant.stderrTail ?? "").trim().length > 0;
  if (!hasExit && !hasStderr) return hint;
  return `${hint} (PowerShell exit ${
    hasExit ? variant.exitCode : "unknown"
  }: ${truncateStderr(variant.stderrTail ?? "")})`;
}

/**
 * One line of captured stderr, capped.
 *
 * Newlines are collapsed because the only consumers are single-line toasts and
 * inline warning boxes: a three-line PowerShell ErrorRecord pasted in raw
 * either stretches the toast or silently loses everything after the first line,
 * depending on the surface. Same reasoning as `client-log.ts`'s `collapseLines`
 * for the same class of text.
 */
function truncateStderr(tail: string): string {
  const s = tail.replace(/\s*\n\s*/g, " ").trim();
  if (s.length === 0) return "(no output)";
  if (s.length <= 200) return s;
  return `${s.slice(0, 197)}...`;
}

/**
 * Recover the structured `FirewallError` the Rust side serialized, or `null`
 * when the message is something else entirely.
 *
 * The `null` case is load-bearing for the enable pre-flight (#1298): a failure
 * we can't classify — `TAURI_NOT_AVAILABLE`, the non-Windows guard, a panic
 * string — is a broken *probe*, not evidence that enabling would fail. Callers
 * distinguish the two so a probe that can't run never blocks an enable that
 * would have worked.
 */
export function parseFirewallErrorVariant(rawMsg: string): FirewallErrorVariant | null {
  try {
    const parsed: unknown = JSON.parse(rawMsg);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      typeof (parsed as Record<string, unknown>).kind === "string"
    ) {
      return parsed as FirewallErrorVariant;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatCoworkError(rawMsg: string): string {
  const variant = parseFirewallErrorVariant(rawMsg);
  if (!variant) return rawMsg;
  try {
    return firewallErrorHint(variant);
  } catch (hintErr) {
    console.error("[cowork] firewallErrorHint failed for:", variant, hintErr);
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
 * sync so the settings UI can decide at render time whether to load the
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
