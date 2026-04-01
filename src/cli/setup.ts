import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to dist/channel/index.js (sibling of dist/cli/)
const CHANNEL_DIST = resolve(__dirname, "../channel/index.js");

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
      url: "http://localhost:3479/mcp",
    },
    "tandem-channel": {
      command: "node",
      args: [channelPath],
      env: { TANDEM_URL: "http://localhost:3479" },
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

export async function detectTargets(opts: DetectOptions = {}): Promise<DetectedTarget[]> {
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
  const tmp = join(dirname(dest), `.tandem-setup-${randomUUID()}.json.tmp`);
  await writeFile(tmp, content, "utf-8");
  try {
    await rename(tmp, dest);
  } catch (err) {
    // EXDEV: cross-device link — fall back to copy + delete
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(tmp, dest);
      await unlink(tmp);
    } else {
      await unlink(tmp).catch(() => {}); // clean up temp on other errors
      throw err;
    }
  }
}

export async function applyConfig(configPath: string, entries: McpEntries): Promise<void> {
  // Read existing config or start fresh
  let existing: { mcpServers?: Record<string, McpEntry> } = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Malformed JSON — overwrite with fresh config
    }
  }

  const updated = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      ...entries,
    },
  };

  // Ensure directory exists before writing
  mkdirSync(dirname(configPath), { recursive: true });

  await atomicWrite(JSON.stringify(updated, null, 2) + "\n", configPath);
}

/** Run the setup command. Writes MCP config to all detected Claude installs. */
export async function runSetup(opts: { force?: boolean } = {}): Promise<void> {
  console.error("\nTandem Setup\n");
  console.error("Detecting Claude installations...");

  const targets = await detectTargets({ force: opts.force });

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

  for (const t of targets) {
    try {
      await applyConfig(t.configPath, entries);
      console.error(`  \x1b[32m✓\x1b[0m ${t.label}`);
    } catch (err) {
      console.error(
        `  \x1b[31m✗\x1b[0m ${t.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.error("\nSetup complete! Start Tandem with: tandem");
  console.error("Then in Claude, your tandem_* tools will be available.\n");
}
