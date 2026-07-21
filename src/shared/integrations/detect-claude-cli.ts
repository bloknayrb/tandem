import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { ClaudeCliPresence } from "./contract.js";

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
 */
export function detectClaudeCli(opts: DetectClaudeCliOptions = {}): ClaudeCliPresence {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();

  // On Windows `claude` is exposed under several names depending on how it was
  // installed: the native installer drops `claude.exe`, while
  // `npm i -g @anthropic-ai/claude-code` writes cmd-shim wrappers
  // (`claude.cmd` / `claude.ps1`) plus a bare `claude` bash shim. Probing
  // `claude.exe` alone reported a perfectly usable npm-global install as
  // NOT_INSTALLED — the exact false "not installed" warning this check exists to
  // avoid — so we check every candidate. POSIX only ever has the bare `claude`.
  const binNames =
    platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude.bat", "claude.ps1", "claude"]
      : ["claude"];
  const foundIn = (dir: string): boolean => binNames.some((name) => existsSync(join(dir, name)));

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
