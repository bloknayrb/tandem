export const DEFAULT_WS_PORT = 3478;
export const DEFAULT_MCP_PORT = 3479;

export const TANDEM_REPO_URL = "https://github.com/bloknayrb/tandem";
export const TANDEM_ISSUES_NEW_URL = `${TANDEM_REPO_URL}/issues/new`;

/** File extensions the server accepts for opening. */
export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".html", ".htm", ".docx"]);
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TYPING_DEBOUNCE = 3000; // 3 seconds
export const DISCONNECT_DEBOUNCE_MS = 3000; // 3 seconds before showing "server not reachable"
export const PROLONGED_DISCONNECT_MS = 30_000; // 30 seconds before showing App-level disconnect banner

import type { HighlightColor } from "./types.js";

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: "rgba(255, 235, 59, 0.3)",
  green: "rgba(76, 175, 80, 0.3)",
  blue: "rgba(33, 150, 243, 0.3)",
  pink: "rgba(236, 72, 153, 0.3)",
};

export const HIGHLIGHT_COLOR_VARS: Record<HighlightColor, string> = {
  yellow: "var(--tandem-highlight-yellow)",
  green: "var(--tandem-highlight-green)",
  blue: "var(--tandem-highlight-blue)",
  pink: "var(--tandem-highlight-pink)",
};

export function normalizeHighlightColor(color: string | null | undefined): HighlightColor {
  return color && color in HIGHLIGHT_COLORS ? (color as HighlightColor) : "yellow";
}

export const TANDEM_MODE_DEFAULT = "tandem" as const;
export const TANDEM_MODE_KEY = "tandem:mode";
export const TANDEM_SETTINGS_KEY = "tandem:settings";
// Panel-width localStorage keys.
//
// NOTE: these use legacy hyphen naming (vs the neighboring colon convention
// `tandem:mode`/`tandem:settings`) because they predate the colon scheme and
// changing the strings would invalidate every existing user's saved widths.
// Do not "fix" the style — the key string is the persistence contract.
//
// Right-side panel width is shared between the tabbed layout and any
// future left-panel variant. The left key only applies when the left
// panel is visible.
export const PANEL_WIDTH_KEY = "tandem-panel-width";
export const LEFT_PANEL_WIDTH_KEY = "tandem-left-panel-width";

export type PanelSide = "left" | "right";

/**
 * Maps a panel side to its localStorage key. Using a Record instead of two
 * bare constants makes the "both handles write to the same key" regression
 * (#228) structurally impossible — you can't accidentally map both sides to
 * the same value at a callsite.
 *
 * Uses `as const satisfies Record<PanelSide, string>` so the value type stays
 * as the literal strings rather than widening to `string` — this preserves
 * the persistence-key identity at every callsite while still enforcing
 * exhaustive coverage of `PanelSide`.
 */
export const PANEL_WIDTH_KEYS = {
  left: LEFT_PANEL_WIDTH_KEY,
  right: PANEL_WIDTH_KEY,
} as const satisfies Record<PanelSide, string>;
export const SELECTION_DWELL_DEFAULT_MS = 1000;
export const SELECTION_DWELL_MIN_MS = 500;
export const SELECTION_DWELL_MAX_MS = 3000;

// Large file thresholds
export const CHARS_PER_PAGE = 3_000;
export const LARGE_FILE_PAGE_THRESHOLD = 50;
export const VERY_LARGE_FILE_PAGE_THRESHOLD = 100;

export const CTRL_ROOM = "__tandem_ctrl__";

/** Y.Map key constants — centralized to prevent silent bugs from string typos. */
export const Y_MAP_ANNOTATIONS = "annotations";
export const Y_MAP_AWARENESS = "awareness";
export const Y_MAP_USER_AWARENESS = "userAwareness";
export const Y_MAP_MODE = "mode";
export const Y_MAP_DWELL_MS = "selectionDwellMs";
export const Y_MAP_CHAT = "chat";
export const Y_MAP_DOCUMENT_META = "documentMeta";
export const Y_MAP_ANNOTATION_REPLIES = "annotationReplies";
export const Y_MAP_SAVED_AT_VERSION = "savedAtVersion";
export const Y_MAP_AUTHORSHIP = "authorship";
// Y.Map sub-keys: userAwareness
export const Y_MAP_SELECTION = "selection";
export const Y_MAP_ACTIVITY = "activity";
// Y.Map sub-keys: awareness (Claude focus)
export const Y_MAP_CLAUDE = "claude";
// Y.Map sub-keys: documentMeta
export const Y_MAP_OPEN_DOCUMENTS = "openDocuments";
export const Y_MAP_ACTIVE_DOCUMENT_ID = "activeDocumentId";
export const Y_MAP_GENERATION_ID = "generationId";
export const Y_MAP_READ_ONLY = "readOnly";
export const Y_MAP_STORE_READ_ONLY = "storeReadOnly";

export const AUTHORSHIP_TOGGLE_KEY = "tandem:showAuthorship";

export const RECENT_FILES_KEY = "tandem:recentFiles";
export const RECENT_FILES_CAP = 20;

export const USER_NAME_KEY = "tandem:userName";
export const USER_NAME_DEFAULT = "You";
export const USER_NAME_EVENT = "tandem:user-name-changed";
export const USER_NAME_MAX_LEN = 40;

// Toast notifications
export const TOAST_DISMISS_MS = { error: 8000, warning: 6000, info: 4000 } as const;
export const MAX_VISIBLE_TOASTS = 5;
export const NOTIFICATION_BUFFER_SIZE = 50;

// Onboarding tutorial
export const TUTORIAL_COMPLETED_KEY = "tandem:tutorialCompleted";
export const TUTORIAL_ANNOTATION_PREFIX = "tutorial-";
/** Persists "user skipped the Cowork onboarding step" across sessions. */
export const COWORK_ONBOARDING_SKIPPED_KEY = "tandem:coworkOnboardingSkipped";
/** Polling interval for `cowork_get_status` while the consumer is active. */
export const COWORK_STATUS_POLL_MS = 30_000;
/** Debounce interval for the "Re-scan workspaces" button. */
export const COWORK_RESCAN_DEBOUNCE_MS = 2_000;

// Channel / event queue
export const CHANNEL_EVENT_BUFFER_SIZE = 200;
export const CHANNEL_EVENT_BUFFER_AGE_MS = 60_000; // 60 seconds
export const CHANNEL_SSE_KEEPALIVE_MS = 15_000; // 15 seconds
export const CHANNEL_MAX_RETRIES = 5;
export const CHANNEL_RETRY_DELAY_MS = 2_000;

// Channel shim per-request timeouts. Mirror the monitor pattern (#364) so a
// half-open Tandem server can't wedge `tandem_reply`, the permission relay,
// or the event-bridge SSE handshake / awareness / mode / error-report POSTs.
// Intentionally separate constants per endpoint so a slow endpoint doesn't
// hold up a faster one — and so log lines name a meaningful threshold.
export const CHANNEL_CONNECT_FETCH_TIMEOUT_MS = 10_000; // /api/events handshake
export const CHANNEL_SSE_INACTIVITY_TIMEOUT_MS = 60_000; // No-bytes watchdog on SSE body
export const CHANNEL_MODE_FETCH_TIMEOUT_MS = 2_000; // /api/mode cache refresh
export const CHANNEL_AWARENESS_FETCH_TIMEOUT_MS = 5_000; // /api/channel-awareness POST
export const CHANNEL_ERROR_REPORT_TIMEOUT_MS = 3_000; // /api/channel-error POST on exit
export const CHANNEL_REPLY_FETCH_TIMEOUT_MS = 5_000; // /api/channel-reply (tandem_reply)
export const CHANNEL_PERMISSION_FETCH_TIMEOUT_MS = 5_000; // /api/channel-permission relay
// Bound the SSE buffer so a misbehaving server that never emits frame
// boundaries can't wedge the bridge with unbounded string growth.
export const CHANNEL_MAX_SSE_BUFFER_BYTES = 1_000_000;

/** Auth token filename inside the app-data directory. */
export const TOKEN_FILE_NAME = "auth-token";

/** Default MCP bind host — loopback only by default. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Env var name to opt in to unauthenticated LAN binding. */
export const TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV = "TANDEM_ALLOW_UNAUTHENTICATED_LAN";

/** Tauri WebView origin hostname — must be accepted alongside localhost. */
export const TAURI_HOSTNAME = "tauri.localhost";

// Zoom persistence (Tauri desktop)
export const ZOOM_STORAGE_KEY = "tandem:zoomLevel";
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_DEFAULT = 1.0;
