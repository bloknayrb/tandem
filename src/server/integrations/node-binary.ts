/**
 * Which Node binary the generated `tandem-channel` MCP entry should invoke.
 *
 * Historically the entry was written as a bare `"node"`, which the MCP client
 * resolves through PATH at spawn time. That fails in two ways, both silent —
 * note they have different evidential standing:
 *
 *   1. **Node is not on the client's PATH at all.** OBSERVED: a macOS user's
 *      channel shim never started because bare `node` did not resolve. Claude
 *      Code now installs as a native binary (no Node required), and a
 *      GUI-launched client does not inherit a login shell's PATH. The user has
 *      a configured channel that delivers nothing.
 *   2. **Node resolves somewhere the client refuses to run it.** INFERRED, not
 *      observed for this entry. Claude Code rejects a bare-name tool whose
 *      resolved path sits under the current working directory — an
 *      anti-PATH-hijack guard, read out of `claude.exe` v2.1.223 and seen in
 *      the field for `git` during `claude plugin install`, never for a
 *      `tandem-channel` spawn. Whether an `mcpServers[].command` goes through
 *      that same resolver is NOT established. A per-user Node install plus a
 *      session started from the home directory would trip it.
 *
 * An absolute path fixes (1) outright and (2) if it applies: it needs no PATH
 * lookup, and — per the same v2.1.223 dispatch — a command containing a path
 * separator returns before the guard runs. Both quotes and their bounds are in
 * `docs/spikes/plugin-delivery.md`; they describe one vendor build and can go
 * stale on any Claude Code release.
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
 * see that; `refreshChannelNodeBinary` in `./apply.ts` is the boot-time
 * counterpart that can, gated by `isRecordedPathGone` below.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { isValidNodeBinary } from "../../shared/integrations/node-binary-name.js";
import { rejectUnsafeWindowsPrefix } from "../file-io/windows-path-safety.js";

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
  // Strip the extended-length DRIVE prefix first: `process.execPath` can
  // legitimately return `\\?\C:\…` on Windows, and the check below rejects
  // `\\?\` outright. The UNC form (`\\?\UNC\…`) is deliberately not stripped,
  // so it still reaches that check.
  const stripped = candidate.replace(WIN_EXTENDED_DRIVE_RE, "$1");

  // Check raw AND resolved — the idiom `document-service.ts`, `convert.ts` and
  // `annotations.ts` already use, and both halves are load-bearing:
  //
  //   raw      catches the POSIX mangling. `resolve` is platform-dependent
  //            where this guard is not: on Windows it preserves a leading
  //            `\\`, but on POSIX it treats `\\server\share\node.exe` as a
  //            RELATIVE name and prepends cwd, erasing the prefix and leaving
  //            a basename that validates.
  //   resolved catches a `..` traversal that lands on a UNC target.
  //
  // Checking only one trades one blind spot for the other.
  if (rejectUnsafeWindowsPrefix(stripped) !== null) return fallBackToBareNode(stripped);
  const absolute = resolve(stripped);
  if (rejectUnsafeWindowsPrefix(absolute) !== null) return fallBackToBareNode(absolute);
  if (isValidNodeBinary(absolute)) return absolute;
  return fallBackToBareNode(absolute);
}

function fallBackToBareNode(rejected: string): string {
  // Say so. Falling back silently would reintroduce the exact bug this module
  // exists to fix: the entry would carry the bare name that failed in the
  // field, the wizard's re-read would ACCEPT it (basename `node` validates),
  // and `tandem doctor` skips bare names — so the user would see a green
  // wizard, a passing doctor, and a channel that never starts, with nothing
  // anywhere explaining why. Reachable in practice: a UNC path, a Debian-
  // lineage `nodejs` basename, or a home directory containing `..`.
  console.error(
    `[Tandem] Cannot embed an absolute Node path in the channel entry: ` +
      `"${rejected}" is not an accepted Node binary name. Falling back to "node", ` +
      `which requires the MCP client to resolve it on PATH — if real-time push ` +
      `never arrives, this is why. Run 'tandem doctor' for the push-path check.`,
  );
  return BARE_NODE;
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
export function isRecordedPathGone(
  command: string,
  probe: (p: string) => boolean | null = probeNodeBinary,
): boolean {
  if (!command) return false;
  if (!/[/\\]/.test(command)) return false; // bare name
  return probe(command) === false;
}
