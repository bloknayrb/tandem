import { homedir } from "node:os";
import { basename, delimiter, extname, join } from "node:path";

import type { ClaudeCliPresence } from "./contract.js";
import { binNamesFor as binNamesForStem, isFile } from "./path-lookup.js";

/**
 * Pure-built-ins probe for the `claude` CLI binary, extracted to a shared leaf
 * so both the server integration layer (`apply.ts` re-exports it) AND the
 * built-ins-only CLI (`tandem doctor`) can call it without the CLI bundle
 * dragging in `apply.ts`'s server-coupled deps (platform/ACL/backup).
 */

export interface DetectClaudeCliOptions {
  /** Override `homedir()` — tests anchor the native-location probe under a tmpdir. */
  homeOverride?: string;
  /** Override `process.env.PATH` — tests inject a controlled PATH. */
  pathOverride?: string;
  /** Override `process.platform` — tests exercise the win32 `.exe` branch. */
  platformOverride?: NodeJS.Platform;
}

/**
 * Every filename `claude` can be installed under, in the order a shell would
 * find them. Thin default-arg wrapper over the shared rule in `path-lookup.ts`,
 * which owns the Windows candidate set and the `isFile` probe both walks below
 * depend on.
 *
 * `stem` is `"claude"` for the detector; {@link isBareNameLaunchable} passes the
 * `TANDEM_CLAUDE_CMD` override's basename, since that is the name the launcher
 * will actually search PATH for.
 *
 * The two walks in this file stay here rather than moving to
 * `resolveOnPath`: neither has first-hit semantics. See that module's header.
 */
function binNamesFor(platform: NodeJS.Platform, stem = "claude"): string[] {
  return binNamesForStem(platform, stem);
}

/**
 * Probe whether the `claude` CLI binary is present, independent of any config
 * file. This is the **binary** detector; `detectTargets` is the separate
 * **config-presence** detector (it answers "has Claude ever written a config
 * here?", which stays true after an uninstall and is true on a machine that
 * only has Claude Desktop).
 *
 * Pure filesystem probe — deliberately no `execFile`/spawn (no shell-injection
 * surface, no hang on a wedged binary). Returns:
 *   - `INSTALLED_ON_PATH` — `claude[.exe]` found on the process's PATH.
 *   - `INSTALLED_NOT_ON_PATH` — found only in `~/.local/bin` (the native
 *     installer's target, which is typically NOT on the process's PATH at
 *     install time → the usual immediately-post-install state).
 *   - `NOT_INSTALLED` — neither.
 *
 * PATH wins over `~/.local/bin`: if it's on PATH it's usable right now, which
 * is the more useful signal for callers.
 *
 * "Present" is not "startable" on Windows — see {@link isBareNameLaunchable}.
 */
export function detectClaudeCli(opts: DetectClaudeCliOptions = {}): ClaudeCliPresence {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();

  const binNames = binNamesFor(platform);
  const foundIn = (dir: string): boolean => binNames.some((name) => isFile(join(dir, name)));

  // `delimiter` is platform-specific (`;` on win32, `:` elsewhere). When a
  // platformOverride disagrees with the host, the override is for test
  // ergonomics only — real callers never pass it, so host `delimiter` is fine.
  const pathVar = opts.pathOverride ?? process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    if (foundIn(dir)) return "INSTALLED_ON_PATH";
  }

  // Native install location — same `~/.local/bin` on every platform per the
  // official installer's documented uninstall paths (Windows included).
  if (foundIn(join(home, ".local", "bin"))) return "INSTALLED_NOT_ON_PATH";

  return "NOT_INSTALLED";
}

export interface BareNameLaunchableOptions extends DetectClaudeCliOptions {
  /** Override `process.env.TANDEM_CLAUDE_CMD` — tests inject a launcher override. */
  claudeCmdOverride?: string;
}

/**
 * Can Tandem's auto-launcher actually *start* the CLI it just detected?
 *
 * `detectClaudeCli` answers "is it installed?"; this answers the narrower and
 * more operational question, and on Windows the two can disagree. The launcher
 * hands the reaper a **bare program name** (`supervisor.ts#claudeCommand`),
 * which the reaper passes to `CreateProcessW` with `lpApplicationName = NULL`.
 * That search appends only `.exe` — `PATHEXT` is a *shell* feature, not a Win32
 * one — so an npm-global install (`claude.cmd` / `claude.ps1` / a bare bash
 * shim, no `.exe`) is detected as INSTALLED_ON_PATH and is nonetheless
 * unstartable. Measured on this codebase: an npm-shimmed CLI gives ENOENT while
 * a native-installer `.exe` spawns.
 *
 * Nor is a concrete path a workaround worth documenting here: Node ≥18.20.2
 * refuses to `spawn`/`execFile` a `.cmd`/`.bat` without `shell: true`
 * (CVE-2024-27980 hardening) and throws EINVAL *synchronously*. Both of
 * Tandem's spawn mechanisms are defeated by a shim; only `.exe` is reachable.
 *
 * **The whole PATH must be walked** — `resolveCli`-style "first directory
 * containing any candidate" logic is wrong for this question. `CreateProcessW`
 * skips directories lacking a `.exe` and keeps searching, so a user with a shim
 * directory *ahead* of a real `claude.exe` launches fine; answering from the
 * first hit would tell that working user they are broken.
 *
 * `TANDEM_CLAUDE_CMD` replaces the command the launcher spawns, so every branch
 * below is about *that* command when it is set — including the full-path-to-a-
 * `.exe` form this check's own remedy text recommends (the reaper quotes the
 * program, so spaces are fine).
 *
 * Returns `true` whenever the question doesn't apply — on POSIX (bare names are
 * the executable) and when no candidate is on PATH at all (that is
 * `NOT_INSTALLED` / `INSTALLED_NOT_ON_PATH`, which callers already report on
 * their own terms). `false` is reserved for the one affirmative finding: a
 * shim, and no `.exe`, under the name the launcher will actually search for.
 */
export function isBareNameLaunchable(opts: BareNameLaunchableOptions = {}): boolean {
  const platform = opts.platformOverride ?? process.platform;
  if (platform !== "win32") return true;

  const override = opts.claudeCmdOverride ?? process.env.TANDEM_CLAUDE_CMD;
  const ext = override ? extname(override).toLowerCase() : "";
  if (ext) {
    // An explicit extension settles it: `CreateProcessW` runs a `.exe` and
    // cannot run the wrapper formats, whatever the rest of PATH holds.
    if (ext === ".exe") return true;
    if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") return false;
    return true; // Some other extension — not a shim we know how to indict.
  }
  if (override && basename(override) !== override) {
    // Extensionless but a concrete path, so there is no PATH search at all:
    // `CreateProcessW` appends `.exe` to this literal path and runs that.
    return isFile(`${override}.exe`);
  }

  // Bare name — the PATH search. Probe the name the launcher will really use,
  // NOT `claude`: with `TANDEM_CLAUDE_CMD=claude-canary` an unrelated
  // `claude.cmd` on PATH would otherwise produce a confident finding about a
  // program that is never spawned.
  const binNames = binNamesFor(platform, override || "claude");
  const launchable = binNames.filter((name) => name.toLowerCase().endsWith(".exe"));

  let sawShimOnPath = false;
  const pathVar = opts.pathOverride ?? process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    if (launchable.some((name) => isFile(join(dir, name)))) return true;
    if (binNames.some((name) => isFile(join(dir, name)))) sawShimOnPath = true;
  }
  return !sawShimOnPath;
}
