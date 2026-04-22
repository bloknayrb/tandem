import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MCP_PORT } from "../shared/constants.js";
import { SKILL_CONTENT } from "./skill-content.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths are anchored to the package root (dist/cli/ resolves up two levels).
const PACKAGE_ROOT = resolve(__dirname, "../..");
const CHANNEL_DIST = resolve(PACKAGE_ROOT, "dist/channel/index.js");

const MCP_URL = `http://localhost:${DEFAULT_MCP_PORT}`;

export interface McpEntry {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpEntries {
  tandem: McpEntry;
  "tandem-channel"?: McpEntry;
}

export interface BuildMcpEntriesOptions {
  /** Include the legacy stdio channel shim. Defaults to false — the plugin
   *  monitor handles event push for modern installs. Users on older setups
   *  can run `tandem setup --with-channel-shim` to preserve the shim. */
  withChannelShim?: boolean;
  nodeBinary?: string;
  /** Auth token to embed in HTTP entry headers and stdio shim env.
   *  When omitted (first-run before token provisioned), headers/env are omitted
   *  and backward compatibility is preserved. */
  token?: string;
  /** Target kind controls entry shape. Claude Code uses HTTP (direct);
   *  Claude Desktop uses stdio (npx bridge) because Cowork sessions can
   *  only surface stdio MCP servers. */
  targetKind?: TargetKind;
}

export function buildMcpEntries(
  channelPath: string,
  opts: BuildMcpEntriesOptions = {},
): McpEntries {
  const isDesktop = opts.targetKind === "claude-desktop";

  let tandemEntry: McpEntry;
  if (isDesktop) {
    const env: Record<string, string> = { TANDEM_URL: MCP_URL };
    if (opts.token) {
      env.TANDEM_AUTH_TOKEN = opts.token;
    }
    tandemEntry = {
      command: "npx",
      args: ["-y", "tandem-editor", "mcp-stdio"],
      env,
    };
  } else {
    tandemEntry = { type: "http", url: `${MCP_URL}/mcp` };
    if (opts.token) {
      tandemEntry.headers = { Authorization: `Bearer ${opts.token}` };
    }
  }
  const entries: McpEntries = { tandem: tandemEntry };

  if (opts.withChannelShim) {
    const shimEnv: Record<string, string> = { TANDEM_URL: MCP_URL };
    if (opts.token) {
      shimEnv.TANDEM_AUTH_TOKEN = opts.token;
    }
    entries["tandem-channel"] = {
      command: opts.nodeBinary ?? "node",
      args: [channelPath],
      env: shimEnv,
    };
  }
  return entries;
}

export type TargetKind = "claude-code" | "claude-desktop";

export interface DetectedTarget {
  label: string;
  configPath: string;
  kind: TargetKind;
}

export interface DetectOptions {
  homeOverride?: string;
  localAppDataOverride?: string;
  force?: boolean;
}

export function detectTargets(opts: DetectOptions = {}): DetectedTarget[] {
  const home = opts.homeOverride ?? homedir();
  const targets: DetectedTarget[] = [];

  // Claude Code — cross-platform.
  // MCP servers are configured in ~/.claude.json under the "mcpServers" key.
  // Detect if the file exists OR if ~/.claude directory exists (Claude Code is installed).
  // With --force, always include regardless.
  const claudeCodeConfig = join(home, ".claude.json");
  const claudeCodeDir = join(home, ".claude");
  if (opts.force || existsSync(claudeCodeConfig) || existsSync(claudeCodeDir)) {
    targets.push({ label: "Claude Code", configPath: claudeCodeConfig, kind: "claude-code" });
  }

  // Claude Desktop — platform-specific.
  // Only detect if the config file already exists (user has launched Desktop at least once).
  // With --force, always include.
  let desktopConfig: string | null = null;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    desktopConfig = join(appdata, "Claude", "claude_desktop_config.json");
  } else if (process.platform === "darwin") {
    desktopConfig = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  } else {
    desktopConfig = join(home, ".config", "claude", "claude_desktop_config.json");
  }

  if (desktopConfig && (opts.force || existsSync(desktopConfig))) {
    targets.push({ label: "Claude Desktop", configPath: desktopConfig, kind: "claude-desktop" });
  }

  // Claude Desktop (MSIX) — Windows only.
  // MSIX-packaged installs (Microsoft Store) redirect %APPDATA% to a per-package
  // LocalCache dir. The config lives under %LOCALAPPDATA%\Packages\Claude_*\
  // LocalCache\Roaming\Claude\. Multiple package families may exist.
  if (process.platform === "win32") {
    const localAppData =
      opts.localAppDataOverride ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const packagesDir = join(localAppData, "Packages");
    try {
      const entries = readdirSync(packagesDir);
      for (const pkg of entries.filter((n) => n.startsWith("Claude_"))) {
        const msixConfig = join(
          packagesDir,
          pkg,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude_desktop_config.json",
        );
        if (opts.force || existsSync(msixConfig)) {
          const suffix =
            entries.filter((n) => n.startsWith("Claude_")).length > 1
              ? ` (${pkg.slice(0, 12)}…)`
              : "";
          targets.push({
            label: `Claude Desktop MSIX${suffix}`,
            configPath: msixConfig,
            kind: "claude-desktop",
          });
        }
      }
    } catch {
      // %LOCALAPPDATA%\Packages doesn't exist or isn't readable — not an MSIX install
    }
  }

  return targets;
}

/**
 * Atomic write: write to a temp file in the SAME directory as the destination,
 * then rename. Using the same directory avoids EXDEV errors on Windows when
 * %TEMP% and %APPDATA% are on different drives.
 */
async function atomicWrite(content: string, dest: string): Promise<void> {
  const tmp = join(dirname(dest), `.tandem-setup-${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf-8");
  try {
    await rename(tmp, dest);
  } catch (err) {
    // EXDEV: cross-device link — fall back to copy + delete
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(tmp, dest);
      await unlink(tmp).catch((cleanupErr: Error) => {
        console.error(`  Warning: could not remove temp file ${tmp}: ${cleanupErr.message}`);
      });
    } else {
      await unlink(tmp).catch((cleanupErr: Error) => {
        console.error(`  Warning: could not remove temp file ${tmp}: ${cleanupErr.message}`);
      });
      throw err;
    }
  }
}

export async function applyConfig(configPath: string, entries: McpEntries): Promise<void> {
  // Read existing config or start fresh — no existsSync guard needed.
  // ENOENT and malformed JSON start fresh; other errors (permissions, disk) propagate.
  let existing: { mcpServers?: Record<string, McpEntry> } = {};
  try {
    existing = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File doesn't exist yet — start fresh
    } else if (err instanceof SyntaxError) {
      // Don't silently wipe the user's other mcpServers. Copy the malformed
      // file to a .broken-<ts> sibling first so they can recover it. If the
      // backup itself fails, refuse to overwrite — runSetup's per-target
      // try/catch reports the partial failure.
      const backupPath = `${configPath}.broken-${Date.now()}`;
      try {
        await copyFile(configPath, backupPath);
        console.error(
          `  Warning: ${configPath} contains malformed JSON — backed up to ${basename(backupPath)}, replacing with fresh config`,
        );
      } catch (copyErr) {
        console.error(
          `  Warning: ${configPath} contains malformed JSON and backup failed (${
            copyErr instanceof Error ? copyErr.message : copyErr
          }) — refusing to overwrite. Fix the JSON manually and rerun 'tandem setup'.`,
        );
        throw copyErr;
      }
    } else {
      throw err; // Permission errors, disk errors, etc. should not be silently swallowed
    }
  }

  const merged = {
    ...(existing.mcpServers ?? {}),
    ...entries,
  };
  // Remove stale tandem-channel entry left by older Tauri installers.
  // The channel shim is Claude Code-only; Cowork can't use it.
  if (!entries["tandem-channel"]) {
    if (merged["tandem-channel"]) {
      console.error(
        `  Warning: removed stale tandem-channel entry from ${configPath} (legacy Tauri install artifact)`,
      );
    }
    delete merged["tandem-channel"];
  }
  const updated = { ...existing, mcpServers: merged };

  await mkdir(dirname(configPath), { recursive: true });
  await atomicWrite(JSON.stringify(updated, null, 2) + "\n", configPath);
}

/**
 * Install the Tandem skill to ~/.claude/skills/tandem/SKILL.md.
 * Claude Code auto-discovers skills in this directory and uses the description
 * field to trigger them when tandem_* tools are present.
 */
export async function installSkill(opts: { homeOverride?: string } = {}): Promise<void> {
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".claude", "skills", "tandem", "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await atomicWrite(SKILL_CONTENT, skillPath);
}

/**
 * Returns true if the channel-shim build artifact exists at the given path.
 * Exported so the prereq check can be tested without spawning runSetup.
 */
export function validateChannelShimPrereq(channelPath: string): boolean {
  return existsSync(channelPath);
}

/**
 * Write the given token into all detected Claude MCP config files.
 * Returns the number of configs successfully updated and any per-target errors.
 */
export async function applyConfigWithToken(
  token: string | null,
  opts: { force?: boolean; withChannelShim?: boolean } = {},
): Promise<{ updated: number; errors: string[] }> {
  const targets = detectTargets({ force: opts.force });

  let updated = 0;
  const errors: string[] = [];
  for (const t of targets) {
    const entries = buildMcpEntries(CHANNEL_DIST, {
      withChannelShim: opts.withChannelShim,
      token: token ?? undefined,
      targetKind: t.kind,
    });
    try {
      await applyConfig(t.configPath, entries);
      updated++;
    } catch (err) {
      errors.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { updated, errors };
}

/** Run the setup command. Writes MCP config to all detected Claude installs. */
export async function runSetup(
  opts: { force?: boolean; withChannelShim?: boolean } = {},
): Promise<void> {
  console.error("\nTandem Setup\n");

  if (opts.withChannelShim && !validateChannelShimPrereq(CHANNEL_DIST)) {
    console.error(
      `Error: --with-channel-shim requires dist/channel/index.js at ${CHANNEL_DIST}\n` +
        `Run 'npm run build' first, or drop --with-channel-shim to use the plugin monitor.`,
    );
    process.exit(1);
  }

  console.error("Detecting Claude installations...");

  const targets = detectTargets({ force: opts.force });

  if (targets.length === 0) {
    console.error(
      "  No Claude installations detected.\n" +
        "  If Claude Code is installed, ensure ~/.claude exists.\n" +
        "  You can force configuration to default paths with: tandem setup --force",
    );
    return;
  }

  for (const t of targets) {
    console.error(`  Found: ${t.label} (${t.configPath})`);
  }

  console.error("\nWriting MCP configuration...");

  let failures = 0;
  for (const t of targets) {
    const entries = buildMcpEntries(CHANNEL_DIST, {
      withChannelShim: opts.withChannelShim,
      targetKind: t.kind,
    });
    try {
      await applyConfig(t.configPath, entries);
      console.error(`  \x1b[32m✓\x1b[0m ${t.label}`);
    } catch (err) {
      failures++;
      console.error(
        `  \x1b[31m✗\x1b[0m ${t.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failures === targets.length) {
    console.error("\nSetup failed — could not write any configuration. Check file permissions.");
    process.exit(1);
  } else if (failures > 0) {
    console.error(
      `\nSetup partially complete (${failures} target(s) failed). Start Tandem with: tandem`,
    );
  } else {
    console.error("\nSetup complete! Start Tandem with: tandem");
    console.error("Then in Claude, your tandem_* tools will be available.");
  }

  // Install Claude Code skill (best-effort — doesn't block MCP setup)
  console.error("\nInstalling Claude Code skill...");
  try {
    await installSkill();
    console.error("  \x1b[32m✓\x1b[0m ~/.claude/skills/tandem/SKILL.md");
  } catch (err) {
    console.error(
      `  \x1b[33m⚠\x1b[0m Could not install skill: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Plugin install instructions (shown on all successful setups)
  if (failures < targets.length) {
    const pluginManifest = join(PACKAGE_ROOT, ".claude-plugin", "plugin.json");
    const devInstructions = existsSync(pluginManifest)
      ? `  Or for development, load directly from this package:\n\n` +
        `    claude --plugin-dir ${PACKAGE_ROOT}\n\n`
      : `  (Development plugin dir not found at ${pluginManifest}; skipping local-plugin instructions.)\n\n`;

    console.error(
      "\n\x1b[1mReal-time push notifications (recommended):\x1b[0m\n" +
        "  Install the Tandem plugin for instant events (one-time):\n\n" +
        "    claude plugin marketplace add bloknayrb/tandem\n" +
        "    claude plugin install tandem@tandem-editor\n\n" +
        devInstructions +
        "  Without the plugin, Claude still works but relies on tandem_checkInbox polling.\n",
    );
  }
}
