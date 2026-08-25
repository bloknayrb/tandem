import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where each Claude client keeps its MCP config, as pure built-ins.
 *
 * Extracted from `detectTargets` (`server/integrations/apply.ts`) so
 * `tandem doctor` can inspect the SAME files Tandem writes without importing
 * `apply.ts`'s server-coupled deps (platform/ACL/backup) — the same reason
 * `detect-claude-cli.ts` exists as a leaf, and doctor's header insists on
 * built-ins only.
 *
 * Sharing this is not tidiness. Until now doctor read `~/.claude.json` and a
 * project-local `.mcp.json` and nothing else, so the entire Claude Desktop
 * surface — the one that gets the stdio entry, and the one a spawn failure was
 * reported against — was invisible to every diagnostic Tandem ships. A second,
 * hand-maintained copy of the platform switch would let that gap reopen
 * quietly: the diagnosis would drift from the write target and doctor would
 * confidently report on a file Tandem no longer touches.
 *
 * SCOPE: the Windows MSIX variants are deliberately NOT here. Finding those
 * needs a `readdir` of `%LOCALAPPDATA%\Packages` plus the `assertPathSafe`
 * containment check `detectTargets` performs, which is a write-side security
 * boundary rather than a path rule. Doctor covers the plain `%APPDATA%` config;
 * `detectTargets` remains the only enumerator that walks packages.
 */

export interface ClientConfigPathOptions {
  /** Override `homedir()` — tests anchor probes under a tmpdir. */
  homeOverride?: string;
  /** Override `process.platform` — tests exercise each branch. */
  platformOverride?: NodeJS.Platform;
  /** Override `%APPDATA%`. Ignored off win32. */
  appDataOverride?: string;
}

/** Claude Code's MCP registry. Same path on every platform. */
export function claudeCodeConfigPath(opts: ClientConfigPathOptions = {}): string {
  return join(opts.homeOverride ?? homedir(), ".claude.json");
}

/**
 * Claude Desktop's MCP config for this platform.
 *
 * `homeOverride` WINS over `%APPDATA%` on Windows, and that ordering is a
 * containment boundary rather than a preference: `%APPDATA%` is set on every
 * real Windows box, so reading it first would make the override partial and
 * hand a caller that redirected `home` to a temp dir the developer's real
 * config path back. `detectTargets` learned that the hard way — a test wrote a
 * fixture token into a live Claude Desktop config on 2026-08-09 — and this
 * copy must not relearn it.
 */
export function claudeDesktopConfigPath(opts: ClientConfigPathOptions = {}): string {
  return claudeDesktopConfigTarget(opts).path;
}

/** Where the Claude Desktop config lives, and the untrusted value it derives from. */
export interface ClaudeDesktopConfigTarget {
  /**
   * The caller-influenced value `path` is built from, **before any `join`** —
   * the thing a path-safety screen must be pointed at.
   *
   * A screen applied to `path` instead is not equivalent, and the difference is
   * silent. `path.posix.join` collapses a leading `//` to `/`, so on a Linux
   * runner four of the fourteen hostile spellings in
   * `tests/helpers/unc-fixtures.ts` derive a path that
   * `rejectUnsafeWindowsPrefix` then *accepts* — a guard on the derivative
   * cannot fire for them, and the test passes because the path stopped being
   * dangerous rather than because anything screened it (#1529's shape).
   *
   * Which value this is depends on the branch `path` took, and the two
   * caller-supplied inputs have OPPOSITE precedence: `appDataOverride` beats
   * `homeOverride`, while `%APPDATA%` loses to it. That is exactly why this is
   * returned from the resolver rather than recomputed by the caller — a mirror
   * maintained next to a consumer drifts from the branch it is mirroring, and
   * `doctor.ts` shipped such a mirror that reproduced only the `%APPDATA%` half.
   */
  screenInput: string;
  /** The config file itself. */
  path: string;
}

/**
 * Claude Desktop's MCP config for this platform, paired with the unjoined value
 * it derives from. See {@link claudeDesktopConfigPath} for the precedence
 * rationale and {@link ClaudeDesktopConfigTarget.screenInput} for why a caller
 * that wants to screen the path must screen this instead.
 */
export function claudeDesktopConfigTarget(
  opts: ClientConfigPathOptions = {},
): ClaudeDesktopConfigTarget {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();

  if (platform === "win32") {
    // Each branch returns the value it actually consumed, so `screenInput`
    // cannot fall out of step with the branch `path` took.
    if (opts.appDataOverride !== undefined) {
      return { screenInput: opts.appDataOverride, path: desktopUnder(opts.appDataOverride) };
    }
    if (opts.homeOverride) {
      return {
        screenInput: opts.homeOverride,
        path: desktopUnder(join(opts.homeOverride, "AppData", "Roaming")),
      };
    }
    const appData = process.env.APPDATA;
    if (appData !== undefined) {
      return { screenInput: appData, path: desktopUnder(appData) };
    }
    return { screenInput: home, path: desktopUnder(join(home, "AppData", "Roaming")) };
  }
  if (platform === "darwin") {
    return { screenInput: home, path: desktopUnder(join(home, "Library", "Application Support")) };
  }
  return {
    screenInput: home,
    path: join(home, ".config", "claude", "claude_desktop_config.json"),
  };
}

/** The `Claude/claude_desktop_config.json` leaf, under an already-resolved base. */
function desktopUnder(base: string): string {
  return join(base, "Claude", "claude_desktop_config.json");
}
