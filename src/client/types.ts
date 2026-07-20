import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";

export interface DocListEntry {
  id: string;
  filePath: string;
  fileName: string;
  format: string;
  readOnly: boolean;
  /**
   * "file" = a real on-disk document; "upload" = an ephemeral scratchpad or
   * uploaded file. Drives the rename affordance — only "file" docs are
   * renamable (scratchpads/uploads use Save As). See #1017.
   */
  source: "file" | "upload";
}

export interface OpenTab extends DocListEntry {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
}

/**
 * Single client-side definition of the rename affordance gate (#1017): only
 * real on-disk files (`source: "file"`) that aren't read-only can be renamed —
 * scratchpads/uploads use Save As, and `.docx`/changelog open read-only. The
 * server re-validates authoritatively in `renameDocument`; this mirrors it so
 * the three UI surfaces (TabItem `canRename`, the F2 handler, the
 * DocumentTabs trigger re-check) can't drift in what they offer.
 */
export function isRenamable(tab: Pick<DocListEntry, "source" | "readOnly">): boolean {
  return tab.source === "file" && !tab.readOnly;
}

// ---------------------------------------------------------------------------
// Cowork integration types. Windows-only surface; non-Windows responses set osSupported=false.
// ---------------------------------------------------------------------------

/**
 * Per-file install status for a single Cowork workspace. Matches the Rust
 * `WorkspaceWriteReport` + `CoworkError` surface; each of the three plugin
 * registry files reports the same variant set.
 */
export type WorkspaceFileStatus =
  | "ok"
  | "alreadyPresent"
  | "locked"
  | "schemaDrift"
  | "insecureAcl"
  | "failed"
  // Integration not yet enabled — the entry is absent because setup hasn't run,
  // not because a write failed. Neutral, never shown as an error.
  | "notConfigured";

export interface WorkspaceStatus {
  workspaceId: string;
  vmId: string;
  installedPlugins: WorkspaceFileStatus;
  knownMarketplaces: WorkspaceFileStatus;
  coworkSettings: WorkspaceFileStatus;
  path: string;
  failureDetail?: string;
}

export interface CoworkStatus {
  osSupported: boolean;
  coworkDetected: boolean;
  /**
   * Claude Desktop install signal independent of workspace existence — lets
   * the UI distinguish "no Claude at all" from "Claude present, Cowork never
   * run". Optional: a stale (pre-field) Rust sidecar during update overlap
   * omits it; helpers default to false.
   */
  claudeDesktopDetected?: boolean;
  /**
   * Count of session dirs found but rejected by the path security guard
   * (network-redirected or cloud-synced AppData). Optional, defaults to 0.
   */
  workspacesBlocked?: number;
  enabled: boolean;
  vethernetCidr: string | null;
  lanIpFallback: string | null;
  useLanIpOverride: boolean;
  workspaces: WorkspaceStatus[];
  uacDeclined: boolean;
  uacDeclinedAt: string | null;
  workspacesLastScannedAt?: string | null;
}

/**
 * Discriminated union mirroring the Rust `FirewallError` enum. Each variant
 * drives a distinct user-facing recovery hint — see `firewallErrorHint`.
 */
export type FirewallErrorVariant =
  | { kind: "adminDeclined" }
  | { kind: "netshNotFound" }
  | { kind: "netshFailure"; exitCode: number; stderrTail: string; stdoutTail: string }
  | { kind: "subnetDetectionFailed" }
  | { kind: "adapterEnumerationFailed" };

// ---------------------------------------------------------------------------
// App info response from GET /api/info
// ---------------------------------------------------------------------------

/**
 * Shape returned by GET /api/info. Public fields are always present; loopback-
 * only fields (storagePath, tokenRotatedAt) are included only when the request
 * originates from 127.0.0.1.
 */
export interface AppInfoData {
  version: string;
  toolCount: number | null;
  mcpSdkVersion: string;
  transport?: "http" | "stdio";
  bindHost?: string;
  /** MCP HTTP port number. Undefined for stdio. */
  bindPort?: number;
  /** Loopback-only: absolute path to session storage directory. */
  storagePath?: string;
  /** Loopback-only: mtime of the auth token file in ms, or null if not yet created. */
  tokenRotatedAt?: number | null;
  /** Absolute path to CHANGELOG.md on the server host. Undefined if not found at startup. */
  changelogPath?: string;
  /** Absolute path to docs/workflows.md on the server host. Undefined if not found at startup. */
  workflowsPath?: string;
  /** Absolute path to sample/welcome.md on the server host. Undefined if not found at startup.
   *  Consumed by the "Replay tutorial" affordance to reopen the welcome doc. */
  welcomePath?: string;
}
