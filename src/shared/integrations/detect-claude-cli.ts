import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { ClaudeCliPresence, CodexCliPresence } from "./contract.js";

/**
 * Pure-built-ins probe for an assistant CLI binary (`claude` / `codex`),
 * extracted to a shared leaf so both the server integration layer
 * (`apply.ts` re-exports {@link detectClaudeCli}) AND the built-ins-only CLI
 * (`tandem doctor`) can call it without the CLI bundle dragging in `apply.ts`'s
 * server-coupled deps (platform/ACL/backup).
 *
 * **Do not import anything from `src/server/` here.** The leaf-module property
 * is the whole reason this file exists.
 *
 * Originally Claude-only; the Codex twin (`detect-codex-cli.ts`) was a
 * copy-paste of this module and has been folded back in. The two providers
 * differ in exactly two axes — the candidate binary names and the *standalone*
 * (off-PATH) install directory — both captured in {@link CLI_PROBES} below.
 */

/** Providers whose CLI this module can probe for. */
export type CliProvider = "claude" | "codex";

export interface DetectClaudeCliOptions {
  /** Override `homedir()` — tests anchor the native-location probe under a tmpdir. */
  homeOverride?: string;
  /** Override `process.env.PATH` — tests inject a controlled PATH. */
  pathOverride?: string;
  /** Override `process.platform` — tests exercise the win32 `.exe` branch. */
  platformOverride?: NodeJS.Platform;
  /**
   * Override `process.env.LOCALAPPDATA` — only consulted by providers whose
   * win32 standalone location lives under `%LOCALAPPDATA%` (Codex today).
   * Present on the shared options type so the provider × platform table can be
   * exercised from tests without touching the host environment.
   */
  localAppDataOverride?: string;
}

/** Alias kept for the Codex call sites that predate the merge. */
export type DetectCodexCliOptions = DetectClaudeCliOptions;

export interface ResolvedCli {
  /** Absolute path to the concrete executable/shim/script that was found. */
  path: string;
  /** True when found via a `PATH` directory, as opposed to a well-known standalone install location. */
  onPath: boolean;
  /**
   * True when the resolved file is a `.ps1` script, which needs a PowerShell
   * interpreter rather than being directly exec/spawn-able.
   */
  needsPwshInterpreter: boolean;
}

/** Alias kept for the Codex call sites that predate the merge. */
export type ResolvedCodexCli = ResolvedCli;

interface CliProbe {
  /**
   * Candidate filenames, most-specific first. On Windows a CLI is exposed
   * under several names depending on how it was installed: a native installer
   * drops `<name>.exe`, while an `npm i -g` writes cmd-shim wrappers
   * (`<name>.cmd` / `<name>.ps1`) plus a bare `<name>` bash shim. Probing the
   * `.exe` alone reported a perfectly usable npm-global install as
   * NOT_INSTALLED — the exact false "not installed" warning this check exists
   * to avoid — so we check every candidate. POSIX only ever has the bare name.
   */
  names(platform: NodeJS.Platform): string[];
  /**
   * The provider's standalone (off-PATH) install directory for `platform`.
   * This is the axis on which the two providers actually diverge:
   *   - `claude` → `~/.local/bin` on **every** platform, per the official
   *     installer's documented uninstall paths (Windows included).
   *   - `codex`  → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` on win32,
   *     `~/.local/bin` elsewhere.
   */
  standaloneDir(platform: NodeJS.Platform, ctx: { home: string; localAppData: string }): string;
}

function windowsNames(base: string): string[] {
  return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, `${base}.ps1`, base];
}

/** Provider × platform table. Adding a provider means adding a row here. */
const CLI_PROBES: Record<CliProvider, CliProbe> = {
  claude: {
    names: (platform) => (platform === "win32" ? windowsNames("claude") : ["claude"]),
    standaloneDir: (_platform, { home }) => join(home, ".local", "bin"),
  },
  codex: {
    names: (platform) => (platform === "win32" ? windowsNames("codex") : ["codex"]),
    standaloneDir: (platform, { home, localAppData }) =>
      platform === "win32"
        ? join(localAppData, "Programs", "OpenAI", "Codex", "bin")
        : join(home, ".local", "bin"),
  },
};

/**
 * Filesystem-only CLI resolution; never executes a discovered binary.
 *
 * Returns the concrete resolved path (with its real extension) rather than a
 * presence enum, so callers can exec/spawn the exact file instead of a bare
 * name that Windows' libuv-based spawn cannot resolve through PATHEXT for
 * `.cmd`/`.bat` shims (see `codex-config.ts` / `app-server-client.ts`).
 *
 * PATH wins over the standalone location: if it's on PATH it's usable right
 * now, which is the more useful signal for callers.
 */
export function resolveCli(
  provider: CliProvider,
  opts: DetectClaudeCliOptions = {},
): ResolvedCli | null {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();
  const probe = CLI_PROBES[provider];
  const names = probe.names(platform);
  const findIn = (dir: string): string | undefined =>
    names.map((name) => join(dir, name)).find((candidate) => existsSync(candidate));
  const resolved = (path: string, onPath: boolean): ResolvedCli => ({
    path,
    onPath,
    needsPwshInterpreter: path.toLowerCase().endsWith(".ps1"),
  });

  // `delimiter` is platform-specific (`;` on win32, `:` elsewhere). When a
  // platformOverride disagrees with the host, the override is for test
  // ergonomics only — real callers never pass it, so host `delimiter` is fine.
  for (const dir of (opts.pathOverride ?? process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const found = findIn(dir);
    if (found) return resolved(found, true);
  }

  const localAppData =
    opts.localAppDataOverride ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const found = findIn(probe.standaloneDir(platform, { home, localAppData }));
  return found ? resolved(found, false) : null;
}

/**
 * Probe whether a provider's CLI binary is present, independent of any config
 * file. This is the **binary** detector; `detectTargets` / `detectCodexTargets`
 * are the separate **config-presence** detectors (they answer "has this
 * assistant ever written a config here?", which stays true after an uninstall
 * and is true on a machine that only has Claude Desktop).
 *
 * Pure filesystem probe — deliberately no `execFile`/spawn (no shell-injection
 * surface, no hang on a wedged binary). Returns:
 *   - `INSTALLED_ON_PATH` — found on the process's PATH.
 *   - `INSTALLED_NOT_ON_PATH` — found only in the provider's standalone install
 *     location, which is typically NOT on the process's PATH at install time →
 *     the usual immediately-post-install state.
 *   - `NOT_INSTALLED` — neither.
 */
export function detectCli(
  provider: CliProvider,
  opts: DetectClaudeCliOptions = {},
): ClaudeCliPresence {
  const resolved = resolveCli(provider, opts);
  if (!resolved) return "NOT_INSTALLED";
  return resolved.onPath ? "INSTALLED_ON_PATH" : "INSTALLED_NOT_ON_PATH";
}

/** {@link detectCli} bound to the `claude` CLI. */
export function detectClaudeCli(opts: DetectClaudeCliOptions = {}): ClaudeCliPresence {
  return detectCli("claude", opts);
}

/** {@link detectCli} bound to the `codex` CLI. */
export function detectCodexCli(opts: DetectCodexCliOptions = {}): CodexCliPresence {
  return detectCli("codex", opts);
}

/** {@link resolveCli} bound to the `codex` CLI. Consumed by `codex-config.ts`
 *  and `codex-agent/app-server-client.ts`, which need the concrete shim path. */
export function resolveCodexCliPath(opts: DetectCodexCliOptions = {}): ResolvedCodexCli | null {
  return resolveCli("codex", opts);
}
