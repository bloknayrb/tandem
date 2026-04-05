import { readFileSync, existsSync } from "node:fs";
import { writeFile, rename, copyFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_MCP_PORT } from "../shared/constants.js";
import { SKILL_CONTENT } from "./skill-content.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to dist/channel/index.js (sibling of dist/cli/)
const CHANNEL_DIST = resolve(__dirname, "../channel/index.js");

const MCP_URL = `http://localhost:${DEFAULT_MCP_PORT}`;

export interface McpEntry {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpEntries {
  tandem: McpEntry;
  "tandem-channel": McpEntry;
}

export function buildMcpEntries(channelPath: string): McpEntries {
  return {
    tandem: {
      type: "http",
      url: `${MCP_URL}/mcp`,
    },
    "tandem-channel": {
      command: "node",
      args: [channelPath],
      env: { TANDEM_URL: MCP_URL },
    },
  };
}

export interface DetectedTarget {
  label: string;
  configPath: string;
}

interface DetectOptions {
  homeOverride?: string;
  force?: boolean;
}

export function detectTargets(opts: DetectOptions = {}): DetectedTarget[] {
  const home = opts.homeOverride ?? homedir();
  const targets: DetectedTarget[] = [];

  // Claude Code — cross-platform.
  // Detect if the config file exists OR if ~/.claude directory exists
  // (Claude Code creates ~/.claude at install; mcp_settings.json may not exist yet).
  // With --force, always include regardless.
  const claudeCodeConfig = join(home, ".claude", "mcp_settings.json");
  const claudeCodeDir = dirname(claudeCodeConfig);
  if (opts.force || existsSync(claudeCodeConfig) || existsSync(claudeCodeDir)) {
    targets.push({ label: "Claude Code", configPath: claudeCodeConfig });
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
    targets.push({ label: "Claude Desktop", configPath: desktopConfig });
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
      console.error(
        `  Warning: ${configPath} contains malformed JSON — replacing with fresh config`,
      );
    } else {
      throw err; // Permission errors, disk errors, etc. should not be silently swallowed
    }
  }

  const updated = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      ...entries,
    },
  };

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

/** Run the setup command. Writes MCP config to all detected Claude installs. */
export async function runSetup(opts: { force?: boolean } = {}): Promise<void> {
  console.error("\nTandem Setup\n");
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
  const entries = buildMcpEntries(CHANNEL_DIST);

  let failures = 0;
  for (const t of targets) {
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

  // Channel activation instructions (shown on all successful setups)
  if (failures < targets.length) {
    console.error(
      "\n\x1b[1mReal-time push notifications (optional):\x1b[0m\n" +
        "  To receive chat messages and events instantly (instead of polling),\n" +
        "  start Claude Code with the channel flag:\n\n" +
        "    claude --dangerously-load-development-channels server:tandem-channel\n\n" +
        "  Without this flag, Claude still works but relies on tandem_checkInbox polling.\n",
    );
  }
}
