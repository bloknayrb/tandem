export const DEFAULT_WS_PORT = 3478;
export const DEFAULT_MCP_PORT = 3479;

/** File extensions the server accepts for opening. */
export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".html", ".htm", ".docx"]);
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const MAX_WS_PAYLOAD = 10 * 1024 * 1024; // 10MB
export const MAX_WS_CONNECTIONS = 4;
export const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TYPING_DEBOUNCE = 3000; // 3 seconds
export const DISCONNECT_DEBOUNCE_MS = 3000; // 3 seconds before showing "server not reachable"
export const PROLONGED_DISCONNECT_MS = 30_000; // 30 seconds before showing App-level disconnect banner
export const OVERLAY_STALE_DEBOUNCE = 200; // 200ms
export const REVIEW_BANNER_THRESHOLD = 5;

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(255, 235, 59, 0.3)",
  red: "rgba(244, 67, 54, 0.3)",
  green: "rgba(76, 175, 80, 0.3)",
  blue: "rgba(33, 150, 243, 0.3)",
  purple: "rgba(156, 39, 176, 0.3)",
};

export const INTERRUPTION_MODE_DEFAULT = "all" as const;
export const INTERRUPTION_MODE_KEY = "tandem:interruptionMode";

// Large file thresholds
export const CHARS_PER_PAGE = 3_000;
export const LARGE_FILE_PAGE_THRESHOLD = 50;
export const VERY_LARGE_FILE_PAGE_THRESHOLD = 100;

export const CLAUDE_PRESENCE_COLOR = "#6366f1";
export const CLAUDE_FOCUS_OPACITY = 0.1;

export const CTRL_ROOM = "__tandem_ctrl__";

/** Y.Map key constants — centralized to prevent silent bugs from string typos. */
export const Y_MAP_ANNOTATIONS = "annotations";
export const Y_MAP_AWARENESS = "awareness";
export const Y_MAP_USER_AWARENESS = "userAwareness";
export const Y_MAP_CHAT = "chat";
export const Y_MAP_DOCUMENT_META = "documentMeta";
export const Y_MAP_SAVED_AT_VERSION = "savedAtVersion";

export const SERVER_INFO_DIR = ".tandem";
export const SERVER_INFO_FILE = ".tandem/.server-info";

export const RECENT_FILES_KEY = "tandem:recentFiles";
export const RECENT_FILES_CAP = 20;

export const USER_NAME_KEY = "tandem:userName";
export const USER_NAME_DEFAULT = "You";

// Toast notifications
export const TOAST_DISMISS_MS = { error: 8000, warning: 6000, info: 4000 } as const;
export const MAX_VISIBLE_TOASTS = 5;
export const NOTIFICATION_BUFFER_SIZE = 50;

// Onboarding tutorial
export const TUTORIAL_COMPLETED_KEY = "tandem:tutorialCompleted";
export const TUTORIAL_ANNOTATION_PREFIX = "tutorial-";

// Editor layout
export const EDITOR_WIDTH_MODE_KEY = "tandem:editorWidthMode";

// Channel / event queue
export const CHANNEL_EVENT_BUFFER_SIZE = 200;
export const CHANNEL_EVENT_BUFFER_AGE_MS = 60_000; // 60 seconds
export const CHANNEL_SSE_KEEPALIVE_MS = 15_000; // 15 seconds
export const CHANNEL_MAX_RETRIES = 5;
export const CHANNEL_RETRY_DELAY_MS = 2_000;
