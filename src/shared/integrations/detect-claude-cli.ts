import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";

import { rejectUnsafeWindowsPrefix } from "../windows-path-safety.js";
import type { ClaudeCliPresence } from "./contract.js";
import { binNamesFor, isFile, isOnPath } from "./path-lookup.js";

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
 * "Present" is not "startable" — see {@link resolveClaudeLaunch}, which is
 * what the launcher runs. The two answer different questions and can differ at
 * the edges (a `claude` without the execute bit, one only in a relative PATH
 * entry, a Windows shim): this one says whether to offer an install.
 */
export function detectClaudeCli(opts: DetectClaudeCliOptions = {}): ClaudeCliPresence {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();

  // First-hit over PATH is exactly `isOnPath`'s semantics, so this half shares
  // it. The OTHER walk in this file (`resolveClaudeLaunch`) does not and keeps
  // its own loop — it must see the whole PATH to distinguish "a shim, and no
  // `.exe` anywhere" from "a shim ahead of a real `.exe`".
  if (isOnPath("claude", { pathOverride: opts.pathOverride, platformOverride: platform })) {
    return "INSTALLED_ON_PATH";
  }

  const foundIn = (dir: string): boolean =>
    binNamesFor(platform, "claude").some((name) => isFile(join(dir, name)));

  // Native install location — same `~/.local/bin` on every platform per the
  // official installer's documented uninstall paths (Windows included).
  if (foundIn(join(home, ".local", "bin"))) return "INSTALLED_NOT_ON_PATH";

  return "NOT_INSTALLED";
}

export interface BareNameLaunchableOptions extends DetectClaudeCliOptions {
  /** Override `process.env.TANDEM_CLAUDE_CMD` — tests inject a launcher override. */
  claudeCmdOverride?: string;
}

/** What the auto-launcher would spawn ({@link resolveClaudeLaunch}). */
export interface ClaudeLaunch {
  /** The ABSOLUTE path the launcher hands the reaper, or `null` when nothing
   * startable resolves — in which case it spawns nothing at all. */
  command: string | null;
  /** Nothing startable, and the affirmative "there, but Tandem cannot start
   * it" finding instead: a Windows wrapper (`.cmd` / `.bat` / `.ps1` / a bare
   * bash shim) where the `.exe` should be (#1273), or a Windows
   * `TANDEM_CLAUDE_CMD` path that names no startable `.exe`. */
  knownUnstartable: boolean;
}

const WINDOWS_WRAPPER_EXTS = new Set([".cmd", ".bat", ".ps1"]);
const NOTHING: ClaudeLaunch = { command: null, knownUnstartable: false };
const UNSTARTABLE: ClaudeLaunch = { command: null, knownUnstartable: true };

/**
 * The program Tandem's auto-launcher spawns: always an ABSOLUTE path, or
 * `null` (#2199).
 *
 * It used to hand the reaper the bare name (`TANDEM_CLAUDE_CMD || "claude"`),
 * which went wrong two ways:
 *   - **A fresh native install was never found.** The installer drops
 *     `~/.local/bin/claude[.exe]` and edits the PATH of terminals opened
 *     later, never the PATH this process started with — so Tandem crash-looped
 *     into a "restart" diagnosis until Tandem itself was restarted. The native
 *     location is now probed directly, after PATH.
 *   - **On Windows a bare name searches the working directory.** The reaper
 *     calls `CreateProcessW` with no application name, whose search order puts
 *     the CURRENT DIRECTORY — the reaper's cwd, the user's chosen working
 *     directory — ahead of PATH. A `claude.exe` sitting in a cloned repo would
 *     have run in place of the real one. An absolute path does no search at
 *     all, so a bare name never reaches the reaper on any platform.
 *
 * Rules, all pure filesystem probes (no spawn):
 *   - `TANDEM_CLAUDE_CMD` (else `claude`) as a concrete path must be ABSOLUTE —
 *     a relative one would resolve against the reaper's cwd, the hole above —
 *     and name a startable file: on Windows a `.exe` (an extensionless path
 *     gets `.exe` appended, as `CreateProcessW` would), never a wrapper, which
 *     `CreateProcessW` would hand to cmd.exe.
 *   - A bare name is looked up on PATH, absolute entries only (an empty or
 *     relative entry means the cwd). Windows looks for `<name>.exe` alone and
 *     walks the WHOLE path, because a wrapper directory ahead of a real `.exe`
 *     is a working setup. Surrounding quotes on a Windows entry are stripped,
 *     as cmd.exe does.
 *   - Only for the default name, the native install location
 *     `<home>/.local/bin/claude[.exe]`. Not for an override: a user who named a
 *     different program did not ask for this one.
 *   - POSIX requires the execute bit (`execvp` skips a hit it cannot run and
 *     keeps searching; this must not pick it). Windows candidates pass
 *     `rejectUnsafeWindowsPrefix` before any `stat`, so a UNC PATH entry or
 *     home never triggers the SMB handshake.
 *   - The result is not `realpath`ed: `~/.local/bin/claude` is a link into the
 *     installer's versions directory, and the link is what follows an update.
 *
 * Total: never throws. Read per spawn, never cached, so an install made while
 * Tandem runs is picked up by the next start.
 */
export function resolveClaudeLaunch(opts: BareNameLaunchableOptions = {}): ClaudeLaunch {
  try {
    return resolveClaudeLaunchUnguarded(opts);
  } catch {
    return NOTHING;
  }
}

function resolveClaudeLaunchUnguarded(opts: BareNameLaunchableOptions): ClaudeLaunch {
  const platform = opts.platformOverride ?? process.platform;
  const win32 = platform === "win32";
  const override = opts.claudeCmdOverride ?? process.env.TANDEM_CLAUDE_CMD;
  const name = override || "claude";
  const ext = extname(name).toLowerCase();

  // The launch this candidate would be, or null. Resolved first, and that
  // resolved path is both what is checked and what is run: on Windows a
  // root-relative `\bin\claude.exe` counts as absolute but names a different
  // drive from the reaper's cwd than from this process's (#2199 review).
  const launch = (candidate: string): ClaudeLaunch | null => {
    const abs = resolve(candidate);
    if (win32 && rejectUnsafeWindowsPrefix(abs) !== null) return null;
    if (!isFile(abs)) return null;
    if (!win32) {
      try {
        accessSync(abs, constants.X_OK);
      } catch {
        return null;
      }
    }
    return { command: abs, knownUnstartable: false };
  };

  // A concrete path: no search, but it must be absolute.
  if (basename(name) !== name || (win32 && name.includes("/"))) {
    if (!isAbsolute(name)) return win32 ? UNSTARTABLE : NOTHING;
    if (win32) {
      const candidate = ext === "" ? `${name}.exe` : ext === ".exe" ? name : null;
      return (candidate !== null && launch(candidate)) || UNSTARTABLE;
    }
    return launch(name) ?? NOTHING;
  }

  // A bare name: PATH. On Windows only `<stem>.exe` is startable.
  if (win32 && WINDOWS_WRAPPER_EXTS.has(ext)) return UNSTARTABLE;
  if (win32 && ext !== "" && ext !== ".exe") return NOTHING;
  const stem = win32 && ext === ".exe" ? name.slice(0, -4) : name;
  const wrappers = win32 ? binNamesFor("win32", stem).filter((n) => !n.endsWith(".exe")) : [];
  let sawWrapper = false;
  const pathVar = opts.pathOverride ?? process.env.PATH ?? "";
  for (const raw of pathVar.split(delimiter)) {
    const dir = win32 ? raw.replace(/^"(.*)"$/, "$1") : raw;
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    if (win32 && rejectUnsafeWindowsPrefix(dir) !== null) continue;
    const hit = launch(join(dir, win32 ? `${stem}.exe` : stem));
    if (hit) return hit;
    if (!sawWrapper && wrappers.some((n) => isFile(join(dir, n)))) sawWrapper = true;
  }

  // The native installer's location, for the default name only.
  if (!override) {
    const home = opts.homeOverride ?? homedir();
    if (!win32 || rejectUnsafeWindowsPrefix(home) === null) {
      const hit = launch(join(home, ".local", "bin", win32 ? "claude.exe" : "claude"));
      if (hit) return hit;
    }
  }
  return { command: null, knownUnstartable: sawWrapper };
}

/**
 * Can Tandem's auto-launcher start the CLI — or does the question not apply?
 *
 * The wire field `bareNameLaunchable` (the wizard's shim warning), `tandem
 * doctor` and the installer's idempotency guard all read this. It is now a
 * reading of {@link resolveClaudeLaunch} — the very command the launcher
 * spawns — so the three can no longer disagree with the launcher (the name is
 * historical: the launcher no longer spawns a bare name at all).
 *
 * `false` is reserved for the affirmative finding (`knownUnstartable`): nothing
 * startable, and a Windows wrapper (`claude.cmd` / `claude.ps1` / a bare bash
 * shim, as an npm global install leaves) found instead, which cmd and
 * PowerShell run but `CreateProcessW` cannot (#1273) — or a Windows
 * `TANDEM_CLAUDE_CMD` path naming no startable `.exe`. Node ≥18.20.2 refuses to spawn a `.cmd`
 * without `shell: true` too, so no concrete-path workaround exists for it.
 * Anything else — POSIX, nothing installed, an override that resolves to
 * nothing — answers `true`, because callers report those on their own terms
 * (`NOT_INSTALLED` / `INSTALLED_NOT_ON_PATH`).
 */
export function isBareNameLaunchable(opts: BareNameLaunchableOptions = {}): boolean {
  // Off Windows nothing is `knownUnstartable`, so the walk could only answer
  // true: skip it.
  if ((opts.platformOverride ?? process.platform) !== "win32") return true;
  const launch = resolveClaudeLaunch(opts);
  return launch.command !== null || !launch.knownUnstartable;
}
