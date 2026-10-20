/**
 * Pure license → UI derivation (#1116, ADR-040, #1521, client side). Given the
 * `GET /api/license/status` payload, decide what the chrome should do. Kept pure
 * (no runes, no fetch) so it's unit-testable without mounting; the `.svelte.ts`
 * hook fetches/polls and feeds its result through here.
 *
 * A keyless install refuses the AI, never the editor (#1521, D3): no licence
 * state reaches editability, so `LicenseUi` carries no `editable` field at all.
 * Every AI-surface show/hide decision keys on `aiNotice` (or its boolean,
 * `aiOff`); the reason code
 * (`status.licenseUnverifiable`) is read only to pick copy — with one
 * exception, the purchase link, which must hide from an unverifiable licence
 * holder even during a trial, where `aiNotice` is null by design.
 *
 * The status payload is loopback-full or LAN-scrubbed (see routes/license.ts);
 * this reads only fields present in BOTH shapes, plus the optional licensee email
 * (loopback only) used for the "Licensed to {email}" label.
 */
import type { AiRefusalKind, LicenseUnverifiableCode } from "../../shared/license-copy";

/** Why the AI features are off on this client. One union, shared with the server's refusal. */
export type AiNotice = AiRefusalKind;

/** The kind-neutral label for a disabled AI control: tooltips, placeholders, headings. */
export const AI_OFF_TITLE = "AI features are off";

export interface LicenseStatusResponse {
  gateActive: boolean;
  status: "trial" | "licensed" | "restricted";
  /** Scrubbed (LAN) payload carries daysRemaining at top level. */
  daysRemaining?: number;
  /** Full (loopback) payload nests it under trial. */
  trial?: { daysRemaining: number };
  updateWindowCurrent: boolean;
  license?: { email: string; type: string };
  /**
   * A `license.json` exists on this device but did not verify, and WHY. Present
   * on the trial/restricted payloads only. Not PII — a closed enum about this
   * machine's own file, carrying no license content — so it survives the LAN
   * scrub. Without it every surface tells a license holder that their *trial*
   * ended, which for a beta tester is a trial they never had.
   */
  licenseUnverifiable?: LicenseUnverifiableCode;
  /**
   * Dark-build only: a license IS installed and would verify once the gate is
   * on. `gateActive` stays false, so this must never drive gate-only chrome —
   * it exists purely so an activation on a pre-v1.0 build is visibly confirmed
   * rather than leaving the same "activate it now" hint on screen.
   */
  licenseInstalled?: boolean;
  /** Dark-build only, loopback only. Email from the installed license (it carries no name). */
  licenseeEmail?: string;
  /**
   * Loopback only. Would an npm-installed `tandem activate` write where the
   * server that answered this actually reads? Gates the Settings → License CLI
   * hint (#1789). Absent on the LAN-scrubbed payload and on any server too old
   * to send it, and absence must read as `false` — the failure it guards is a
   * command that prints "✓ License activated" into a directory nothing reads.
   */
  cliActivateEffective?: boolean;
}

interface LicenseUiFields {
  /** Show the trial countdown banner (trial). */
  showTrialBanner: boolean;
  /** Days left in trial, or null when not in a trial. */
  trialDaysRemaining: number | null;
  /** Short label for the settings status pill. */
  statusLabel: string;
}

/**
 * `aiNotice` is non-null exactly when the gate is active and the AI is refused
 * (restricted): `"unverifiable"` when a licence file is installed but fails to
 * verify, otherwise `"unlicensed"`. Null on every dark build, in a trial and
 * when licensed. The editor stays editable in every state.
 *
 * `aiOff` is `aiNotice !== null`, the one predicate for "disable the AI
 * controls". The two are a union rather than independent fields, so a
 * `LicenseUi` whose `aiOff` disagrees with its `aiNotice` does not type-check.
 */
export type LicenseUi = LicenseUiFields &
  ({ aiNotice: null; aiOff: false } | { aiNotice: AiNotice; aiOff: true });

function trialDays(state: LicenseStatusResponse): number | null {
  return state.trial?.daysRemaining ?? state.daysRemaining ?? null;
}

export function deriveLicenseUi(state: LicenseStatusResponse | null): LicenseUi {
  // Not yet loaded, or the gate is inactive (dark build / pre-v1.0): the app
  // behaves exactly as today — no banner, no AI-off notice, no pill.
  if (!state || !state.gateActive) {
    return {
      aiNotice: null,
      aiOff: false,
      showTrialBanner: false,
      trialDaysRemaining: null,
      statusLabel: "",
    };
  }

  if (state.status === "restricted") {
    return {
      aiNotice: state.licenseUnverifiable ? "unverifiable" : "unlicensed",
      aiOff: true,
      showTrialBanner: false,
      trialDaysRemaining: null,
      // Never "Trial ended" (ADR-040 decision 5).
      statusLabel: state.licenseUnverifiable ? "License not verified" : "Unlicensed",
    };
  }

  if (state.status === "trial") {
    const days = trialDays(state);
    return {
      aiNotice: null,
      aiOff: false,
      showTrialBanner: true,
      trialDaysRemaining: days,
      statusLabel: days != null ? `Trial — ${days} day${days === 1 ? "" : "s"} left` : "Trial",
    };
  }

  // licensed
  return {
    aiNotice: null,
    aiOff: false,
    showTrialBanner: false,
    trialDaysRemaining: null,
    statusLabel: state.license?.email ? `Licensed to ${state.license.email}` : "Licensed",
  };
}

/**
 * Kind-specific "AI is off" copy. `short` is a one-line label; `sentence` is the
 * full explanation; `remedy` is its last sentence alone, for messages that
 * state their own cause first. The `unverifiable` copy never says "unlicensed"
 * or "activate" and never carries a purchase URL (ADR-040 decision 8): that
 * reader most likely already paid.
 */
export function aiOffCopy(kind: AiNotice): { short: string; sentence: string; remedy: string } {
  switch (kind) {
    case "unlicensed": {
      const remedy = "Activate a license in Settings → License.";
      return {
        short: "AI features off — unlicensed",
        sentence: `Tandem is unlicensed, so its AI features are off. ${remedy}`,
        remedy,
      };
    }
    case "unverifiable": {
      const remedy = "See Settings → License.";
      return {
        short: "AI features off — license not verified",
        sentence: `Tandem's AI features are off because your license could not be verified. ${remedy}`,
        remedy,
      };
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
