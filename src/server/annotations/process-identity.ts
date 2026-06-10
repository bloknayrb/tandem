/**
 * Best-effort process-identity probe for the store-lock reclaim flow (#1077).
 *
 * When `store.lock` names a PID that is still alive, the PID may have been
 * reused by an unrelated process (Windows recycles PIDs aggressively). This
 * module asks the OS what is actually running at that PID so the reclaim
 * endpoint can distinguish "another Tandem/node process genuinely holds the
 * lock" from "the PID was recycled by something else entirely".
 *
 * Fail-safe contract: every error path (unsupported platform, probe timeout,
 * unparseable output, permission denied) returns `indeterminate`, and the
 * caller treats indeterminate-with-live-PID as "do not reclaim". A wrong
 * answer here can at worst REFUSE a reclaim — never grant one.
 *
 * Injection safety: the PID is validated as a positive integer before any
 * command is built, and all probes use `execFile` with an argv array (no
 * shell), so no user-controlled string ever reaches a shell parser.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Per-probe child-process timeout. Tight: this runs inline in an HTTP handler. */
const PROBE_TIMEOUT_MS = 2_000;

export type ProcessIdentity =
  /** The OS reported a process name/image for the PID. */
  | { kind: "name"; name: string }
  /** The probe failed or is unsupported — caller must fail safe (treat as live holder). */
  | { kind: "indeterminate" };

const INDETERMINATE: ProcessIdentity = { kind: "indeterminate" };

/**
 * Does this process name look like it could be Tandem (or any Node process
 * that might be running Tandem)? Deliberately broad — matching too much only
 * refuses a reclaim, which is the safe direction. Covers `node`, `node.exe`,
 * the `node-sidecar-<triple>` Tauri sidecar, `tandem`, and the desktop app
 * binary (bundle product name `tandem`).
 */
export function isTandemLikeProcessName(name: string): boolean {
  return /node|tandem/i.test(name);
}

/**
 * Probe the identity of a live PID. Returns the process name on success or
 * `indeterminate` on any failure. Never throws.
 */
export async function probeProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 0) return INDETERMINATE;

  try {
    switch (process.platform) {
      case "linux":
        return await probeLinux(pid);
      case "darwin":
        return await probePs(pid);
      case "win32":
        return await probeTasklist(pid);
      default:
        return INDETERMINATE;
    }
  } catch {
    return INDETERMINATE;
  }
}

/** Linux: `/proc/<pid>/comm` — no child process needed. */
async function probeLinux(pid: number): Promise<ProcessIdentity> {
  try {
    const comm = (await fs.readFile(`/proc/${pid}/comm`, "utf-8")).trim();
    return comm ? { kind: "name", name: comm } : INDETERMINATE;
  } catch {
    // /proc unavailable (containers, hardened kernels) — fall back to ps.
    return probePs(pid);
  }
}

/** macOS (and Linux fallback): `ps -p <pid> -o comm=`. */
async function probePs(pid: number): Promise<ProcessIdentity> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const name = stdout.trim().split("\n")[0]?.trim() ?? "";
    return name ? { kind: "name", name } : INDETERMINATE;
  } catch {
    return INDETERMINATE;
  }
}

/** Windows: `tasklist /FI "PID eq <pid>" /FO CSV /NH` → first CSV field is the image name. */
async function probeTasklist(pid: number): Promise<ProcessIdentity> {
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    );
    return parseTasklistCsv(stdout);
  } catch {
    return INDETERMINATE;
  }
}

/**
 * Parse `tasklist /FO CSV /NH` output. A match looks like:
 *   `"node.exe","1234","Console","1","45,678 K"`
 * No match prints an INFO line that does not start with a quote.
 * Exported for unit testing (the probe itself can't run cross-platform).
 */
export function parseTasklistCsv(stdout: string): ProcessIdentity {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('"'));
  if (!line) return INDETERMINATE;
  const match = line.match(/^"([^"]+)"/);
  const name = match?.[1]?.trim() ?? "";
  return name ? { kind: "name", name } : INDETERMINATE;
}
