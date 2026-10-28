/**
 * Wire contract for the auto-launcher routes (#477 PR 4b).
 *
 * Server: `src/server/launcher/api-routes.ts`.
 * Client: `src/client/hooks/useAiReadiness.svelte.ts` (status), the launcher
 * actions in `src/client/actions/builtin.svelte.ts`, and the AI Assistant
 * settings tab.
 *
 * The launcher routes are HTTP-mode-only and only useful when a
 * `claude-code` integration with `apply !== "skip"` exists in
 * `integrations.json`. Without one, status reports `available: false` with
 * reason `not-configured` (#2180).
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
  | {
      available: false;
      reason?: LauncherUnavailableReason;
      /** Loopback-only. Present when the pre-readiness skill refresh failed. */
      skillRefresh?: SkillRefreshError;
    }
  | {
      available: true;
      running: false;
      /** Last fatal error from the supervisor, scrubbed to a small enum. */
      lastError?: LauncherErrorCode;
      /** Loopback-only. Tandem is already bringing its Claude back (a restart
       * is scheduled, a start or relaunch is running, or a killed child's exit
       * is on its way), so the client shows "Restarting Claude…" rather than
       * a Restart button that would race it (#2180). Absent from an older
       * server, which reads as today's behaviour. */
      restartPending?: true;
      /** Loopback-only. Tandem's Claude is not running BY CHOICE (#2195): the
       * start mode is off, it is waiting for the user's Start, or it was
       * stopped while idle. Never sent beside a `lastError` (a stop that
       * failed is a diagnosis, not a choice). Beside `restartPending` it means
       * a Start from standby is under way — "Starting", not "Restarting".
       * Absent from an older server. */
      standby?: LauncherStandby;
      /** Loopback-only, and only beside `standby` (#2196): a chat message sent
       * now would start Tandem's Claude — no other AI session is attached and
       * the licence admits it. What the chat panel's "Claude is resuming…"
       * promise keys on, so it is never shown for a message nothing will
       * answer. Absent from an older server. */
      startsOnMessage?: true;
      /** Loopback-only (#2197): see the running arm's `greetingLate`. Here too,
       * because the commonest reason the hello never comes — Claude Code not
       * signed in — stops the child. */
      greetingLate?: true;
      /** Loopback-only (#1822 item 4a): see the running arm. */
      workingDirectoryIgnored?: WorkingDirectoryIgnored;
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
      /** Loopback-only. Tandem's Claude has a turn in flight — see
       * `SupervisorStatus.busy`. Optional because an older server omits it,
       * which reads as not busy. */
      busy?: boolean;
      /** Loopback-only. The server matched a live MCP connection to THIS
       * spawn of Tandem's Claude (its session id, opened since the spawn, with
       * its stream open). Only reachable when the child's connection forwards
       * its Claude session id (the plugin's stdio bridge); absent or false
       * means "can't confirm", not "not connected". */
      attached?: boolean;
      /** Loopback-only (#2197). Tandem's Claude was asked for its one-time
       * greeting and has not written to the chat: its turn ended without a
       * message, or a minute passed (`GREETING_REPLY_WINDOW_MS`). The chat
       * panel shows how to fix it. Decided server-side, so neither a cleared
       * chat nor the client's clock can fake it. */
      greetingLate?: true;
      /** Loopback-only (#1822 item 4a). The LAST spawn did not use the saved
       * `workingDirectory` and ran in home instead. Absent when it did, when
       * none is saved, and from an older server. See
       * `WorkingDirectoryIgnored`. */
      workingDirectoryIgnored?: WorkingDirectoryIgnored;
      /** Loopback-only. `null` when last refresh succeeded. */
      skillRefresh?: SkillRefreshError | null;
    };

/**
 * The saved `workingDirectory` the last spawn refused, and why (#1822 item
 * 4a). The launcher home-confines it like the HTTP routes do, and falls back
 * to home rather than failing the launch.
 *
 * `workingDirectory` is the saved value exactly as `integrations.json` holds it,
 * so Settings shows its warning only while the folder it has loaded IS that
 * value. A bare "the last spawn ignored it" flag could not tell a stale verdict
 * from a current one: after the user saved a valid folder, a remount re-read
 * the flag and brought the warning back for a folder that was fine.
 *
 * Loopback-only, like `cwd`: it is a fact about the user's disk layout, and no
 * more than `GET /api/integrations/existing` already returns there.
 */
export interface WorkingDirectoryIgnored {
  /** `outside-home`: it resolves to a directory home does not contain.
   * `unresolvable`: it is missing, not a directory, or rejected outright. */
  reason: "outside-home" | "unresolvable";
  workingDirectory: string;
}

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
 *
 * `not-configured` (#2180): unlike the others, a supervisor DOES exist — it
 * found no launchable `claude-code` entry (none at all, a Claude Desktop-only
 * setup, or a legacy `apply: "skip"` one), so there is nothing to restart. It
 * clears when the user completes setup: the wizard's Apply re-reads the
 * integration and, when the start mode allows, starts Claude
 * (`Supervisor.startAfterSetup`, #2197).
 *
 * `server-starting` (#1823): HTTP mode, in the window between the server
 * answering and `startLauncherSupervisor()` creating the supervisor (or
 * failing to, which reads `spawn-failed`). Before this the window read
 * `stdio-mode`, which is a terminal "this runtime has no launcher" — Settings
 * then called the launcher absent on an ordinary boot. It is transient for the
 * UI (`isTransientlyUnavailable`) but is NOT promotable by
 * `POST /api/launcher/start` (`isPromotableByStartRoute`): boot creates the
 * supervisor itself, and the route has no business racing it.
 */
export type LauncherUnavailableReason =
  | "stdio-mode"
  | "server-starting"
  | "disabled-by-env"
  | "spawn-failed"
  | "deferred-autostart"
  | "not-configured";

/**
 * True when `available: false` is a *transient phase* the launcher will leave on
 * its own, rather than a terminal explanation. **A UI predicate, and NOT an
 * authorization gate** — `POST /api/launcher/start` asks
 * `isPromotableByStartRoute` instead (#1823 split them).
 *
 * `deferred-autostart` and `server-starting` resolve without the user changing
 * anything. `not-configured` is recoverable too, but only by the user setting
 * Claude Code up, so it is NOT transient: setup is exactly the CTA it needs.
 * The rest mean "this runtime will not have a launcher". The UI must
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
  return reason === "deferred-autostart" || reason === "server-starting";
}

/**
 * The ONE reason `POST /api/launcher/start` may promote to a live supervisor:
 * `deferred-autostart` (#1236). Split from `isTransientlyUnavailable` (#1823)
 * so the UI's notion of "this fixes itself" can grow without widening the
 * route. ADR-046 §7's argument rests on this gate being exactly this narrow:
 * `disabled-by-env` outranks the deferral in `resolveInitialLauncherReason`,
 * so the route can never become an HTTP bypass of the operator kill switch.
 * `server-starting` is refused because boot is about to create the supervisor
 * itself.
 */
export function isPromotableByStartRoute(reason: LauncherUnavailableReason | undefined): boolean {
  return reason === "deferred-autostart";
}

/**
 * Scrubbed `lastError` enum. Verbose error strings stay server-side.
 *
 * `binary-not-found` is about the **reaper**, not the Claude CLI — a broken
 * Tandem install. `cli-unusable` is the Claude CLI one: no Claude Code
 * program the launcher can start was found — absent, or present only as an
 * unstartable Windows shim. Since #2199 the launcher resolves its command
 * before every start (`resolveClaudeLaunch`) and spawns nothing when it finds
 * none, so this is usually recorded with no crash and no breaker; it is also
 * still the more specific reading of a tripped breaker whose probe finds the
 * CLI gone. Both have the same remedy (install/repair it), which is why one
 * member covers them; `circuit-open` keeps its literal meaning of "it
 * crash-looped and the CLI itself is fine", which is what routes the user to a
 * restart rather than to the integration wizard.
 *
 * A CLI installed afterwards does not clear it on its own, but needs no Tandem
 * restart either: the next Start resolves the command afresh, the native
 * install location (`~/.local/bin`) included, which the PATH this process
 * started with never contains right after an install.
 *
 * `wake-delivery-failed` (#1868): the supervisor ended three successive
 * children in a row because each stopped accepting turns on stdin, with no
 * completed turn in between, and gave up. The CLI itself probed as usable, so
 * the remedy is a restart — which is why the client folds it into the same
 * `restart` chip as `circuit-open`, with no client change.
 *
 * `needs-login` (#1780): the Claude CLI runs but is not signed in — it answered
 * a turn with its "Not logged in" refusal, so the supervisor stopped retrying.
 * The remedy is to sign in (`claude` in a terminal) and re-check, which the
 * client offers as its own `sign-in` chip rather than a bare restart.
 *
 * `unlicensed` (#1521): the supervisor declined to spawn Claude Code because
 * Tandem is unlicensed (its AI features are off). It trips nothing — no
 * breaker, no restart loop. The supervisor resumes when a licence is
 * activated through `POST /api/license/activate` (`resumeAfterLicence`).
 * Any other way the licence becomes valid (`tandem activate`, a copied-in
 * `license.json`, a lock on the file clearing) does not resume it; the
 * stopped chip's Restart does.
 */
export type LauncherErrorCode =
  | "spawn-failed"
  | "binary-not-found"
  | "cli-unusable"
  | "stop-failed"
  | "circuit-open"
  | "status-check-failed"
  | "wake-delivery-failed"
  | "needs-login"
  | "unlicensed";

// --- Start / lifetime setting (#2195) -------------------------------------

/**
 * Why Tandem's Claude is not running when nothing went wrong (#2195).
 *   - `off` — the start mode is off (the user turned it off).
 *   - `awaiting-start` — the start mode is `on-click` and nobody has clicked
 *     Start yet, or the mode was switched back on from off.
 *   - `idle` — the lifetime is `idle` and it went the configured time without
 *     a turn, so the supervisor stopped it.
 */
export type LauncherStandby = "off" | "awaiting-start" | "idle";

/** `auto` starts Tandem's Claude when Tandem starts; `on-click` waits for the
 * user's Start; `off` never starts it on its own. */
export type LauncherStartMode = "auto" | "on-click" | "off";
/** `always` keeps it running; `idle` stops it after `idleMinutes` without a
 * turn (measured from the end of the last turn — Bryan, 2026-10-13). */
export type LauncherLifetime = "always" | "idle";

export interface LauncherSettings {
  startMode: LauncherStartMode;
  lifetime: LauncherLifetime;
  idleMinutes: number;
}

export const LAUNCHER_START_MODES: readonly LauncherStartMode[] = ["auto", "on-click", "off"];
export const LAUNCHER_LIFETIMES: readonly LauncherLifetime[] = ["always", "idle"];
export const LAUNCHER_IDLE_MINUTES_MIN = 1;
/** Kept far below `setTimeout`'s 2^31-1 ms ceiling (~35,791 minutes): past it
 * Node fires the timer at once, which would turn "stop after a long idle" into
 * "stop immediately". */
export const LAUNCHER_IDLE_MINUTES_MAX = 1440;

/** Bryan, 2026-10-12: start automatically, always running, 30-minute idle
 * default. Identical to the behaviour before the setting existed, so an install
 * with no settings file is unchanged. */
export const DEFAULT_LAUNCHER_SETTINGS: Readonly<LauncherSettings> = Object.freeze({
  startMode: "auto",
  lifetime: "always",
  idleMinutes: 30,
});

/** A partial update — the only shape the POST accepts. Whole-object writes let
 * a stale snapshot (a second window, a Settings tab opened before Turn off)
 * silently put back a choice the user had just changed. */
export type LauncherSettingsPatch = Partial<LauncherSettings>;

export function isLauncherStartMode(v: unknown): v is LauncherStartMode {
  return typeof v === "string" && (LAUNCHER_START_MODES as readonly string[]).includes(v);
}

export function isLauncherLifetime(v: unknown): v is LauncherLifetime {
  return typeof v === "string" && (LAUNCHER_LIFETIMES as readonly string[]).includes(v);
}

export function isLauncherIdleMinutes(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= LAUNCHER_IDLE_MINUTES_MIN &&
    v <= LAUNCHER_IDLE_MINUTES_MAX
  );
}

/** Validate a POST patch: an object with at least one known field, every field
 * present valid, and nothing else. Returns the patch or the offending field. */
export function parseLauncherSettingsPatch(
  raw: unknown,
): { ok: true; patch: LauncherSettingsPatch } | { ok: false; field: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "patch" };
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length === 0) return { ok: false, field: "patch" };
  const patch: LauncherSettingsPatch = {};
  for (const key of keys) {
    const v = r[key];
    if (key === "startMode" && isLauncherStartMode(v)) patch.startMode = v;
    else if (key === "lifetime" && isLauncherLifetime(v)) patch.lifetime = v;
    else if (key === "idleMinutes" && isLauncherIdleMinutes(v)) patch.idleMinutes = v;
    else return { ok: false, field: key };
  }
  return { ok: true, patch };
}

/** A full settings body (the GET answer), or null if it is not one. The client
 * keeps its controls disabled until a read passes this. */
export function parseLauncherSettings(raw: unknown): LauncherSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isLauncherStartMode(r.startMode)) return null;
  if (!isLauncherLifetime(r.lifetime)) return null;
  if (!isLauncherIdleMinutes(r.idleMinutes)) return null;
  return { startMode: r.startMode, lifetime: r.lifetime, idleMinutes: r.idleMinutes };
}

/** `GET /api/launcher/settings` answer. `readOnly` is set when the file was
 * written by a newer Tandem: its known fields are shown, but a save is refused
 * rather than overwriting fields this build does not know. */
export interface LauncherSettingsResponse {
  settings: LauncherSettings;
  readOnly?: true;
  /** The file exists but could not be read. `settings` is then what Tandem's
   * Claude is running by: the supervisor's last good read when it has one
   * (`keptLastGood`), else the fallback (waiting for Start). Not a saved
   * choice either way; a save rewrites the file. */
  unreadable?: true;
  /** With `unreadable`: `settings` are the ones Tandem last read, still in
   * effect, rather than the fallback. */
  keptLastGood?: true;
}

/** Loopback-only side-channel for bundled-skill refresh failures. The user
 * has no other signal that the skill is stale, so `/status` surfaces this
 * for the palette/settings UI to convert into a notification. */
export interface SkillRefreshError {
  /**
   * `newer-on-disk` is the wizard's, not the refresher's: `installSkill()`
   * declined to downgrade a newer installed skill (#1790), and without this
   * record `POST /api/integrations/apply` answered 200 with every integration
   * `applied` while nothing anywhere said the skill was left alone.
   */
  code: "write-failed" | "read-failed" | "path-rejected" | "timed-out" | "newer-on-disk";
  message: string;
}

// --- Request bodies -------------------------------------------------------

export interface LauncherRelaunchBody {
  /**
   * Optional cwd override; if omitted, uses the integration's setting. The
   * palette's "relaunch here" always sends one — "here" is its whole meaning —
   * but the chip CTAs can fire with no document open, and refusing those was
   * how the empty state's only safe recovery path came to be unreachable.
   */
  cwd?: string;
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

/**
 * `POST /api/launcher/cwd-preview` body (#1282).
 *
 * `cwd` is the folder a relaunch WOULD target — the client's own
 * `deriveCwdFromDocPath(activeDocumentPath)`, i.e. the exact value the relaunch
 * request would carry. Sending the derived folder rather than the document path
 * is deliberate: the preview and the action then share ONE derivation, so they
 * can never disagree about *which* folder while agreeing about the answer. The
 * #1282 post-mortem is precisely that the client's derivation and the server's
 * rejection were each tested alone and never together.
 */
export interface LauncherCwdPreviewBody {
  cwd: string;
}

/**
 * `POST /api/launcher/cwd-preview` response (#1282).
 *
 * A single collapsed `{ drifted: false }` branch carries every "don't nudge"
 * case — launcher not running, path unresolvable, outside home, over-length,
 * same folder, Tandem's own bundled documents. The client must not be able to
 * tell those apart: each would be a second predicate for it to re-derive, and
 * the ones that leak (a path exists / does not exist under home) are exactly the
 * probe an off-loopback caller would want. The route is loopback-only anyway;
 * this is the belt.
 *
 * Every path is display-only and `~`-substituted. The client never needs the
 * raw path back — it derived the folder in the first place, and the relaunch
 * action re-derives it the same way.
 */
export type LauncherCwdPreview =
  | { drifted: false }
  | {
      drifted: true;
      /** Where a relaunch would put Claude, `~`-substituted. */
      suggestedCwd: string;
      /** Where Claude is now, `~`-substituted. */
      claudeCwd: string;
      /** Shortest trailing path segments that distinguish `suggestedCwd` from
       * `claudeCwd`. The client cannot compute this: `basename` collides on
       * `src`/`docs` and on two worktrees of one repository. */
      label: string;
      /** The same distinguishing suffix for `claudeCwd`. */
      claudeLabel: string;
    };

// --- Error codes ----------------------------------------------------------

export const LAUNCHER_ERROR_INVALID_BODY = "INVALID_BODY";
export const LAUNCHER_ERROR_INVALID_NONCE = "INVALID_NONCE";
export const LAUNCHER_ERROR_PATH_REJECTED = "PATH_REJECTED";
export const LAUNCHER_ERROR_IN_PROGRESS = "LAUNCHER_IN_PROGRESS";
export const LAUNCHER_ERROR_NOT_AVAILABLE = "LAUNCHER_NOT_AVAILABLE";
export const LAUNCHER_ERROR_NO_INTEGRATION = "NO_CLAUDE_INTEGRATION";
/** A relaunch / start-fresh / Start found no Claude Code program it can start
 * (#2199) and spawned nothing, leaving a running Claude alone. */
export const LAUNCHER_ERROR_CLI_UNUSABLE = "CLAUDE_CLI_UNUSABLE";
/** The reaper binary is missing from the install — the supervisor cannot spawn
 * Claude. Stable code so the UI can show a "reinstall Tandem" hint instead of a
 * raw filesystem path. */
export const LAUNCHER_ERROR_REAPER_NOT_FOUND = "REAPER_NOT_FOUND";
/** A relaunch / start-fresh / deferred start was refused because Tandem is
 * unlicensed (#1521). Answered 403 with the licence refusal envelope. */
export const LAUNCHER_ERROR_UNLICENSED = "LAUNCHER_UNLICENSED";
/** `POST /api/launcher/settings` refused because `launcher-settings.json` was
 * written by a newer Tandem (#2195). Answered 409 rather than overwriting
 * fields this build cannot see. */
export const LAUNCHER_ERROR_SETTINGS_NEWER = "LAUNCHER_SETTINGS_NEWER";
/** A switch to `off` that stopped Tandem's Claude but could not save the mode
 * (a newer Tandem's file, a failed write) (#2195). Answered 409 so the caller
 * says "off now, not saved" rather than "couldn't turn off". */
export const LAUNCHER_ERROR_OFF_NOT_SAVED = "LAUNCHER_OFF_NOT_SAVED";

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

/** Pre-approved in a launched session (#2286): server-state reads, annotation
 * work and chat. None of them opens, writes, renames or exports a file, and
 * none changes document content (content edits reach disk through autosave). */
export const TANDEM_PREAPPROVED_TOOLS = [
  "tandem_checkInbox",
  "tandem_reply",
  "tandem_status",
  "tandem_listDocuments",
  "tandem_switchDocument",
  "tandem_scratchpad",
  "tandem_getTextContent",
  "tandem_getOutline",
  "tandem_getContext",
  "tandem_getAnnotations",
  "tandem_getActivity",
  "tandem_search",
  "tandem_resolveRange",
  "tandem_diagnostics",
  "tandem_comment",
  "tandem_annotationReply",
  "tandem_editAnnotation",
  "tandem_resolveAnnotation",
  "tandem_removeAnnotation",
] as const;

/** Left to auto mode's classifier in a launched session (#2286): each can open
 * a caller-named path (#1666), change document content that autosave writes
 * back, or write, rename, export, restore or close a file-backed document. */
export const TANDEM_CLASSIFIER_GATED_TOOLS = [
  "tandem_open",
  "tandem_edit",
  "tandem_appendContent",
  "tandem_editList",
  "tandem_save",
  "tandem_rename",
  "tandem_close",
  "tandem_convertToMarkdown",
  "tandem_applyChanges",
  "tandem_exportAnnotations",
  "tandem_restoreBackup",
] as const;

/**
 * The allow rules that pre-approve SOME of Tandem's MCP tools in a launched
 * session (#2286, ADR-047 §4 amendment 2026-10-28).
 *
 * Only `TANDEM_PREAPPROVED_TOOLS` are listed. A matched allow rule is decided
 * before auto mode's classifier, and the launched session reads third-party
 * text (opened documents, imported comments, chat) with nobody watching, so a
 * tool that can reach a file the user owns stays with the classifier — see
 * `TANDEM_CLASSIFIER_GATED_TOOLS`. Bryan chose this narrow grant over the full
 * `*` grant on 2026-10-28. `tests/server/launcher/allow-rules-coverage.test.ts`
 * fails on a registered tool that is in neither list, so whoever adds a tool
 * decides which side it sits on.
 *
 * Since Claude Code 2.1.299 an MCP allow rule matches a server's WHOLE
 * normalized name only, never a prefix, so each tool gets one rule per
 * spelling a user can have registered:
 *
 *   - `mcp__tandem__<tool>` — the entry `tandem setup` writes (server name
 *     `tandem`, whether it is the direct-HTTP entry or the stdio bridge).
 *   - `mcp__plugin_tandem_tandem__<tool>` — the plugin's server: `plugin.json`
 *     names it `tandem`, and Claude Code normalizes `plugin:tandem:tandem`.
 *
 * The opt-in channel shim's server (`tandem-channel`) is deliberately absent:
 * a supervised session never loads it (see `CLAUDE_STREAM_JSON_FLAGS`).
 *
 * An unmatched rule is a silent no-op, not an error, so a wrong spelling here
 * fails toward "auto mode alone decides" rather than toward a crash.
 *
 * An unlisted Tandem tool is screened by the classifier as any other tool is;
 * where auto mode is disabled it is refused (there is no approval surface).
 */
export const TANDEM_MCP_ALLOW_RULES: readonly string[] = [
  "mcp__tandem__",
  "mcp__plugin_tandem_tandem__",
].flatMap((prefix) => TANDEM_PREAPPROVED_TOOLS.map((tool) => `${prefix}${tool}`));

/**
 * Flag prefix the supervisor passes to `claude`, ahead of the
 * session-selection flag (`--session-id` / `--resume`).
 *
 * `-p` + the two `stream-json` formats put the CLI in headless streaming mode:
 * it emits one JSON object per line on stdout and reads user turns as one JSON
 * object per line on stdin. `--verbose` is what makes the CLI emit the full
 * envelope stream rather than just a final answer — the supervisor needs the
 * `{"type":"result",...}` line to know a turn has finished, which is what gates
 * its wake-turn coalescing (see `SUPERVISOR_WAKE_PROMPT`).
 *
 * `--verbose` is NOT a readiness signal. The CLI emits nothing at all until it
 * has received a turn, so there is no handshake to wait for; see
 * `SUPERVISOR_INITIAL_PROMPT`.
 *
 * **`--permission-mode auto` and `--allowedTools` (#2286, ADR-047 §4
 * amendment 2026-10-28).** A supervised session has no approval surface, so
 * before this it could call Tandem's tools only when Claude Code happened to
 * start a `-p` session in auto mode. Claude Code 2.1.302 changed that default
 * to `default` (manual) for third-party providers, telemetry-off and fresh
 * installs, and every `tandem_*` call from a launched session was then refused.
 * The two flags make the posture explicit and are BOTH needed:
 *
 *   - `--permission-mode auto` restores what most launched sessions already got
 *     before 2.1.302: Claude Code's classifier, not a person, decides risky
 *     actions. It is a CLI flag, so it outranks a user's own
 *     `permissions.defaultMode` for this session (managed policy still wins).
 *     Where auto mode is unavailable (managed `disableAutoMode`, a model or plan
 *     without it) the CLI degrades to `default` rather than refusing to start —
 *     measured on 2.1.312 — and then:
 *   - `--allowedTools` keeps Tandem's own tools working regardless of mode. The
 *     rules pre-approve EVERY Tandem tool, so those calls skip the auto-mode
 *     classifier too; see ADR-047 §4's amendment and `docs/security.md` for
 *     what that means for `tandem_open` / `tandem_save`.
 *
 * The allow list is ONE comma-joined token, so the CLI's variadic
 * `<tools...>` parser cannot swallow a following argument. No shell is involved
 * on any OS (POSIX execs `claude` through the reaper; Windows resolves only a
 * `.exe`), so the `*` is never globbed. Both pairs sit in this shared prefix so
 * the `--session-id` AND `--resume` arms carry them — whether a resumed `-p`
 * session keeps its creation-time mode is unestablished, and passing it on
 * both arms avoids depending on it. `--permission-prompts none` was considered
 * and not adopted: it names the posture but grants nothing.
 *
 * Lives here (not in `supervisor.ts`) because the spawn path and the stub-CLI
 * test harness must agree on it byte-for-byte; a drift between them would make
 * the harness green while the shipped launcher spoke a different protocol.
 *
 * **No `--dangerously-load-development-channels server:tandem-channel` here, and
 * do not re-add it.** It was carried on this vector until 2026-08-07 and never
 * did anything, for two independent reasons:
 *
 *   1. Claude Code parses the dev-channels flag only on the interactive path —
 *      the parse sits inside an `if (!isNonInteractiveSession)` branch (read
 *      statically from 2.1.223). `-p` above *is* that non-interactive mode, so
 *      the flag is dropped before it can register anything.
 *   2. Independently of the parse, #1266 measured the end-to-end behaviour
 *      against a real binary (`docs/spikes/channel-push-stream-json.md`): under
 *      these exact flags the shim loads and receives the frame, but the session
 *      never takes a turn. That is why `supervisor.ts` subscribes to the event
 *      queue in-process and writes wake turns onto the child's stdin instead.
 *
 * Deleting it removes nothing a supervised session was using. It stays correct
 * for a *hand-launched* interactive session, where it is the only mechanism
 * that works — see `docs/troubleshooting.md`. A regression pin in
 * `tests/server/launcher/supervisor.test.ts` guards this, because every other
 * assertion here slices by `.length` and so is green with or without it.
 */
export const CLAUDE_STREAM_JSON_FLAGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "auto",
  "--allowedTools",
  TANDEM_MCP_ALLOW_RULES.join(","),
];

/**
 * Told to BOTH supervisor turns, not just the bootstrap one.
 *
 * A launcher-spawned session already has a wake path: the supervisor writes a
 * turn on its stdin. If it also armed a `Monitor` watch on the event stream it
 * would be woken twice for every annotation — once by the turn, once by the
 * notification — and the two would race, with the second arriving mid-turn.
 *
 * The clause has to be on the WAKE prompt as well as the initial one, and that
 * is the whole point of extracting it. `SUPERVISOR_INITIAL_PROMPT` is
 * documented fresh-spawns-only, so a RESUMED session never receives it — and a
 * resumed session is exactly one that has been running long enough to have read
 * the skill and considered arming. Putting this only on the bootstrap turn
 * would leave the population most likely to self-arm as the one population
 * never told not to.
 *
 * Repeating it on every wake is deliberate, and is NOT the "skimmable noise"
 * failure the advisory design rejects. That objection was about a trailing
 * block on 100% of tool calls — 30–120 per session. Wakes are user-driven and
 * coalesce while a turn is in flight, so there are few of them; the cost is a
 * couple of dozen tokens each. Against that, a standing constraint stated once
 * at spawn is lost the first time a long-running session compacts, which is
 * precisely when it has been running long enough to reconsider arming.
 */
export const SUPERVISOR_NO_ARM_CLAUSE =
  "Tandem is already waking you directly, so do NOT arm a Monitor watch on " +
  "Tandem's event stream in this session — it would double every wake.";

/** The ack-before-work rule as one sentence. The `tandem_checkInbox` summary,
 * both `tandem_reply` descriptions (server and channel shim) and the shim's
 * instructions are built from it, so those cannot drift apart and hand Claude
 * conflicting guidance depending on which one it read. Three restatements are
 * NOT built from it and must be kept in step by hand: `SUPERVISOR_ACK_CLAUSE`
 * below (a shorter turn-sized version), `SKILL.md` (pinned by a body hash) and
 * `docs/mcp-tools.md`. */
export const CHAT_ACK_RULE =
  "When a chat message asks for work, reply with tandem_reply BEFORE starting it: a " +
  "one-line acknowledgement with replyTo set to that message's id (a channel event's " +
  "message_id) and inProgress: true. When the work is done, reply again with the result, " +
  "same replyTo, no inProgress. If one reply fully answers the message, just answer it.";

/** Ack-before-work, on both supervisor turns for the same reason as
 * {@link SUPERVISOR_NO_ARM_CLAUSE}: a resumed session only ever receives the
 * wake prompt, and a rule stated once at spawn is lost at the first compaction.
 * The auto-launched child is the population where the user waits longest
 * (a cold start) with nothing on screen, so it is the one that most needs to
 * say something before it goes quiet doing the work. */
export const SUPERVISOR_ACK_CLAUSE =
  "If the user chatted, acknowledge each request with tandem_reply (replyTo + " +
  "inProgress: true) before starting the work, then reply with the result.";

/** No work the user didn't ask for, on both supervisor turns for the same
 * reason as {@link SUPERVISOR_NO_ARM_CLAUSE}. Bryan decided on 2026-10-12 that
 * Tandem's Claude must not start a review without the user asking.
 *
 * It is unconditional rather than an "if the inbox is empty" branch, because
 * the wakes that end in nothing asked are rarely empty: an accept or dismiss
 * wakes the session (`isWakeWorthy` takes every `annotation:*`) and shows up as
 * `userResponses`, and the first-run tutorial invites exactly those clicks.
 * The other case is a coalesced wake whose events Claude already pulled
 * mid-turn. Either way "needs your attention" with nothing asked is where a
 * model falls back on the skill's "annotate freely" line. "Replies" is named
 * because the bootstrap discharges an owed wake (`supervisor.ts`), and a
 * user's reply on one of Claude's threads can be what it was owed for.
 *
 * The no-document sentence exists because chat is not per-document: it reaches
 * Claude through `tandem_checkInbox` with nothing open, and Bryan wants "tandem's
 * claude can open documents for the user, even if none are already open". An
 * earlier draft said "do not open one; just wait", which forbade exactly that.
 * Opening stays gated on the user asking, like every other action here. */
export const SUPERVISOR_NO_UNASKED_WORK_CLAUSE =
  "Respond to chat messages, comments and replies from the user, and do only what they ask; " +
  "reading the text around a comment or selection to answer it is fine. " +
  "An accept or dismiss is not a request and needs no response. Chat reaches you even when no " +
  "document is open: answer it, and if the user asks you to open a file, open it with " +
  "tandem_open. Do not open, read through, review, annotate or edit any document unless the " +
  "user asked you to.";

/** The bootstrap turn the supervisor writes immediately on a fresh spawn.
 *
 * A fresh spawn happens whenever there is no saved session for the planned
 * folder: a first run (with the tutorial open), "Start fresh conversation", a
 * start or relaunch in a different folder, or a start after a failed resume.
 * An ordinary server start or relaunch resumes instead and gets no bootstrap.
 * None of these means a document was just opened, so the turn must not assume
 * one is, and it must not ask for a review (see
 * {@link SUPERVISOR_NO_UNASKED_WORK_CLAUSE}).
 *
 * Written on spawn, NOT after the CLI's `init` line: under these flags the CLI
 * emits nothing until it has received a turn, so waiting for `init` deadlocks.
 * Measured 2026-08-04 — see `docs/spikes/channel-push-stream-json.md`.
 *
 * Fresh spawns only — a resumed session already carries its own history, so
 * re-sending would inject a duplicate turn into the conversation. */
export const SUPERVISOR_INITIAL_PROMPT =
  "Tandem started you as its built-in collaborator. Call tandem_checkInbox now. " +
  `${SUPERVISOR_NO_UNASKED_WORK_CLAUSE} Tandem will wake you when the user does something. ` +
  `${SUPERVISOR_ACK_CLAUSE} ${SUPERVISOR_NO_ARM_CLAUSE}`;

/**
 * The one-time greeting turn (#2197) — the ONLY supervisor turn that asks
 * Tandem's Claude to do something the user did not ask for (Bryan, 2026-10-12:
 * "for that first run only, have it send a chat message in tandem greeting the
 * user"). Sent instead of the bootstrap on a fresh spawn, and instead of the
 * wake / sign-in re-check on a resumed one, at most once per install (see
 * `server/launcher/greeting.ts`), and once more on the first run of v1.0.
 *
 * It still carries {@link SUPERVISOR_NO_UNASKED_WORK_CLAUSE}: the hello is the
 * asked-for work, and the clause governs everything after it. The inbox comes
 * first, so a user who has already written gets an answer, with the hello
 * folded into it, rather than a greeting that ignores their question. It makes
 * no "first session" claim, because the v1.0 re-arm reaches existing users.
 */
export const SUPERVISOR_GREETING_PROMPT =
  "Tandem started you as its built-in collaborator, and asked you to say hello to the user once. " +
  "First call tandem_checkInbox and answer anything waiting as you normally would. Then say " +
  "hello in the chat with tandem_reply, even if what was waiting was a comment rather than a " +
  "chat message (if you already answered a chat message, the hello can be part of that reply): " +
  "two or three short sentences on what you can do here (answer chat, read and comment on " +
  "documents they open, make the edits they ask for) and that you wait to be asked. " +
  `${SUPERVISOR_NO_UNASKED_WORK_CLAUSE} Tandem will wake you when the user does something. ` +
  `${SUPERVISOR_ACK_CLAUSE} ${SUPERVISOR_NO_ARM_CLAUSE}`;

/** How long after the greeting turn is written Tandem waits for a Claude chat
 * message before the chat panel says the hello didn't come (#2197; Bryan:
 * "about a minute"). */
export const GREETING_REPLY_WINDOW_MS = 60_000;

/**
 * What a wizard Apply that wrote a claude-code entry did about Tandem's Claude
 * (#2197), for the done screen. The initial value only; the screen then reads
 * the launcher status like everything else.
 *   - `starting` — it was not running and the start mode is automatic, so it
 *     is starting now.
 *   - `running` — already running (or a start or restart was under way); left
 *     alone.
 *   - `held` — the start mode is not automatic, or it is stopped by choice.
 *   - `other-ai` — another AI session is attached ("Not if another AI is on").
 *   - `refused` — the licence refuses the AI.
 *   - `not-configured` — the launcher found no usable claude-code entry.
 *   - `cli-unusable` — the entry is there, but no Claude Code program the
 *     launcher can start was found (#2199); the status reads `cli-unusable`.
 *   - `unknown` — no answer in time, or no launcher in this process yet.
 */
export const TANDEM_CLAUDE_AFTER_SETUP = [
  "starting",
  "running",
  "held",
  "other-ai",
  "refused",
  "not-configured",
  "cli-unusable",
  "unknown",
] as const;
export type TandemClaudeAfterSetup = (typeof TANDEM_CLAUDE_AFTER_SETUP)[number];

/** Validate a wire value: the wizard trusts nothing it did not check. */
export function isTandemClaudeAfterSetup(v: unknown): v is TandemClaudeAfterSetup {
  return typeof v === "string" && (TANDEM_CLAUDE_AFTER_SETUP as readonly string[]).includes(v);
}

/** The turn the supervisor writes when Tandem activity should wake an idle
 * session.
 *
 * Deliberately carries NO event payload. The channel shim's notifications embed
 * the event content (`formatEventContent`), but a turn injected on stdin is
 * indistinguishable from the user speaking, and this path must not become a
 * second content channel racing the pull path. `tandem_checkInbox` stays the
 * single authority on what the AI may see, so `mode.ts#hideFromAI` still gets
 * the last word even if the queue's Solo gate were ever wrong. A content-free
 * nudge is also what makes coalescing trivial: N events collapse to one turn
 * instead of a concatenation that grows without bound. */
export const SUPERVISOR_WAKE_PROMPT =
  "Activity in Tandem may need your attention. Call tandem_checkInbox. " +
  `${SUPERVISOR_NO_UNASKED_WORK_CLAUSE} ${SUPERVISOR_ACK_CLAUSE} ${SUPERVISOR_NO_ARM_CLAUSE}`;

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
