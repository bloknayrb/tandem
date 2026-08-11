/**
 * Host environment facts shared by the two diagnostics producers: the
 * `GET /api/diagnostics` HTTP route (`routes/diagnostics.ts`) and the
 * `tandem_diagnostics` MCP tool (`diagnostics.ts`). Both used to inline the
 * same four `process.*` reads; collapsing them here means the producers cannot
 * drift apart. The wire type lives in `shared/diagnostics.ts` so the client
 * formatter shares it too.
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
 *
 * Not memoized. The reads total ~60µs, against a route whose collector spawns
 * `npm ls -g`, probes two ports and stats a directory — caching them would buy
 * under 0.01% and cost module state plus a reset seam.
 */

import os from "node:os";
import type { HostInfo } from "../../shared/diagnostics.js";

export type { HostInfo };

/** Upper bound on `os.version()`. Darwin's kernel banner is ~100 chars. */
const MAX_OS_VERSION_LENGTH = 120;

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

/** Collect the host environment fields. Side-effect free; safe to call per request. */
export function collectHostInfo(): HostInfo {
  // One `os.cpus()` call — it allocates an object per core, and both CPU fields
  // read from the same array.
  const cpus = tryValue(() => os.cpus()) ?? [];
  const model = cpus[0]?.model?.trim().replace(/\s+/g, " ");
  // Spread-then-slice truncates on code points, not UTF-16 units. A plain
  // `.slice()` can bisect a surrogate pair, and the lone surrogate that leaves
  // behind makes `encodeURIComponent` throw — which silently drops the entire
  // Report-a-bug prefill. Same hazard `buildBugReportUrl` avoids by cutting on
  // line boundaries.
  const version = tryValue(() => [...os.version()].slice(0, MAX_OS_VERSION_LENGTH).join(""));

  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    tauriSidecar: process.env.TANDEM_TAURI_SIDECAR === "1",
    osRelease: tryValue(() => os.release()) || undefined,
    osVersion: version || undefined,
    cpuModel: model || undefined,
    cpuCount: cpus.length || undefined,
    // No `|| undefined` on the memory fields: 0 MB free is a real, and rather
    // interesting, reading — unlike a 0 CPU count, which only means "unknown".
    totalMemoryMb: tryValue(() => toMb(os.totalmem())),
    freeMemoryMb: tryValue(() => toMb(os.freemem())),
  };
}
