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

export const SERVER_INFO_DIR = ".tandem";
export const SERVER_INFO_FILE = ".tandem/.server-info";
