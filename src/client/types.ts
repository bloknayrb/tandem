import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";

export interface DocListEntry {
  id: string;
  filePath: string;
  fileName: string;
  format: string;
  readOnly: boolean;
}

export interface OpenTab extends DocListEntry {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
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
  | "failed";

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
  transport: "http";
  /** Loopback-only: absolute path to session storage directory. */
  storagePath?: string;
  /** Loopback-only: mtime of the auth token file in ms, or null if not yet created. */
  tokenRotatedAt?: number | null;
}
