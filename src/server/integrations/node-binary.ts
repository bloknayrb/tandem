/**
 * Which Node binary the generated `tandem-channel` MCP entry should invoke.
 *
 * Historically the entry was written as a bare `"node"`, which the MCP client
 * resolves through PATH at spawn time. That fails in two distinct ways seen in
 * the field, both silent:
 *
 *   1. **Node is not on the client's PATH at all.** Claude Code now installs as
 *      a native binary (no Node required), and a GUI-launched client does not
 *      inherit a login shell's PATH. The shim simply never starts, so the user
 *      has a configured channel that delivers nothing.
 *   2. **Node resolves somewhere the client refuses to run it.** Claude Code
 *      rejects a bare-name tool whose resolved path sits under the current
 *      working directory — an anti-PATH-hijack guard. A per-user Node install
 *      (`%APPDATA%\npm`, `~/.local`) plus a session started from the home
 *      directory trips it on the user's own legitimate Node.
 *
 * An absolute path fixes both: it needs no PATH lookup, and a command
 * containing a path separator skips the hijack guard entirely.
 *
 * `process.execPath` is the right source. It is the Node already running
 * Tandem, so it demonstrably exists and can run the shim — and in the desktop
 * app it is the bundled sidecar, which `isValidNodeBinary`'s
 * `node-sidecar-<triple>` alternative was written to accept. That validator is
 * the contract this module must satisfy: the wizard re-reads generated config
 * through it (`existing-config.ts`), so emitting a path it rejects would make
 * Tandem report its own correct entry as invalid.
 *
 * The trade is a resolution failure for a staleness failure — a recorded
 * absolute path can outlive the binary (a deleted nvm version, a Tauri update,
 * macOS App Translocation, an AppImage remount). Write-time validation cannot
 * see that; `revalidateNodeBinary` is the boot-time counterpart that can.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { isValidNodeBinary } from "../../shared/integrations/node-binary-name.js";

/** The pre-existing behaviour, and the fallback whenever an absolute path
 *  cannot be produced or would not validate. Never emit something the
 *  validator rejects — that is strictly worse than the bare name. */
export const BARE_NODE = "node";

/**
 * Windows extended-length prefix, DRIVE form only (`\\?\C:\…`).
 *
 * Deliberately not `^\\\\\?\\` — `\\?\UNC\server\share\…` must keep its leading
 * `\\` so `isValidNodeBinary`'s UNC rejection still fires. Stripping the prefix
 * blindly would convert an NTLM-leaking UNC path into one that validates, which
 * is the opposite of what this normalization is for.
 */
const WIN_EXTENDED_DRIVE_RE = /^\\\\\?\\([A-Za-z]:)/;

/**
 * Resolve the Node binary to embed in a generated `tandem-channel` entry.
 *
 * Returns an absolute, validator-clean path, or `BARE_NODE` when one cannot be
 * produced. `candidate` is injectable for tests; production always wants the
 * default.
 */
export function resolveNodeBinary(candidate: string = process.execPath): string {
  if (!candidate) return BARE_NODE;
  const stripped = candidate.replace(WIN_EXTENDED_DRIVE_RE, "$1");
  // `resolve` normalizes away any `..`, which the validator rejects outright.
  const absolute = resolve(stripped);
  return isValidNodeBinary(absolute) ? absolute : BARE_NODE;
}

/**
 * Does this path name a file — or can we not tell?
 *
 * Three-state on purpose, and that is the whole point of not reusing
 * `detect-claude-cli.ts`'s `isFile`. That helper is deliberately TOTAL: it
 * answers `false` when it cannot tell, because there "I could not read it" is
 * not evidence of an install. Here the polarity is inverted — a `false` makes
 * the caller REWRITE the user's `~/.claude.json`, so collapsing EACCES, ELOOP
 * or a disconnected network share into `false` would clobber a working config
 * on the strength of a probe that never ran.
 *
 *   - `false` — definitely not a usable binary (absent, or a directory).
 *   - `null`  — could not determine; callers must leave the config alone.
 */
export function probeNodeBinary(path: string): boolean | null {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return false; // ENOENT — definitely gone
    return stat.isFile();
  } catch {
    return null; // EACCES / ELOOP / unreachable share — not evidence of absence
  }
}

/**
 * Is a previously-recorded `tandem-channel` command still usable?
 *
 * `true` means the recorded value is an absolute path that definitely no longer
 * resolves to a file — the staleness case above — and should be rewritten.
 *
 * Two cases deliberately report NOT stale:
 *   - A bare name. Whether it resolves is the client's lookup to perform at
 *     spawn time, not ours to second-guess, and rewriting it would undo a
 *     deliberate fallback.
 *   - An unreadable path (`probe` → `null`). Never rewrite a user's config on
 *     the strength of a probe that could not run.
 */
export function isRecordedNodeBinaryStale(
  command: string,
  probe: (p: string) => boolean | null = probeNodeBinary,
): boolean {
  if (!command) return false;
  if (!/[/\\]/.test(command)) return false; // bare name
  return probe(command) === false;
}
