/**
 * The editor's side of a document's backups (#1086, ADR-057): list, restore,
 * acknowledge, and the wording each row and banner uses. Shared by the
 * Version history modal and the kept-edits banner.
 */

import {
  API_BACKUPS,
  API_BACKUPS_ACKNOWLEDGE,
  API_BACKUPS_RESTORE,
} from "../../shared/api-paths.js";
import { API_BASE } from "./fileUpload.js";

export interface BackupSnapshot {
  name: string;
  timestamp: string;
  size: number;
  /** `disk`: the file before an overwrite. `unsaved`: edits kept before something discarded them. Absent from an older server. */
  kind?: "disk" | "unsaved";
}

/** The kept edits the user has not been told about yet. */
export interface KeptNotice {
  name: string;
  timestamp: string;
  /** Every such snapshot: what Dismiss acknowledges. */
  names: string[];
}

export interface BackupListing {
  backups: BackupSnapshot[];
  keptNotice: KeptNotice | null;
}

export type ListResult =
  | { ok: true; listing: BackupListing }
  /** `unreadable`: a 200 whose body is not a listing — never read as "no backups". */
  | { ok: false; reason: "http" | "unreadable" | "network"; message?: string };

/** `GET /api/backups` for one document. */
export async function listBackups(documentId: string): Promise<ListResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_BACKUPS}?documentId=${encodeURIComponent(documentId)}`);
  } catch {
    return { ok: false, reason: "network" };
  }
  const body = (await res.json().catch(() => null)) as {
    message?: unknown;
    data?: { backups?: unknown; keptNotice?: unknown };
  } | null;
  if (!res.ok) {
    return {
      ok: false,
      reason: "http",
      message: typeof body?.message === "string" ? body.message : res.statusText,
    };
  }
  const backups = body?.data?.backups;
  if (!Array.isArray(backups)) return { ok: false, reason: "unreadable" };
  const keptNotice = parseKeptNotice(body?.data?.keptNotice);
  return { ok: true, listing: { backups: backups as BackupSnapshot[], keptNotice } };
}

function parseKeptNotice(raw: unknown): KeptNotice | null {
  if (raw === null || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.name !== "string" || typeof n.timestamp !== "string") return null;
  const names = Array.isArray(n.names)
    ? n.names.filter((x): x is string => typeof x === "string")
    : [n.name];
  return { name: n.name, timestamp: n.timestamp, names: names.length > 0 ? names : [n.name] };
}

export type RestoreResult =
  | { ok: true; editsKept: boolean }
  /** `backup-failed`: the unsaved edits could not be kept, so nothing was restored. */
  | { ok: false; reason: "backup-failed" | "http" | "network"; message?: string };

/** `POST /api/backups/restore`. Keeps the unsaved edits first unless `discardUnsavedEdits`. */
export async function restoreBackup(
  documentId: string,
  backup: string,
  discardUnsavedEdits = false,
): Promise<RestoreResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_BACKUPS_RESTORE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        backup,
        ...(discardUnsavedEdits ? { discardUnsavedEdits: true } : {}),
      }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    data?: { unsavedEditsKept?: unknown };
  } | null;
  if (res.status === 409 && body?.error === "BACKUP_FAILED") {
    return { ok: false, reason: "backup-failed" };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: "http",
      message: typeof body?.message === "string" ? body.message : res.statusText,
    };
  }
  return { ok: true, editsKept: body?.data?.unsavedEditsKept != null };
}

/** `POST /api/backups/acknowledge`. Resolves true when the server recorded it. */
export async function acknowledgeKeptEdits(documentId: string, names: string[]): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${API_BACKUPS_ACKNOWLEDGE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, backups: names }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** How a row names what a backup holds. */
export function backupKindLabel(b: Pick<BackupSnapshot, "kind">): string {
  return b.kind === "unsaved" ? "Your unsaved edits" : "File on disk";
}

/** A backup's time as the user's locale shows it; the raw string when unparseable. */
export function formatBackupTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; the absolute time past a week. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "1 day ago" : `${d} days ago`;
  return formatBackupTimestamp(iso);
}

/** A size for a row: bytes under 1 KB, else KB or MB with one decimal. */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
