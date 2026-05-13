/**
 * Single source of truth for Tandem's internal HTTP path strings.
 *
 * Server route registration (`src/server/mcp/{api,channel}-routes.ts`) and every
 * client/CLI/channel-shim/monitor caller import from here so a rename hits one file.
 *
 * See #283.
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

// --- Document lifecycle -----------------------------------------------------
export const API_OPEN = "/api/open";
export const API_CLOSE = "/api/close";
export const API_SAVE = "/api/save";
export const API_UPLOAD = "/api/upload";
export const API_SCRATCHPAD = "/api/scratchpad";
export const API_CONVERT = "/api/convert";
export const API_APPLY_CHANGES = "/api/apply-changes";

// --- Annotations ------------------------------------------------------------
export const API_ANNOTATION_REPLY = "/api/annotation-reply";
export const API_REMOVE_ANNOTATION = "/api/remove-annotation";

// --- Chat -------------------------------------------------------------------
export const API_CHAT = "/api/chat";

// --- Setup / auth -----------------------------------------------------------
export const API_SETUP = "/api/setup";
export const API_ROTATE_TOKEN = "/api/rotate-token";
