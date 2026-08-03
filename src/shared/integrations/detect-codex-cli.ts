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

/** Filesystem-only Codex presence probe; never executes a discovered binary. */
export function detectCodexCli(opts: DetectCodexCliOptions = {}): CodexCliPresence {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();
  const names =
    platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"]
      : ["codex"];
  const foundIn = (dir: string): boolean => names.some((name) => existsSync(join(dir, name)));

  for (const dir of (opts.pathOverride ?? process.env.PATH ?? "").split(delimiter)) {
    if (dir && foundIn(dir)) return "INSTALLED_ON_PATH";
  }

  if (platform === "win32") {
    const local =
      opts.localAppDataOverride ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    if (foundIn(join(local, "Programs", "OpenAI", "Codex", "bin"))) {
      return "INSTALLED_NOT_ON_PATH";
    }
  } else if (foundIn(join(home, ".local", "bin"))) {
    return "INSTALLED_NOT_ON_PATH";
  }

  return "NOT_INSTALLED";
}
