/**
 * Host environment facts shared by the two diagnostics producers: the
 * `GET /api/diagnostics` HTTP route (`routes/diagnostics.ts`) and the
 * `tandem_diagnostics` MCP tool (`diagnostics.ts`). Both used to inline the
 * same four `process.*` reads; collapsing them here means two of the three
 * lockstep files (the third is the zod shape in `output-schemas.ts`) cannot
 * drift apart.
 *
 * Privacy: this output reaches a public GitHub issue — Copy Diagnostics puts it
 * on the clipboard, and the Report-a-bug link prefills it into an issue body.
 * The same constraint `doctor.ts` states for check messages applies here, so
 * the following are DELIBERATELY absent and must stay absent:
 *
 *   os.hostname()          — machine name, frequently the user's own name
 *   os.userInfo()          — username, uid, shell, homedir
 *   os.homedir()           — absolute path containing the username
 *   os.networkInterfaces() — MAC addresses and LAN topology
 *   process.pid            — no diagnostic value off-machine
 *   process.env            — tokens
 *   locale / timeZone      — coarse location; declined deliberately
 *
 * Every field is individually guarded: a throw or an empty result yields
 * `undefined` rather than failing the whole diagnostics call. `os.cpus()`
 * returns `[]` under some cgroup-restricted containers, which is exactly why
 * the CPU fields are optional rather than defaulted.
 */

import os from "node:os";

/** Upper bound on `os.version()`. Darwin's kernel banner is ~100 chars. */
const MAX_OS_VERSION_LENGTH = 120;

export interface HostInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  tauriSidecar: boolean;
  /** `os.release()` — e.g. "10.0.26100", "23.5.0". */
  osRelease?: string;
  /** `os.version()` — e.g. "Windows 11 Pro", or a kernel banner. */
  osVersion?: string;
  /** First CPU's model string, whitespace-collapsed. */
  cpuModel?: string;
  /** Logical CPU count. */
  cpuCount?: number;
  /** Total physical memory, MiB. */
  totalMemoryMb?: number;
  /** Free physical memory, MiB. */
  freeMemoryMb?: number;
}

/** The subset that never changes for the process lifetime. */
type StaticHostInfo = Omit<HostInfo, "freeMemoryMb">;

function tryValue<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function collectStatic(): StaticHostInfo {
  const cpus = tryValue(() => os.cpus()) ?? [];
  const model = cpus[0]?.model?.trim().replace(/\s+/g, " ");
  const version = tryValue(() => os.version())?.slice(0, MAX_OS_VERSION_LENGTH);
  const totalMemoryMb = tryValue(() => toMb(os.totalmem()));

  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    tauriSidecar: process.env.TANDEM_TAURI_SIDECAR === "1",
    osRelease: tryValue(() => os.release()) || undefined,
    osVersion: version || undefined,
    cpuModel: model || undefined,
    cpuCount: cpus.length || undefined,
    totalMemoryMb,
  };
}

let cachedStatic: StaticHostInfo | null = null;

/**
 * Collect the host environment fields. Static values are memoized (`os.cpus()`
 * is a syscall and this runs on every diagnostics request); free memory is read
 * fresh each call because it is the only field that moves.
 */
export function collectHostInfo(): HostInfo {
  cachedStatic ??= collectStatic();
  return { ...cachedStatic, freeMemoryMb: tryValue(() => toMb(os.freemem())) };
}

/** Test seam — drops the memoized static block. */
export function _resetHostInfoCache(): void {
  cachedStatic = null;
}
