/**
 * Read existing Tandem MCP entries from the user's Claude config files.
 *
 * The integration setup wizard (#477 PR 3c) consumes this on first launch
 * to pre-populate its picker with whatever is already configured. Pre-PR-3
 * versions of Tandem wrote `mcpServers.tandem` (and optionally
 * `mcpServers.tandem-channel`) into `~/.claude.json` / the Claude Desktop
 * config silently on Tauri startup; the wizard needs to surface those
 * entries explicitly so the user is never surprised by a silent
 * "already configured" state.
 *
 * This reader is intentionally **non-mutating** — it only reads the
 * existing Claude config files via `detectTargets` from `src/cli/setup.ts`
 * and parses out the `tandem` / `tandem-channel` MCP entries if present.
 * ADR-038 §2b removal of the auto-writer is owned by PR 3c, not this
 * module.
 *
 * Error semantics mirror `src/cli/setup.ts:applyConfig` — ENOENT means
 * the user has never run that Claude variant; malformed JSON means we
 * cannot trust the file (caller decides whether to surface a recovery
 * prompt or proceed as if the entry is absent).
 */

import { readFile } from "node:fs/promises";

import {
  type DetectedTarget,
  type DetectOptions,
  detectTargets,
  type McpEntry,
} from "../../cli/setup.js";

export type ExistingConfigReadStatus = "ok" | "missing" | "malformed" | "error";

export interface ExistingMcpInstall {
  /** Which Claude install we read. */
  target: DetectedTarget;
  /** Status of reading `target.configPath`. */
  status: ExistingConfigReadStatus;
  /** Existing `mcpServers.tandem` entry, if present. */
  tandemEntry?: McpEntry;
  /** Existing `mcpServers["tandem-channel"]` entry, if present. */
  channelEntry?: McpEntry;
  /** When `status === "error"`, the underlying error message. */
  errorMessage?: string;
}

interface ClaudeConfigShape {
  mcpServers?: Record<string, unknown>;
}

/**
 * Read all detected Claude installs and surface any existing Tandem MCP
 * entries. Detection respects `DetectOptions` (test overrides for HOME /
 * LOCALAPPDATA; `force` includes targets even when their config file
 * doesn't exist yet — useful for surfacing "would write here" intent
 * during wizard dry-runs).
 */
export async function readExistingTandemEntries(
  opts: DetectOptions = {},
): Promise<ExistingMcpInstall[]> {
  const targets = detectTargets(opts);
  return Promise.all(targets.map(readOneTarget));
}

async function readOneTarget(target: DetectedTarget): Promise<ExistingMcpInstall> {
  let raw: string;
  try {
    raw = await readFile(target.configPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { target, status: "missing" };
    }
    return {
      target,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: ClaudeConfigShape;
  try {
    parsed = JSON.parse(raw) as ClaudeConfigShape;
  } catch {
    return { target, status: "malformed" };
  }

  const mcp = parsed.mcpServers;
  if (!mcp || typeof mcp !== "object") {
    return { target, status: "ok" };
  }

  return {
    target,
    status: "ok",
    tandemEntry: extractEntry(mcp, "tandem"),
    channelEntry: extractEntry(mcp, "tandem-channel"),
  };
}

function extractEntry(mcp: Record<string, unknown>, name: string): McpEntry | undefined {
  const raw = mcp[name];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as McpEntry;
}

/**
 * True iff any detected target already has a `tandem` MCP entry. The
 * wizard uses this to decide whether to show the "Tandem is already
 * configured" branch of the migration UX (ADR-038 §2b migration UX gap,
 * tracked in `docs/roadmap.md` deferred milestones).
 */
export function hasExistingTandemEntry(installs: ExistingMcpInstall[]): boolean {
  return installs.some((i) => i.tandemEntry !== undefined);
}
