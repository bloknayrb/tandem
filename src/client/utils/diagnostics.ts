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
    lines.push(`${STATUS_TAG[res.status]} ${res.check} — ${res.message}`);
    if (res.status !== "pass" && res.fix) {
      lines.push(`       fix: ${res.fix}`);
    }
  }

  lines.push("", payload.report.summary);
  return lines.join("\n");
}
