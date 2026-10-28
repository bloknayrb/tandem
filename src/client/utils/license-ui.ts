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
import {
  type AiRefusalKind,
  formatGraceEndDate,
  type LicenseUnverifiableCode,
  licenseGraceNoticeMessage,
} from "../../shared/license-copy";
import type { TandemNotification } from "../../shared/types";

/** Why the AI features are off on this client. One union, shared with the server's refusal. */
export type AiNotice = AiRefusalKind;

/** The kind-neutral label for a disabled AI control: tooltips, placeholders, headings. */
export const AI_OFF_TITLE = "AI features are off";

export interface LicenseStatusResponse {
  gateActive: boolean;
  status: "trial" | "licensed" | "restricted" | "grace";
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
   * The grace period (#2231): present on the `grace` status only, on both the
   * loopback and the LAN-scrubbed payload (two dates and a day count, no PII).
   */
  grace?: { firstFailedAt: string; endsAt: string; daysRemaining: number };
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

  // #2231: an installed licence failed its check and its grace period is
  // running. The AI stays on (aiNotice null), there is no trial banner (this
  // reader is a licence holder, not an evaluator), and the label never says
  // "Licensed". Explicit, because the fallthrough below is the licensed arm.
  if (state.status === "grace") {
    const days = state.grace?.daysRemaining;
    return {
      aiNotice: null,
      aiOff: false,
      showTrialBanner: false,
      trialDaysRemaining: null,
      statusLabel:
        days != null
          ? `License not verified — AI on for ${days} more day${days === 1 ? "" : "s"}`
          : "License not verified",
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

/** The activity-tray identity of the grace-period notice (#2231). */
export const LICENSE_GRACE_DEDUP_KEY = "license-grace";

export interface LicenseGraceNoticePlan {
  /** A notice to push now, or `null`. */
  push: TandemNotification | null;
  /** Tray rows to remove: every grace row, once the device is out of grace. */
  dismissIds: string[];
  /** The caller's "already handled on this page load" flag, to store for next time. */
  handledThisLoad: boolean;
}

/**
 * What the activity tray should do about the licence grace period (#2231),
 * given the latest status poll. Pure, so the matrix is testable without
 * mounting `App.svelte`.
 *
 * - **In grace:** push one warning per page load. Not at all when the tray —
 *   rehydrated from localStorage — already holds a grace row, and not again on
 *   later polls of the same load. Keyed on the dedupKey and a per-load flag,
 *   never on a date-derived id: when the grace record cannot be written, its
 *   start date is "now" on every poll, and a date-keyed guard would re-toast
 *   every minute.
 * - **Out of grace** (licensed, trial, restricted, or a dark build): remove any
 *   grace row, so a stale notice never outlives the state it describes.
 * - **No status** (first poll in flight, or a failed poll): do nothing. A
 *   failed poll is not evidence the grace ended.
 *
 * A warning persists in the tray (`ACTIVITY_INFO_TTL_MS` expires info only),
 * which is what makes the notice persistent. Best-effort: the tray's history
 * cap can still evict it, and it comes back on the next page load.
 */
export function planLicenseGraceNotice(input: {
  status: LicenseStatusResponse | null;
  activity: readonly { id: string; dedupKey?: string }[];
  handledThisLoad: boolean;
  now: number;
}): LicenseGraceNoticePlan {
  const { status, activity, handledThisLoad, now } = input;
  if (status == null) return { push: null, dismissIds: [], handledThisLoad };
  const inGrace = status.gateActive && status.status === "grace";
  if (!inGrace) {
    return {
      push: null,
      dismissIds: activity.filter((a) => a.dedupKey === LICENSE_GRACE_DEDUP_KEY).map((a) => a.id),
      handledThisLoad: false,
    };
  }
  if (handledThisLoad || activity.some((a) => a.dedupKey === LICENSE_GRACE_DEDUP_KEY)) {
    return { push: null, dismissIds: [], handledThisLoad: true };
  }
  const endsOn = status.grace ? formatGraceEndDate(status.grace.endsAt) : "";
  return {
    push: {
      id: `license-grace-${now}`,
      timestamp: now,
      type: "license",
      severity: "warning",
      message: licenseGraceNoticeMessage(endsOn || "the end of the grace period"),
      dedupKey: LICENSE_GRACE_DEDUP_KEY,
    },
    dismissIds: [],
    handledThisLoad: true,
  };
}
