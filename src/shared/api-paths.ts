/**
 * Single source of truth for Tandem's internal HTTP path strings.
 *
 * Server route registration (`src/server/mcp/{api,channel}-routes.ts`) and every
 * client/CLI/channel-shim/monitor caller import from here so a rename hits one file.
 */

// --- Channel / event stream (SSE + push-back) -------------------------------
export const API_EVENTS = "/api/events";
export const API_NOTIFY_STREAM = "/api/notify-stream";
export const API_CHANNEL_AWARENESS = "/api/channel-awareness";
export const API_CHANNEL_ERROR = "/api/channel-error";
export const API_CHANNEL_REPLY = "/api/channel-reply";
export const API_CHANNEL_PERMISSION = "/api/channel-permission";
export const API_CHANNEL_PERMISSION_VERDICT = "/api/channel-permission-verdict";
export const API_LAUNCH_CLAUDE = "/api/launch-claude";

// --- Mode / metadata --------------------------------------------------------
export const API_MODE = "/api/mode";
export const API_INFO = "/api/info";
// Embedded `tandem doctor` report for the client's "Copy diagnostics" button.
// Loopback-only (the report embeds absolute paths / PIDs).
export const API_DIAGNOSTICS = "/api/diagnostics";
// Diagnostic health endpoint. Loopback callers additionally receive
// `hasSession: boolean` — whether an MCP client transport is currently open
// (an agent is connected, regardless of whether the auto-launcher spawned it).
export const API_HEALTH = "/health";

// --- Document lifecycle -----------------------------------------------------
export const API_OPEN = "/api/open";
export const API_CLOSE = "/api/close";
export const API_SAVE = "/api/save";
export const API_RENAME = "/api/rename";
export const API_UPLOAD = "/api/upload";
export const API_SCRATCHPAD = "/api/scratchpad";
export const API_CONVERT = "/api/convert";
export const API_APPLY_CHANGES = "/api/apply-changes";
// Raw-markdown source view/edit (#1021). GET returns the document's literal
// markdown; POST replaces the Y.Doc content from a user-supplied markdown string.
export const API_DOCUMENT_RAW = "/api/document/raw";
export const API_DOCUMENT_RELOAD = "/api/document/reload";
// Pre-overwrite document backups (#1086). GET lists a document's restorable
// snapshots; POST restores one through the reload lifecycle.
export const API_BACKUPS = "/api/backups";
export const API_BACKUPS_RESTORE = "/api/backups/restore";

// --- Annotations ------------------------------------------------------------
export const API_ANNOTATION_REPLY = "/api/annotation-reply";
export const API_REMOVE_ANNOTATION = "/api/remove-annotation";
// Self-healing stale store.lock reclaim (#1077) — wired to the
// store-readonly banner's Reclaim button.
export const API_STORE_RECLAIM_LOCK = "/api/store/reclaim-lock";

// --- Chat -------------------------------------------------------------------
export const API_CHAT = "/api/chat";

// --- Sessions (persisted-session management UI, #103) -----------------------
export const API_SESSIONS = "/api/sessions";
export const API_SESSIONS_DELETE = "/api/sessions/delete";
export const API_SESSIONS_CLEAR = "/api/sessions/clear";

// --- Auth -------------------------------------------------------------------
// NOTE: the legacy `/api/setup` route was removed in #477 PR 3c-ii-c; setup is
// now wizard-driven (`POST /api/integrations/apply`) or scriptable via
// `tandem setup --apply`.
export const API_ROTATE_TOKEN = "/api/rotate-token";

// --- Auto-launcher (Claude Code supervisor, #477 PR 4b) ---------------------
export const API_LAUNCHER_STATUS = "/api/launcher/status";
export const API_LAUNCHER_NONCE = "/api/launcher/nonce";
export const API_LAUNCHER_RELAUNCH = "/api/launcher/relaunch";
export const API_LAUNCHER_START_FRESH = "/api/launcher/start-fresh";
export const API_LAUNCHER_WORKING_DIRECTORY = "/api/launcher/working-directory";
