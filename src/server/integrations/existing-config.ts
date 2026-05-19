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
 * existing Claude config files via `detectTargets` from `./apply.ts`
 * and parses out the `tandem` / `tandem-channel` MCP entries if present.
 * ADR-038 §2b removal of the auto-writer is owned by PR 3c, not this
 * module.
 *
 * **PR 3c-ii-b re-validation:** each surfaced entry is validated against
 * the canonical shapes `buildMcpEntries` produces:
 * - HTTP `tandem` entries must pass `LoopbackUrl.safeParse(url)` — this
 *   rejects credential-bearing URLs (`http://evil.com@127.0.0.1`), IPv6
 *   loopback, decimal/hex IP obfuscation, NFC/NFD homoglyphs, etc. Any
 *   non-loopback URL means a third party has hijacked the entry.
 * - stdio `tandem` entries must be `npx -y tandem-editor mcp-stdio`
 *   tuple-equality. `command: "npx" + args: ["-y", "evil-package"]`
 *   fails.
 * - stdio `tandem-channel` entries must invoke a Node-shaped binary
 *   (`isValidNodeBinary`) with a `.js` first arg.
 *
 * Invalid entries are still surfaced (so the user can see what's on
 * disk), but with `validationStatus !== "valid"` so the wizard
 * pre-selects `apply: "skip"` instead of trusting them.
 *
 * Error semantics mirror `src/server/integrations/apply.ts:applyConfig` — ENOENT means
 * the user has never run that Claude variant; malformed JSON means we
 * cannot trust the file (caller decides whether to surface a recovery
 * prompt or proceed as if the entry is absent).
 */

import { readFile } from "node:fs/promises";

import { isValidNodeBinary } from "../mcp/routes/_shared.js";
import { type DetectedTarget, type DetectOptions, detectTargets, type McpEntry } from "./apply.js";
import { LoopbackUrl } from "./schema.js";

export type ExistingConfigReadStatus = "ok" | "missing" | "malformed" | "error";

/**
 * Entry-validation outcome. `"valid"` means the entry matches one of the
 * canonical shapes `buildMcpEntries` produces and is safe to keep / build
 * an `apply: "create"` decision on. `"invalid-*"` outcomes indicate a
 * possible tamper or hand-edit — the wizard surfaces the entry but pre-
 * sets `apply: "skip"`.
 */
export type EntryValidationStatus =
  | "valid"
  | "invalid-shape"
  | "invalid-url"
  | "invalid-command"
  | "invalid-args";

export interface EntryValidation {
  status: EntryValidationStatus;
  /** Human-readable reason, suitable for surfacing in the wizard's warning UI. */
  reason?: string;
}

export interface ExistingMcpInstall {
  /** Which Claude install we read. */
  target: DetectedTarget;
  /** Status of reading `target.configPath`. */
  status: ExistingConfigReadStatus;
  /** Existing `mcpServers.tandem` entry, if present. */
  tandemEntry?: McpEntry;
  /** Validation result for `tandemEntry` (always present when entry is). */
  tandemValidation?: EntryValidation;
  /** Existing `mcpServers["tandem-channel"]` entry, if present. */
  channelEntry?: McpEntry;
  /** Validation result for `channelEntry` (always present when entry is). */
  channelValidation?: EntryValidation;
  /** When `status === "error"`, the underlying error message. */
  errorMessage?: string;
}

/** Canonical `args` for the npx-launched stdio tandem entry (claude-desktop). */
const TANDEM_STDIO_NPX_ARGS = ["-y", "tandem-editor", "mcp-stdio"] as const;

/**
 * Validate an existing `tandem` mcpServers entry against the canonical
 * shapes `buildMcpEntries` produces. HTTP entries must be loopback (via
 * the same Zod schema that gates new entries); stdio entries must be
 * either the canonical `npx -y tandem-editor mcp-stdio` tuple, or a
 * Node-shaped command (for legacy sidecar invocations from older Tauri
 * builds).
 */
export function validateTandemEntry(entry: McpEntry): EntryValidation {
  // HTTP variant: { type: "http", url: "http://127.0.0.1:..." }
  if (entry.type === "http" || typeof entry.url === "string") {
    if (typeof entry.url !== "string" || entry.url.length === 0) {
      return { status: "invalid-shape", reason: "HTTP entry missing url" };
    }
    const parsed = LoopbackUrl.safeParse(entry.url);
    if (!parsed.success) {
      return { status: "invalid-url", reason: `url must be loopback http; got ${entry.url}` };
    }
    return { status: "valid" };
  }

  // stdio variants: command + args tuple equality
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    return { status: "invalid-shape", reason: "stdio entry missing command" };
  }
  const args = Array.isArray(entry.args) ? entry.args : [];

  // Canonical: npx -y tandem-editor mcp-stdio
  if (entry.command === "npx") {
    const argsOk =
      args.length === TANDEM_STDIO_NPX_ARGS.length &&
      TANDEM_STDIO_NPX_ARGS.every((expected, i) => args[i] === expected);
    if (!argsOk) {
      return {
        status: "invalid-args",
        reason: `npx args must be ${JSON.stringify(TANDEM_STDIO_NPX_ARGS)}; got ${JSON.stringify(args)}`,
      };
    }
    return { status: "valid" };
  }

  // Legacy sidecar invocation: node-shaped binary + a .js path arg.
  if (isValidNodeBinary(entry.command)) {
    if (args.length !== 1 || typeof args[0] !== "string" || !args[0].endsWith(".js")) {
      return {
        status: "invalid-args",
        reason: "node-shaped stdio entry must take exactly one .js arg",
      };
    }
    return { status: "valid" };
  }

  return {
    status: "invalid-command",
    reason: `command must be 'npx' or a Node-shaped binary; got '${entry.command}'`,
  };
}

/**
 * Validate an existing `tandem-channel` mcpServers entry. The shim is
 * always Node-shaped + single `.js` arg. HTTP isn't a valid channel
 * transport — the channel sidecar speaks JSON-RPC over stdio.
 */
export function validateChannelEntry(entry: McpEntry): EntryValidation {
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    return { status: "invalid-shape", reason: "channel entry missing command" };
  }
  if (!isValidNodeBinary(entry.command)) {
    return {
      status: "invalid-command",
      reason: `tandem-channel command must be Node-shaped; got '${entry.command}'`,
    };
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args.length !== 1 || typeof args[0] !== "string" || !args[0].endsWith(".js")) {
    return {
      status: "invalid-args",
      reason: "tandem-channel must take exactly one .js arg",
    };
  }
  return { status: "valid" };
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

  const tandemEntry = extractEntry(mcp, "tandem");
  const channelEntry = extractEntry(mcp, "tandem-channel");
  return {
    target,
    status: "ok",
    tandemEntry,
    tandemValidation: tandemEntry ? validateTandemEntry(tandemEntry) : undefined,
    channelEntry,
    channelValidation: channelEntry ? validateChannelEntry(channelEntry) : undefined,
  };
}

function extractEntry(mcp: Record<string, unknown>, name: string): McpEntry | undefined {
  const raw = mcp[name];
  if (!raw || typeof raw !== "object") return undefined;
  // The object-shape guard rejects primitives and null, but does not validate
  // the McpEntry field types (e.g. a `command: null` would pass through). PR
  // 3c's wizard consumer MUST re-validate shape before trusting any field —
  // the cast here is "yes, this is something we extracted from mcpServers,"
  // not "this is a valid McpEntry."
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
