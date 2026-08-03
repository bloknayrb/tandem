import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { SKILL_CONTENT } from "../../cli/skill-content.js";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import {
  type DetectCodexCliOptions,
  detectCodexCli,
} from "../../shared/integrations/detect-codex-cli.js";
import { resolveAppDataDir } from "../platform.js";
import { assertPathSafe, type DetectedTarget, type McpEntry, resolveCliVersion } from "./apply.js";
import { pruneOldBackups } from "./backup.js";
import type { ExistingMcpInstall } from "./existing-config.js";
import { atomicWriteConfigFile } from "./storage.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const BACKUP_PREFIX = "codex-config-";
const BACKUP_SUFFIX = ".toml";

export interface DetectCodexTargetsOptions extends DetectCodexCliOptions {
  force?: boolean;
  codexHomeOverride?: string;
}

export function resolveCodexHome(opts: DetectCodexTargetsOptions = {}): string {
  const home = opts.homeOverride ?? homedir();
  const configured = opts.codexHomeOverride ?? process.env.CODEX_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".codex");
}

export function detectCodexTargets(opts: DetectCodexTargetsOptions = {}): DetectedTarget[] {
  const codexHome = resolveCodexHome(opts);
  const installed = detectCodexCli(opts) !== "NOT_INSTALLED";
  if (!opts.force && !installed && !existsSync(codexHome)) return [];
  return [{ kind: "codex", label: "Codex", configPath: join(codexHome, "config.toml") }];
}

export type RunCodex = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

function minimalCodexEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "CODEX_HOME",
  ]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

const defaultRunCodex: RunCodex = async (args, options) => {
  const result = await execFileAsync("codex", args, {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function commandOptions() {
  return {
    env: minimalCodexEnv(),
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
  };
}

export async function readExistingCodexEntry(
  target: DetectedTarget,
  run: RunCodex = defaultRunCodex,
): Promise<ExistingMcpInstall> {
  try {
    const { stdout } = await run(["mcp", "get", "tandem", "--json"], commandOptions());
    const parsed = JSON.parse(stdout) as {
      transport?: { type?: string; command?: string; args?: unknown; env?: unknown };
    };
    const transport = parsed.transport;
    if (!transport || typeof transport !== "object") {
      return { target, status: "malformed" };
    }
    const tandemEntry: McpEntry = {
      ...(typeof transport.command === "string" ? { command: transport.command } : {}),
      ...(Array.isArray(transport.args) && transport.args.every((arg) => typeof arg === "string")
        ? { args: transport.args }
        : {}),
    };
    return { target, status: "ok", tandemEntry };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/no mcp server|not found|does not exist/i.test(text)) return { target, status: "ok" };
    return { target, status: "error", errorMessage: "Could not inspect Codex MCP configuration" };
  }
}

export async function applyCodexConfig(
  target: DetectedTarget,
  run: RunCodex = defaultRunCodex,
): Promise<void> {
  assertPathSafe(target.configPath);

  if (existsSync(target.configPath)) {
    const raw = await readFile(target.configPath);
    const dir = join(resolveAppDataDir(), ".backups");
    assertPathSafe(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const backupPath = join(
      dir,
      `${BACKUP_PREFIX}${Date.now()}-${crypto.randomUUID()}${BACKUP_SUFFIX}`,
    );
    await atomicWriteConfigFile(backupPath, raw.toString("utf8"));
    await pruneOldBackups(dir, BACKUP_PREFIX, BACKUP_SUFFIX, 3);
  }

  const version = resolveCliVersion();
  await run(
    [
      "mcp",
      "add",
      "tandem",
      "--env",
      `TANDEM_URL=http://127.0.0.1:${DEFAULT_MCP_PORT}`,
      "--env",
      "TANDEM_AGENT_PROVIDER=openai",
      "--",
      "npx",
      "-y",
      `tandem-editor@${version}`,
      "mcp-stdio",
    ],
    commandOptions(),
  );
}

export async function installCodexSkill(opts: { homeOverride?: string } = {}): Promise<void> {
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".agents", "skills", "tandem", "SKILL.md");
  assertPathSafe(skillPath, { allowedRoots: [home] });
  if (existsSync(skillPath)) {
    const current = await readFile(skillPath, "utf8");
    if (current === SKILL_CONTENT) return;
    if (!current.includes("<!-- tandem-owned-skill -->")) {
      throw new Error("Refusing to overwrite a non-Tandem Codex skill");
    }
  }
  await atomicWriteConfigFile(skillPath, SKILL_CONTENT);
}
