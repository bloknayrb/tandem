/**
 * Wire types shared by the diagnostics producers and their client.
 *
 * Type-only, and deliberately free of `node:os` so the client bundle can import
 * it: the server fills these in (`src/server/mcp/host-info.ts`), the client
 * formats them (`src/client/utils/diagnostics.ts`), and the zod shape in
 * `src/server/mcp/output-schemas.ts` describes them at runtime. Before this
 * file the interface was hand-copied on both sides, which made the client copy
 * the one most likely to drift — nothing type-checked it against the server.
 */

/**
 * Host environment facts attached to every diagnostics payload.
 *
 * Everything below `tauriSidecar` is OPTIONAL by necessity, not politeness:
 * `os.cpus()` returns `[]` under some cgroup-restricted containers and
 * `os.version()` can throw, so a required key would fail structured-output
 * validation on exactly those hosts. The formatter drops each field
 * individually rather than printing `undefined`.
 *
 * Privacy: this reaches a public GitHub issue. See the collector's docstring
 * for the list of things deliberately absent (hostname, username, home path,
 * network interfaces, locale, timezone).
 */
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
