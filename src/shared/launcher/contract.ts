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
  /** `reason` is loopback-only — see the note on `LauncherUnavailableReason`.
   * Non-loopback callers get the bare `{ available: false }`. */
  | { available: false; reason?: LauncherUnavailableReason }
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

/**
 * `deferred-autostart` (#1236): the desktop app was launched by the OS at
 * login, so the supervisor was deliberately NOT started — ADR-038 §2 grounds
 * auto-launching Claude in "the user-invoked Tandem app spawning a child
 * process", and a login launch breaks that premise. It is the one reason that
 * is *recoverable at runtime*: `POST /api/launcher/start` promotes it to a
 * live supervisor once a human shows up.
 *
 * Because it is recoverable it is also a presence oracle — it means "this
 * machine auto-booted and nobody has opened the window yet" — so
 * `GET /api/launcher/status` redacts the whole `reason` field off-loopback.
 */
export type LauncherUnavailableReason =
  | "stdio-mode"
  | "disabled-by-env"
  | "spawn-failed"
  | "deferred-autostart";

/**
 * True when `available: false` is a *transient phase* the launcher will leave on
 * its own, rather than a terminal explanation.
 *
 * Every other reason means "this runtime will never have a launcher"; only
 * `deferred-autostart` resolves without the user changing anything. The UI must
 * not offer a fix-it CTA for a state that fixes itself — a fully-configured user
 * who booted hidden would otherwise be told to re-run the integration wizard.
 *
 * A predicate rather than an inline comparison because two independent client
 * surfaces need the same answer, and because it is the seam that makes the enum
 * extensible: a second resumable reason updates one function, not N call sites.
 *
 * `undefined` (the off-loopback redacted shape) is deliberately NOT transient —
 * a LAN viewer cannot act on the deferral, so treating it as terminal is right.
 */
export function isTransientlyUnavailable(reason: LauncherUnavailableReason | undefined): boolean {
  return reason === "deferred-autostart";
}

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

// --- Claude CLI stream-json wire contract ---------------------------------

/**
 * Flag prefix the supervisor passes to `claude`, ahead of the
 * session-selection flag (`--session-id` / `--resume`).
 *
 * `-p` + the two `stream-json` formats put the CLI in headless streaming mode:
 * it emits one JSON object per line on stdout and reads user turns as one JSON
 * object per line on stdin. `--verbose` is what makes the CLI emit the
 * `{"type":"system","subtype":"init"}` handshake line the supervisor waits for
 * before writing its bootstrap turn — without it there is no signal that stdin
 * is ready, and the turn is written into a process that never reads it.
 *
 * Lives here (not in `supervisor.ts`) because the spawn path and the stub-CLI
 * test harness must agree on it byte-for-byte; a drift between them would make
 * the harness green while the shipped launcher spoke a different protocol.
 */
export const CLAUDE_STREAM_JSON_FLAGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-load-development-channels",
  "server:tandem-channel",
];

/** The bootstrap turn the supervisor writes after the CLI's `init` line. Only
 * sent on a *fresh* spawn — a resumed session already carries its own history,
 * so re-sending would inject a duplicate turn into the conversation. */
export const SUPERVISOR_INITIAL_PROMPT =
  "A document has been opened in Tandem for review. " +
  "Call tandem_checkInbox to see what needs attention, then begin reviewing.";

/** One `stream-json` user turn as the Claude CLI accepts it on stdin. */
export interface StreamJsonUserTurn {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
}

/** Build a `stream-json` user-turn envelope. Single definition so the writer
 * (`supervisor.ts`) and the harness that asserts on the received bytes can
 * never drift apart. */
export function buildUserTurn(text: string): StreamJsonUserTurn {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

/** Serialized form written to the CLI's stdin — one JSON object, newline
 * terminated. The newline is the frame delimiter, not cosmetic. */
export function serializeUserTurn(text: string): string {
  return `${JSON.stringify(buildUserTurn(text))}\n`;
}
