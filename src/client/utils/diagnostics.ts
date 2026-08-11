// Type-only import: erased at compile time, so no CLI/node code reaches the
// client bundle — this is the wire shape of GET /api/diagnostics' `report`.
import type { DoctorReport, DoctorStatus } from "../../cli/doctor";
import { TANDEM_ISSUES_NEW_URL } from "../../shared/constants";

/**
 * Wire shape of `GET /api/diagnostics` (see `makeDiagnosticsHandler`).
 *
 * Everything below `tauriSidecar` comes from `collectHostInfo()` and is
 * OPTIONAL — `os.cpus()` legitimately returns `[]` on some hosts, and an older
 * server predates the fields entirely. `formatDiagnostics` therefore drops each
 * one individually rather than printing `undefined`.
 */
export interface DiagnosticsPayload {
  report: DoctorReport;
  version: string;
  transport: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  tauriSidecar: boolean;
  osRelease?: string;
  osVersion?: string;
  cpuModel?: string;
  cpuCount?: number;
  totalMemoryMb?: number;
  freeMemoryMb?: number;
}

/** Client-side facts the server cannot see. */
export interface DiagnosticsEnv {
  /** Short browser/WebView descriptor, e.g. "Chrome 141". Empty to omit. */
  browser?: string;
}

const STATUS_TAG: Record<DoctorStatus, string> = {
  pass: "[ok]  ",
  warn: "[warn]",
  fail: "[fail]",
};

/**
 * A few check messages interpolate raw file content (e.g. an unparseable
 * `store.lock`). The clipboard text gets pasted into terminals, so strip
 * control characters that could carry ANSI/OSC escape sequences.
 */
function stripControlChars(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * Ordered because user-agent strings are cumulative liars: Edge's UA contains
 * "Chrome", Chrome's contains "Safari", and Opera's contains both. First match
 * wins, so the most specific patterns come first.
 */
const UA_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /\bOPR\/(\d+)/],
  ["Firefox", /\bFirefox\/(\d+)/],
  // Before Chrome, and matched on its own: "HeadlessChrome" has no word
  // boundary before "Chrome", so a `\bChrome/` pattern silently misses it and
  // drops the line entirely.
  ["HeadlessChrome", /\bHeadlessChrome\/(\d+)/],
  ["Chrome", /\bChrome\/(\d+)/],
  ["Safari", /\bVersion\/(\d+)[.\d]*\s+Safari\//],
];

/**
 * Reduce a user-agent string to a short "Name Major" descriptor.
 *
 * Deliberately a summary rather than the verbatim UA: this line lands in a
 * public issue body, and the full string is long, noisy, and more identifying
 * than the browser identity anyone actually needs to triage a report. Returns
 * "" when nothing matches, which drops the line entirely.
 */
export function summarizeUserAgent(ua: string): string {
  for (const [name, pattern] of UA_PATTERNS) {
    const major = pattern.exec(ua)?.[1];
    if (major) return `${name} ${major}`;
  }
  return "";
}

/**
 * Render a MiB count for humans. Named for its unit rather than `formatBytes`,
 * which already exists in `cli/doctor.ts` over a different one.
 */
export function formatMemoryMb(mb: number): string {
  return mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** `OS: Windows 11 Pro (10.0.26100)` — either half may be missing. */
function osLine(payload: DiagnosticsPayload): string | null {
  const version = payload.osVersion ? stripControlChars(payload.osVersion).trim() : "";
  const release = payload.osRelease?.trim() ?? "";
  if (version && release) return `OS: ${version} (${release})`;
  if (version || release) return `OS: ${version || release}`;
  return null;
}

/** `CPU: Apple M2 Pro x12, RAM: 32.0 GB total, 6.1 GB free` — any part may be missing. */
function hardwareLine(payload: DiagnosticsPayload): string | null {
  const parts: string[] = [];

  const model = payload.cpuModel ? stripControlChars(payload.cpuModel).trim() : "";
  const count = payload.cpuCount;
  if (model && count) parts.push(`CPU: ${model} x${count}`);
  else if (model) parts.push(`CPU: ${model}`);
  else if (count) parts.push(`CPU: x${count}`);

  const total = payload.totalMemoryMb;
  const free = payload.freeMemoryMb;
  if (total !== undefined && free !== undefined) {
    parts.push(`RAM: ${formatMemoryMb(total)} total, ${formatMemoryMb(free)} free`);
  } else if (total !== undefined) {
    parts.push(`RAM: ${formatMemoryMb(total)} total`);
  } else if (free !== undefined) {
    parts.push(`RAM: ${formatMemoryMb(free)} free`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Format a diagnostics payload as plain text for the clipboard. Pure — the
 * "Copy diagnostics" button is thin glue over this (extract-over-mount), and
 * `buildBugReportUrl` reuses the same text for the issue body.
 *
 * The first two lines are unchanged from before the host fields existed, and a
 * payload carrying none of them produces byte-identical output to that era.
 * That degradation is the contract: an older server, or a host where every
 * `os.*` read failed, must still format cleanly.
 */
export function formatDiagnostics(payload: DiagnosticsPayload, env?: DiagnosticsEnv): string {
  const lines: string[] = [
    `Tandem v${payload.version} (${payload.transport}${payload.tauriSidecar ? ", desktop" : ""})`,
    `${payload.platform}/${payload.arch}, Node ${payload.nodeVersion}`,
  ];

  const os = osLine(payload);
  if (os) lines.push(os);

  const hardware = hardwareLine(payload);
  if (hardware) lines.push(hardware);

  const browser = env?.browser?.trim();
  if (browser) lines.push(`Browser: ${stripControlChars(browser)}`);

  lines.push("");

  for (const res of payload.report.results) {
    lines.push(`${STATUS_TAG[res.status]} ${res.check} — ${stripControlChars(res.message)}`);
    if (res.status !== "pass" && res.fix) {
      lines.push(`       fix: ${stripControlChars(res.fix)}`);
    }
  }

  lines.push("", stripControlChars(payload.report.summary));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report a bug — prefilled GitHub issue body
// ---------------------------------------------------------------------------

export const BUG_REPORT_BODY_HEADING = "Diagnostic information:";

/**
 * Ceiling on the whole issue URL. GitHub rejects request lines past roughly
 * 8 KB; staying well under that leaves room for the base URL and for whatever
 * proxy sits in front of it. A dropped issue form is the failure mode being
 * avoided — it looks like the button is simply broken.
 */
export const MAX_ISSUE_URL_LENGTH = 6000;

const TRUNCATION_MARKER =
  "… (truncated — use Copy Diagnostics in Settings → About for the full report)";

/**
 * Tilde fence, not backticks. Doctor `fix` strings embed backticks verbatim
 * (e.g. "run via `npx`"), so a ``` fence is not escape-safe against content we
 * do not control.
 */
const FENCE = "~~~";

function issueUrlFor(text: string): string {
  const body = `\n\n${BUG_REPORT_BODY_HEADING}\n\n${FENCE}\n${text}\n${FENCE}`;
  return `${TANDEM_ISSUES_NEW_URL}?body=${encodeURIComponent(body)}`;
}

/**
 * Build the "Report a bug" href, prefilling the issue body with the diagnostics
 * report under a `Diagnostic information:` heading.
 *
 * With no diagnostics — not fetched yet, fetch failed, server unreachable —
 * returns the bare issue URL. That is the whole error strategy: the link always
 * works, and the prefill is an upgrade rather than a precondition.
 *
 * Truncation measures the ENCODED length, which is what the cap is actually
 * about. The text is newline- and em-dash-dense and both expand (`%0A`,
 * `%E2%80%94`), so real growth is roughly 2.5–3× — a raw character count would
 * overshoot the cap by more than double. Lines are dropped from the tail so the
 * header (version, OS, CPU) survives; those are the highest-value lines and the
 * check list degrades gracefully.
 */
export function buildBugReportUrl(diagnostics?: string | null): string {
  const text = (diagnostics ?? "").trim();
  if (!text) return TANDEM_ISSUES_NEW_URL;

  try {
    const full = issueUrlFor(text);
    if (full.length <= MAX_ISSUE_URL_LENGTH) return full;

    // Truncate by whole lines, never mid-string: slicing a JS string can split
    // a surrogate pair, and `encodeURIComponent` throws URIError on a lone
    // surrogate. Line boundaries sidestep that entirely.
    const lines = text.split("\n");
    const candidate = (kept: number): string =>
      `${lines.slice(0, kept).join("\n")}\n${TRUNCATION_MARKER}`;

    let lo = 1;
    let hi = lines.length;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (issueUrlFor(candidate(mid)).length <= MAX_ISSUE_URL_LENGTH) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Not even one line fits — a single pathologically long line. An issue with
    // only a truncation notice is worse than none, so fall back to the bare URL.
    return best > 0 ? issueUrlFor(candidate(best)) : TANDEM_ISSUES_NEW_URL;
  } catch {
    // encodeURIComponent throws URIError on a lone surrogate anywhere in the
    // report. Losing the prefill beats losing the link.
    return TANDEM_ISSUES_NEW_URL;
  }
}
