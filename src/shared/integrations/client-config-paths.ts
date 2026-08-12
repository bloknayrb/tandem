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
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();

  if (platform === "win32") {
    const appdata =
      opts.appDataOverride ??
      (opts.homeOverride
        ? join(opts.homeOverride, "AppData", "Roaming")
        : (process.env.APPDATA ?? join(home, "AppData", "Roaming")));
    return join(appdata, "Claude", "claude_desktop_config.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "claude", "claude_desktop_config.json");
}
