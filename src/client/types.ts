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
// Cowork integration types (PR f — consumed from Rust invoke commands shipped
// by PR e). Windows-only surface; non-Windows responses set `osSupported=false`.
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
}

/**
 * Discriminated union mirroring the Rust `FirewallError` enum. Each variant
 * drives a distinct user-facing recovery hint — see `firewallErrorHint`.
 */
export type FirewallErrorVariant =
  | { kind: "AdminDeclined" }
  | { kind: "NetshNotFound" }
  | { kind: "NetshFailure"; exitCode: number; stderrTail: string }
  | { kind: "SubnetDetectionFailed" }
  | { kind: "AdapterEnumerationFailed" };
