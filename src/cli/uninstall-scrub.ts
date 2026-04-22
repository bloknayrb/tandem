/**
 * Tandem `--uninstall-scrub` subcommand.
 *
 * Invoked by the Tauri NSIS installer hook during uninstall. Walks every
 * Cowork workspace under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\
 * Roaming\Claude\local-agent-mode-sessions\` and removes the Tandem plugin
 * entry from:
 *   - `installed_plugins.json` (remove `mcpServers.tandem`)
 *   - `known_marketplaces.json` (remove `marketplaces.tandem`)
 *   - `cowork_settings.json` (remove `tandem@tandem` from `enabledPlugins`)
 *
 * Then removes the `Tandem Cowork*` Windows Firewall rules via `netsh`.
 *
 * **Security invariant §10 (ADR):** this runs INSIDE the already-signed
 * `tandem.exe` binary — NOT as a separate `uninstall_scrub.exe`. That
 * prevents binary-planting attacks during uninstall.
 *
 * **Failure policy:** logs every error, exits 0 on clean-or-not-installed,
 * non-zero only on unrecoverable I/O failures. NSIS logs the exit code but
 * does NOT block uninstall — Tandem must always uninstall even if a
 * workspace scrub partially fails.
 *
 * **Token safety:** this scrub READS JSON to find Tandem entries but the
 * removed-entry contents (including the auth token) are NEVER logged.
 */

import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { assertSafeWorkspacePath } from "./win-path-guard.js";

const execFileAsync = promisify(execFile);

const TANDEM_PLUGIN_ID = "tandem";
const TANDEM_ENABLED_KEY = "tandem@tandem";
const FIREWALL_ALLOW_RULE = "Tandem Cowork";
const FIREWALL_DENY_RULE = "Tandem Cowork \u2014 Deny (elevation refused)";

type ScrubLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  close: () => Promise<void>;
};

async function openLogger(): Promise<ScrubLogger> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    // No log file — just use stderr.
    const write = (level: string, msg: string): void => {
      process.stderr.write(`[tandem uninstall-scrub ${level}] ${msg}\n`);
    };
    return {
      info: (m) => write("info", m),
      warn: (m) => write("warn", m),
      error: (m) => write("error", m),
      close: async () => {},
    };
  }

  const logDir = path.join(localAppData, "tandem", "Logs");
  await fsPromises.mkdir(logDir, { recursive: true }).catch(() => {});
  const logPath = path.join(logDir, "uninstall.log");
  const stream = await fsPromises.open(logPath, "a").catch(() => null);

  const write = (level: string, msg: string): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    process.stderr.write(line);
    if (stream) {
      stream.write(line).catch(() => {});
    }
  };

  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    close: async () => {
      if (stream) await stream.close().catch(() => {});
    },
  };
}

/**
 * Find all Cowork workspace directories.
 *
 * Matches `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
 * local-agent-mode-sessions\<ws-id>\<vm-id>\`.
 *
 * Each candidate vm-path is validated by the 4-step Windows path guard before
 * being included — callers receive only safe, realpath'd paths.
 *
 * Returns an empty array on any error (e.g. Cowork not installed).
 */
export async function findCoworkWorkspaces(logger: ScrubLogger): Promise<string[]> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    logger.info("%LOCALAPPDATA% not set — skipping workspace scan");
    return [];
  }

  // Realpath %LOCALAPPDATA% once for use by the path guard.
  let realLad: string;
  try {
    realLad = await fsPromises.realpath(localAppData);
  } catch {
    realLad = localAppData; // best-effort fallback
  }

  const packagesDir = path.join(localAppData, "Packages");
  let packageEntries: string[];
  try {
    packageEntries = await fsPromises.readdir(packagesDir);
  } catch (err) {
    logger.info(`cannot read Packages dir: ${(err as Error).message}`);
    return [];
  }

  const claudePackages = packageEntries.filter((name) => name.startsWith("Claude_"));
  if (claudePackages.length === 0) {
    logger.info("no Claude_* package directories found");
    return [];
  }

  const workspaces: string[] = [];
  for (const pkg of claudePackages) {
    const sessionsRoot = path.join(
      packagesDir,
      pkg,
      "LocalCache",
      "Roaming",
      "Claude",
      "local-agent-mode-sessions",
    );

    let wsEntries: string[];
    try {
      wsEntries = await fsPromises.readdir(sessionsRoot);
    } catch (err) {
      logger.warn(`cannot read sessions root ${sessionsRoot}: ${(err as Error).message}`);
      continue;
    }

    for (const ws of wsEntries) {
      const wsPath = path.join(sessionsRoot, ws);
      let vmEntries: string[];
      try {
        vmEntries = await fsPromises.readdir(wsPath);
      } catch (err) {
        logger.warn(`cannot read workspace dir ${wsPath}: ${(err as Error).message}`);
        continue;
      }

      for (const vm of vmEntries) {
        const vmPath = path.join(wsPath, vm);
        try {
          const stat = await fsPromises.stat(vmPath);
          if (!stat.isDirectory()) continue;

          // 4-step path guard — only include validated, realpath'd paths.
          const safePath = await assertSafeWorkspacePath(vmPath, realLad, logger);
          if (safePath !== null) {
            workspaces.push(safePath);
          }
        } catch (err) {
          logger.warn(`cannot stat ${vmPath}: ${(err as Error).message}`);
        }
      }
    }
  }

  logger.info(`found ${workspaces.length} workspace(s)`);
  return workspaces;
}

/**
 * Atomically rewrite a JSON file, invoking `mutate` on the parsed object.
 *
 * Precondition: `filePath` has already been validated by the path guard.
 * This function trusts its callers (consistent with `with_locked_json` on the Rust side).
 *
 * Returns true if the mutation changed something and was written, false if
 * the file was absent or unchanged.
 */
export async function rewriteJson(
  filePath: string,
  mutate: (obj: Record<string, unknown>) => boolean,
  logger: ScrubLogger,
): Promise<boolean> {
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    logger.warn(`cannot read ${filePath}: ${(err as Error).message}`);
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.warn(`invalid JSON in ${filePath}: ${(err as Error).message}`);
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn(`${filePath} is not a JSON object — skipping`);
    return false;
  }

  const changed = mutate(parsed as Record<string, unknown>);
  if (!changed) {
    return false;
  }

  const dir = path.dirname(filePath);
  const tmpName = `.tandem-scrub-tmp-${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    await fsPromises.writeFile(tmpPath, JSON.stringify(parsed, null, 2), "utf8");
    await fsPromises.rename(tmpPath, filePath);
  } catch (err) {
    await fsPromises.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return true;
}

/**
 * Remove the Tandem entry from `installed_plugins.json`.
 */
export function removeInstalledPlugins(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["mcpServers", "servers"]) {
    const servers = obj[key];
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
      const map = servers as Record<string, unknown>;
      if (TANDEM_PLUGIN_ID in map) {
        delete map[TANDEM_PLUGIN_ID];
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Remove the Tandem marketplace entry from `known_marketplaces.json`.
 */
export function removeKnownMarketplaces(obj: Record<string, unknown>): boolean {
  const mp = obj.marketplaces;
  if (typeof mp === "object" && mp !== null && !Array.isArray(mp)) {
    const map = mp as Record<string, unknown>;
    if (TANDEM_PLUGIN_ID in map) {
      delete map[TANDEM_PLUGIN_ID];
      return true;
    }
  }
  return false;
}

/**
 * Remove `tandem@tandem` from `enabledPlugins` in `cowork_settings.json`.
 */
export function removeCoworkSettings(obj: Record<string, unknown>): boolean {
  const enabled = obj.enabledPlugins;
  if (Array.isArray(enabled)) {
    const before = enabled.length;
    obj.enabledPlugins = enabled.filter((v) => v !== TANDEM_ENABLED_KEY);
    return (obj.enabledPlugins as unknown[]).length < before;
  }
  if (typeof enabled === "object" && enabled !== null) {
    const map = enabled as Record<string, unknown>;
    if (TANDEM_ENABLED_KEY in map) {
      delete map[TANDEM_ENABLED_KEY];
      return true;
    }
  }
  return false;
}

/**
 * Delete a Windows Firewall rule by name. Non-existent rules are not an error.
 */
async function deleteFirewallRule(name: string, logger: ScrubLogger): Promise<void> {
  try {
    await execFileAsync("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${name}`]);
    logger.info(`deleted firewall rule: ${name}`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // netsh returns exit code 1 when no rule matches — not fatal.
    const stdoutStr = e.stdout ?? "";
    if (stdoutStr.includes("No rules match")) {
      logger.info(`no firewall rule to delete: ${name}`);
      return;
    }
    logger.warn(
      `failed to delete firewall rule ${name}: ${e.message ?? String(err)} ` +
        `(stdout: ${stdoutStr.trim().slice(0, 200)})`,
    );
  }
}

/**
 * Main entry — Windows-only.
 */
export async function runUninstallScrub(): Promise<number> {
  const logger = await openLogger();

  logger.info("Tandem uninstall scrub starting");

  if (process.platform !== "win32") {
    logger.info(`platform ${process.platform} is not win32 — skipping Cowork scrub`);
    await logger.close();
    return 0;
  }

  let failures = 0;

  try {
    const workspaces = await findCoworkWorkspaces(logger);
    for (const ws of workspaces) {
      const pluginsDir = path.join(ws, "cowork_plugins");
      try {
        await rewriteJson(
          path.join(pluginsDir, "installed_plugins.json"),
          removeInstalledPlugins,
          logger,
        );
        await rewriteJson(
          path.join(pluginsDir, "known_marketplaces.json"),
          removeKnownMarketplaces,
          logger,
        );
        await rewriteJson(
          path.join(pluginsDir, "cowork_settings.json"),
          removeCoworkSettings,
          logger,
        );
      } catch (err) {
        logger.error(`scrub failed for ${ws}: ${(err as Error).message}`);
        failures++;
      }
    }

    await deleteFirewallRule(FIREWALL_ALLOW_RULE, logger);
    await deleteFirewallRule(FIREWALL_DENY_RULE, logger);

    logger.info(`scrub complete: ${workspaces.length} workspace(s), ${failures} failure(s)`);
  } catch (err) {
    logger.error(`scrub fatal error: ${(err as Error).message}`);
    failures++;
  }

  await logger.close();

  // Exit 0 on clean-or-not-installed. Non-zero only on unrecoverable failures —
  // and even then, NSIS does NOT block uninstall; it just records the code.
  return failures > 0 ? 1 : 0;
}
