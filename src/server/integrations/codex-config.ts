import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { SKILL_CONTENT } from "../../cli/skill-content.js";
import { codexChildEnv } from "../../shared/codex/env.js";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import {
  type DetectCodexCliOptions,
  detectCodexCli,
  type ResolvedCodexCli,
  resolveCodexCliPath,
} from "../../shared/integrations/detect-claude-cli.js";
import { resolveAppDataDir } from "../platform.js";
import { assertPathSafe, type DetectedTarget, type McpEntry, resolveCliVersion } from "./apply.js";
import { pruneOldBackups, writeBackup } from "./backup.js";
import type { ExistingMcpInstall } from "./existing-config.js";
import { atomicWriteConfigFile } from "./storage.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const BACKUP_PREFIX = "codex-config-";
const BACKUP_SUFFIX = ".toml";
/** Matches `backup.ts`'s MAX_BACKUPS — kept explicit because the prefix differs. */
const MAX_CODEX_BACKUPS = 3;

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

/**
 * Build the exec plan for a resolved Codex CLI. `.ps1` shims (the only kind
 * that isn't directly exec-able) need an explicit PowerShell interpreter,
 * invoked argv-only — mirrors `buildExecPlan` in `install-claude-cli.ts`.
 */
function buildCodexExecPlan(
  resolved: ResolvedCodexCli,
  args: string[],
): { command: string; args: string[] } {
  if (resolved.needsPwshInterpreter) {
    return {
      command: "pwsh.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved.path, ...args],
    };
  }
  return { command: resolved.path, args };
}

const defaultRunCodex: RunCodex = async (args, options) => {
  // Resolve the concrete shim path rather than passing a bare "codex" name:
  // Windows' libuv-based spawn doesn't apply PATHEXT resolution for a bare
  // name, so an npm-installed codex.cmd/.ps1 shim would ENOENT. Resolving
  // absolutely also closes a binary-planting hazard — execFile with a bare
  // name searches `cwd` (the user's workspace) before `%PATH%` on Windows.
  // If resolution comes up empty, fall back to the bare name so the
  // not-installed case still surfaces Node's own ENOENT the same way it
  // always has — this fix targets the installed-but-shimmed case, not
  // "codex isn't installed at all".
  const resolved = resolveCodexCliPath();
  const plan = resolved ? buildCodexExecPlan(resolved, args) : { command: "codex", args };
  const result = await execFileAsync(plan.command, plan.args, {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function commandOptions() {
  return {
    env: codexChildEnv(),
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
  };
}

/**
 * `codex mcp get tandem --json` exits non-zero both when the entry genuinely
 * isn't configured and when something actually went wrong. The only signal
 * that distinguishes them is Codex's own "no such server" wording, so match it
 * narrowly and **only against stderr** — the previous check ran a loose
 * substring test (`not found` / `does not exist`) over the whole Error
 * message, which includes the command line and stdout. Any unrelated failure
 * whose output happened to contain "not found" (a missing interpreter, a
 * config parse error naming an absent file) was silently reported as
 * "Tandem is not configured", which makes the wizard offer a clean install
 * over a broken one.
 */
const CODEX_NO_SUCH_SERVER_RE =
  /\bno\b[^\n]{0,40}\bmcp server\b|\bmcp server\b[^\n]{0,40}\bnot found\b/i;

export async function readExistingCodexEntry(
  target: DetectedTarget,
  run: RunCodex = defaultRunCodex,
): Promise<ExistingMcpInstall> {
  let stdout: string;
  try {
    ({ stdout } = await run(["mcp", "get", "tandem", "--json"], commandOptions()));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: unknown };
    // A non-numeric `code` means the process never ran (ENOENT for a missing
    // `codex`, EACCES for a blocked one). That is not an answer about whether
    // the entry exists, so it must not be reported as "ok, nothing there".
    const ranAndFailed = typeof e.code === "number";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    if (ranAndFailed && CODEX_NO_SUCH_SERVER_RE.test(stderr)) {
      return { target, status: "ok" };
    }
    return { target, status: "error", errorMessage: "Could not inspect Codex MCP configuration" };
  }

  let parsed: { transport?: { type?: string; command?: string; args?: unknown; env?: unknown } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    // `--json` produced something that isn't JSON: this is the one case that
    // genuinely mirrors the Claude reader's `malformed` (there, an unparseable
    // ~/.claude.json). It used to fall into the catch above and get
    // substring-classified instead.
    return { target, status: "malformed" };
  }

  const transport = parsed.transport;
  if (!transport || typeof transport !== "object") {
    // The command SUCCEEDED, so an entry named `tandem` exists — we just can't
    // read its transport. Surfacing `malformed` here was a misroute: that
    // status means "the config file could not be parsed" and drives a
    // corrupt-config recovery prompt, which is a lie about a file that parsed
    // fine. Surface an empty entry instead, exactly as the Claude reader does
    // for an unrecognized `mcpServers.tandem` shape: `validateTandemEntry`
    // marks it `invalid-shape`, so the wizard shows it and pre-sets
    // `apply: "skip"` rather than silently overwriting it.
    return { target, status: "ok", tandemEntry: {} };
  }
  const tandemEntry: McpEntry = {
    ...(typeof transport.command === "string" ? { command: transport.command } : {}),
    ...(Array.isArray(transport.args) && transport.args.every((arg) => typeof arg === "string")
      ? { args: transport.args }
      : {}),
  };
  return { target, status: "ok", tandemEntry };
}

export async function applyCodexConfig(
  target: DetectedTarget,
  run: RunCodex = defaultRunCodex,
): Promise<void> {
  assertPathSafe(target.configPath);

  // Backup BEFORE the destination write, and through `backup.ts` rather than a
  // hand-rolled copy: `writeBackup` is exclusive-create (`wx`, defeating a
  // pre-planted symlink at a predictable path), applies the restrictive
  // Windows ACL, and is all-or-nothing — a partial write is removed and the
  // throw aborts us before `codex mcp add` touches config.toml. The previous
  // hand-rolled path used `atomicWriteConfigFile`, which would leave a
  // truncated backup in place on a mid-write failure.
  if (existsSync(target.configPath)) {
    const raw = await readFile(target.configPath);
    const dir = join(resolveAppDataDir(), ".backups");
    assertPathSafe(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeBackup(dir, raw, BACKUP_PREFIX, BACKUP_SUFFIX);
    await pruneOldBackups(dir, BACKUP_PREFIX, BACKUP_SUFFIX, MAX_CODEX_BACKUPS);
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

/**
 * Ownership marker for the Codex skill (ADR-047 §2).
 *
 * `~/.agents/skills/` is a cross-tool convention, not Tandem's private
 * directory, so a user can legitimately have their own skill named `tandem`
 * there — unlike `~/.claude/skills/`, which `installSkill` overwrites without
 * asking. The marker is what tells the two apart.
 */
const CODEX_SKILL_OWNERSHIP_MARKER = "<!-- tandem-owned-skill -->";

/**
 * What Tandem actually writes: the bundled skill plus the marker.
 *
 * The marker used to be CHECKED but never WRITTEN, which made the guard
 * self-defeating: the first install left unmarked content on disk, and the
 * next time `SKILL_CONTENT` changed — i.e. every release that touches
 * `skills/tandem/SKILL.md` — the equality fast-path missed and the guard threw
 * "Refusing to overwrite a non-Tandem Codex skill" **against Tandem's own
 * file**. Codex users could never receive a skill update, and the error blamed
 * them for a file Tandem wrote. Exported so tests assert against the same
 * string rather than reconstructing it.
 *
 * A trailing HTML comment is inert in Markdown and sits outside the front
 * matter, so it changes nothing about how Codex reads the skill.
 */
export const CODEX_SKILL_CONTENT = `${SKILL_CONTENT.trimEnd()}\n\n${CODEX_SKILL_OWNERSHIP_MARKER}\n`;

/**
 * Is this file one Tandem wrote? The marker is the durable signal; exact
 * equality with the unstamped bundled skill is the transition case — that
 * content is unmistakably ours (it IS the bundled skill, byte for byte), it is
 * what the pre-fix code left behind, and refusing to upgrade it would
 * reintroduce the bug for anyone who ran the unreleased version.
 */
function isTandemOwnedSkill(current: string): boolean {
  return current.includes(CODEX_SKILL_OWNERSHIP_MARKER) || current === SKILL_CONTENT;
}

export async function installCodexSkill(opts: { homeOverride?: string } = {}): Promise<void> {
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".agents", "skills", "tandem", "SKILL.md");
  assertPathSafe(skillPath, { allowedRoots: [home] });
  if (existsSync(skillPath)) {
    const current = await readFile(skillPath, "utf8");
    if (current === CODEX_SKILL_CONTENT) return;
    if (!isTandemOwnedSkill(current)) {
      throw new Error("Refusing to overwrite a non-Tandem Codex skill");
    }
  }
  await atomicWriteConfigFile(skillPath, CODEX_SKILL_CONTENT);
}
