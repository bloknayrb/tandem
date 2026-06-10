// Type-only import: erased at compile time, so no CLI/node code reaches the
// client bundle — this is the wire shape of GET /api/diagnostics' `report`.
import type { DoctorReport, DoctorStatus } from "../../cli/doctor";

/** Wire shape of `GET /api/diagnostics` (see `makeDiagnosticsHandler`). */
export interface DiagnosticsPayload {
  report: DoctorReport;
  version: string;
  transport: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  tauriSidecar: boolean;
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
 * Format a diagnostics payload as plain text for the clipboard. Pure — the
 * "Copy diagnostics" button is thin glue over this (extract-over-mount).
 */
export function formatDiagnostics(payload: DiagnosticsPayload): string {
  const lines: string[] = [
    `Tandem v${payload.version} (${payload.transport}${payload.tauriSidecar ? ", desktop" : ""})`,
    `${payload.platform}/${payload.arch}, Node ${payload.nodeVersion}`,
    "",
  ];

  for (const res of payload.report.results) {
    lines.push(`${STATUS_TAG[res.status]} ${res.check} — ${stripControlChars(res.message)}`);
    if (res.status !== "pass" && res.fix) {
      lines.push(`       fix: ${stripControlChars(res.fix)}`);
    }
  }

  lines.push("", stripControlChars(payload.report.summary));
  return lines.join("\n");
}
