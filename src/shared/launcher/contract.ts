/**
 * Wire contract for the auto-launcher routes (#477 PR 4b).
 *
 * Server: `src/server/launcher/api-routes.ts`.
 * Client: `src/client/launcher/*` (palette actions + settings picker).
 *
 * The launcher routes are HTTP-mode-only and only useful when a
 * `claude-code` integration with `apply !== "skip"` exists in
 * `integrations.json`.
 */

// --- Status ---------------------------------------------------------------

/**
 * Non-loopback callers receive the `minimal` shape only (mirrors `/health`'s
 * `hasSession` redaction pattern — `src/server/mcp/server.ts:324`). Loopback
 * callers additionally receive the `loopback` fields. `sessionId` is
 * redacted to a sentinel string even on loopback so the value never crosses
 * the API boundary (it's persisted on disk at mode 0o600 — there's no need
 * to surface it).
 */
export type LauncherStatus =
  | { available: false; reason: LauncherUnavailableReason }
  | {
      available: true;
      running: false;
      /** Last fatal error from the supervisor, scrubbed to a small enum. */
      lastError?: LauncherErrorCode;
      /** Loopback-only. `null` when last refresh succeeded. */
      skillRefresh?: SkillRefreshError | null;
    }
  | {
      available: true;
      running: true;
      reaperPid: number;
      cwd: string;
      /** Always the literal string "<set>" — the real UUID never crosses the wire. */
      sessionId: "<set>";
      resuming: boolean;
      /** Loopback-only. `null` when last refresh succeeded. */
      skillRefresh?: SkillRefreshError | null;
    };

export type LauncherUnavailableReason = "stdio-mode" | "disabled-by-env" | "spawn-failed";

/** Scrubbed `lastError` enum. Verbose error strings stay server-side. */
export type LauncherErrorCode =
  | "spawn-failed"
  | "binary-not-found"
  | "stop-failed"
  | "circuit-open"
  | "status-check-failed";

/** Loopback-only side-channel for bundled-skill refresh failures. The user
 * has no other signal that the skill is stale, so `/status` surfaces this
 * for the palette/settings UI to convert into a notification. */
export interface SkillRefreshError {
  code: "write-failed" | "read-failed";
  message: string;
}

// --- Request bodies -------------------------------------------------------

export interface LauncherRelaunchBody {
  cwd: string;
  /** Single-use nonce from `GET /api/launcher/nonce`. */
  nonce: string;
}

export interface LauncherStartFreshBody {
  /** Optional cwd override; if omitted, uses the integration's setting. */
  cwd?: string;
  nonce: string;
}

export interface LauncherWorkingDirectoryBody {
  /** Absolute path under `os.homedir()`, or `null` to clear (use default). */
  workingDirectory: string | null;
}

// --- Error codes ----------------------------------------------------------

export const LAUNCHER_ERROR_INVALID_BODY = "INVALID_BODY";
export const LAUNCHER_ERROR_INVALID_NONCE = "INVALID_NONCE";
export const LAUNCHER_ERROR_PATH_REJECTED = "PATH_REJECTED";
export const LAUNCHER_ERROR_IN_PROGRESS = "LAUNCHER_IN_PROGRESS";
export const LAUNCHER_ERROR_NOT_AVAILABLE = "LAUNCHER_NOT_AVAILABLE";
export const LAUNCHER_ERROR_NO_INTEGRATION = "NO_CLAUDE_INTEGRATION";
/** The reaper binary is missing from the install — the supervisor cannot spawn
 * Claude. Stable code so the UI can show a "reinstall Tandem" hint instead of a
 * raw filesystem path. */
export const LAUNCHER_ERROR_REAPER_NOT_FOUND = "REAPER_NOT_FOUND";

/** Marker substring the supervisor embeds in the "binary not found" throw and
 * the launcher route matches on to map it to `LAUNCHER_ERROR_REAPER_NOT_FOUND`.
 * Shared so the producer (`supervisor.ts`) and consumer (`api-routes.ts`)
 * cannot silently drift. */
export const REAPER_NOT_FOUND_MARKER = "tandem-reaper binary not found";

/** Max characters for a cwd payload — UNC paths and Windows MAX_PATH variants
 * all fit comfortably under 1024. Catches malformed/oversized inputs early
 * before they reach `realpathSync`. */
export const LAUNCHER_CWD_MAX_LENGTH = 1024;
