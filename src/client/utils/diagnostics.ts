// Type-only import: erased at compile time, so no CLI/node code reaches the
// client bundle — this is the wire shape of GET /api/diagnostics' `report`.
import type { DoctorReport, DoctorStatus } from "../../cli/doctor";
import { TANDEM_ISSUES_NEW_URL } from "../../shared/constants";
import type { HostInfo } from "../../shared/diagnostics";

/**
 * Wire shape of `GET /api/diagnostics` (see `makeDiagnosticsHandler`).
 *
 * Extends `HostInfo` rather than re-declaring its ten fields: the host block is
 * the server's to define, and a hand-copy here would be the one copy nothing
 * type-checks. `formatDiagnostics` drops each optional field individually
 * rather than printing `undefined`.
 */
export interface DiagnosticsPayload extends HostInfo {
  report: DoctorReport;
  version: string;
  transport: string;
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
 * control characters that could carry ANSI/OSC escape sequences. Also strips
 * Unicode bidi/format-override characters (U+200E/F LRM/RLM, U+202A-E
 * embedding/override, U+2066-9 isolates, U+061C ALM) -- "Trojan Source"-style
 * characters that visually reorder the surrounding text without any
 * HTML-escaping catching them, since they aren't `<`/`>`/`&`.
 *
 * Exported: also used by `IntegrationTargetCard.svelte` to sanitize
 * `EntryValidation.reason` strings, which originate from an unvalidated,
 * user-editable config file (see `extractEntry`'s comment in
 * `existing-config.ts`) rather than from this module's own doctor-report
 * content -- the same reason this module needed the control-char strip in
 * the first place applies there with an even less trusted source.
 */
export function stripControlChars(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return s
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g, "");
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
  // Terminal fallback, and it carries the desktop app. macOS WKWebView sends no
  // `Chrome/`, no `Edg/`, and often no `Version/… Safari/` token, so without
  // this the Browser line vanishes for exactly the distribution whose engine
  // version a bug report most needs.
  ["WebKit", /\bAppleWebKit\/(\d+)/],
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
  // `osRelease` needs the same strip as the other two: it is an OS-supplied
  // string on the same path to a terminal paste and a public issue body.
  const release = payload.osRelease ? stripControlChars(payload.osRelease).trim() : "";
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

  const ram: string[] = [];
  if (payload.totalMemoryMb !== undefined) {
    ram.push(`${formatMemoryMb(payload.totalMemoryMb)} total`);
  }
  if (payload.freeMemoryMb !== undefined) {
    ram.push(`${formatMemoryMb(payload.freeMemoryMb)} free`);
  }
  if (ram.length > 0) parts.push(`RAM: ${ram.join(", ")}`);

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
 * Build a fence long enough to contain `text`.
 *
 * Tildes rather than backticks because doctor `fix` strings embed backticks
 * verbatim (e.g. "run via `npx`"). But swapping the character only moves the
 * problem: report text is not ours either. `checkAnnotationStore` interpolates
 * raw `store.lock` bytes (doctor.ts:1520), and `stripControlChars` preserves
 * newlines, so a lock file containing a `~~~` line would close the fence and
 * let everything after it render as markdown in a public issue.
 *
 * CommonMark closes a fence only on a run at least as long as the opener, so
 * one tilde more than the longest run present is sufficient.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/~+/g)].map((m) => m[0].length));
  return "~".repeat(Math.max(3, longest + 1));
}

function issueUrlFor(text: string): string {
  const fence = fenceFor(text);
  const body = `\n\n${BUG_REPORT_BODY_HEADING}\n\n${fence}\n${text}\n${fence}`;
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
    //
    // A linear shrink rather than a binary search: reports run 20-40 lines, and
    // even the pathological 400-line case measures well under a millisecond in
    // a `.then` continuation off the click path. Not worth the lo/hi/sentinel
    // bookkeeping.
    const lines = text.split("\n");
    for (let kept = lines.length - 1; kept > 0; kept--) {
      const url = issueUrlFor(`${lines.slice(0, kept).join("\n")}\n${TRUNCATION_MARKER}`);
      if (url.length <= MAX_ISSUE_URL_LENGTH) return url;
    }

    // Not even one line fits — a single pathologically long line. An issue with
    // only a truncation notice is worse than none, so fall back to the bare URL.
    return TANDEM_ISSUES_NEW_URL;
  } catch {
    // encodeURIComponent throws URIError on a lone surrogate anywhere in the
    // report. Losing the prefill beats losing the link.
    return TANDEM_ISSUES_NEW_URL;
  }
}
