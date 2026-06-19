/**
 * Pure license → UI derivation (#1116, ADR-040, client side). Given the
 * `GET /api/license/status` payload, decide what the editor + chrome should do.
 * Kept pure (no runes, no fetch) so it's unit-testable without mounting; the
 * `.svelte.ts` hook fetches/polls and feeds its result through here.
 *
 * The status payload is loopback-full or LAN-scrubbed (see routes/license.ts);
 * this reads only fields present in BOTH shapes, plus the optional licensee name
 * (loopback only) used for the "Licensed to {name}" label.
 */
export interface LicenseStatusResponse {
  gateActive: boolean;
  status: "trial" | "licensed" | "restricted";
  /** Scrubbed (LAN) payload carries daysRemaining at top level. */
  daysRemaining?: number;
  /** Full (loopback) payload nests it under trial. */
  trial?: { daysRemaining: number };
  updateWindowCurrent: boolean;
  license?: { name: string; type: string };
}

export interface LicenseUi {
  /** The editor is read-only ONLY when restricted. */
  editable: boolean;
  /** Show the full-screen activation wall (restricted). */
  showWall: boolean;
  /** Show the trial countdown banner (trial). */
  showTrialBanner: boolean;
  /** Days left in trial, or null when not in a trial. */
  trialDaysRemaining: number | null;
  /** Short label for the settings status pill. */
  statusLabel: string;
}

function trialDays(state: LicenseStatusResponse): number | null {
  return state.trial?.daysRemaining ?? state.daysRemaining ?? null;
}

export function deriveLicenseUi(state: LicenseStatusResponse | null): LicenseUi {
  // Not yet loaded, or the gate is inactive (dark build / pre-v1.0): the app
  // behaves exactly as today — fully editable, no banner, no wall, no pill.
  if (!state || !state.gateActive) {
    return {
      editable: true,
      showWall: false,
      showTrialBanner: false,
      trialDaysRemaining: null,
      statusLabel: "",
    };
  }

  if (state.status === "restricted") {
    return {
      editable: false,
      showWall: true,
      showTrialBanner: false,
      trialDaysRemaining: null,
      statusLabel: "Trial ended",
    };
  }

  if (state.status === "trial") {
    const days = trialDays(state);
    return {
      editable: true,
      showWall: false,
      showTrialBanner: true,
      trialDaysRemaining: days,
      statusLabel: days != null ? `Trial — ${days} day${days === 1 ? "" : "s"} left` : "Trial",
    };
  }

  // licensed
  return {
    editable: true,
    showWall: false,
    showTrialBanner: false,
    trialDaysRemaining: null,
    statusLabel: state.license?.name ? `Licensed to ${state.license.name}` : "Licensed",
  };
}
