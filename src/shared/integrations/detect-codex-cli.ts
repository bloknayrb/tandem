import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { CodexCliPresence } from "./contract.js";

export interface DetectCodexCliOptions {
  homeOverride?: string;
  pathOverride?: string;
  platformOverride?: NodeJS.Platform;
  localAppDataOverride?: string;
}

export interface ResolvedCodexCli {
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

function codexCandidateNames(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"]
    : ["codex"];
}

/**
 * Filesystem-only Codex resolution; never executes a discovered binary.
 * Mirrors {@link detectCodexCli}'s search order but returns the concrete
 * resolved path (with its real extension) instead of a presence enum, so
 * callers can exec/spawn the exact file rather than a bare "codex" name that
 * Windows' libuv-based spawn cannot resolve through PATHEXT for `.cmd`/`.bat`
 * shims (see `codex-config.ts` / `app-server-client.ts`).
 */
export function resolveCodexCliPath(opts: DetectCodexCliOptions = {}): ResolvedCodexCli | null {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();
  const names = codexCandidateNames(platform);
  const findIn = (dir: string): string | undefined =>
    names.map((name) => join(dir, name)).find((candidate) => existsSync(candidate));

  for (const dir of (opts.pathOverride ?? process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const found = findIn(dir);
    if (found) {
      return {
        path: found,
        onPath: true,
        needsPwshInterpreter: found.toLowerCase().endsWith(".ps1"),
      };
    }
  }

  if (platform === "win32") {
    const local =
      opts.localAppDataOverride ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const found = findIn(join(local, "Programs", "OpenAI", "Codex", "bin"));
    if (found) {
      return {
        path: found,
        onPath: false,
        needsPwshInterpreter: found.toLowerCase().endsWith(".ps1"),
      };
    }
  } else {
    const found = findIn(join(home, ".local", "bin"));
    if (found) return { path: found, onPath: false, needsPwshInterpreter: false };
  }

  return null;
}

/** Filesystem-only Codex presence probe; never executes a discovered binary. */
export function detectCodexCli(opts: DetectCodexCliOptions = {}): CodexCliPresence {
  const resolved = resolveCodexCliPath(opts);
  if (!resolved) return "NOT_INSTALLED";
  return resolved.onPath ? "INSTALLED_ON_PATH" : "INSTALLED_NOT_ON_PATH";
}
