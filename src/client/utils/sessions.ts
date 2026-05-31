/**
 * Client helpers for the persisted-session management UI (#103).
 *
 * Wraps the read-only `GET /api/sessions` list plus the mutating
 * delete-one / clear-all routes. The mutating routes are origin- and
 * loopback-gated server-side; these requests originate from the loopback
 * WebView so they satisfy both gates.
 */
import { API_SESSIONS, API_SESSIONS_CLEAR, API_SESSIONS_DELETE } from "../../shared/api-paths.js";
import { API_BASE } from "./fileUpload.js";

export interface SessionMetadata {
  filePath: string;
  lastAccessed: number;
  annotationCount: number;
}

export type SessionsResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function postJson(
  apiPath: string,
  body: Record<string, unknown>,
): Promise<SessionsResult<Record<string, unknown>>> {
  try {
    const res = await fetch(`${API_BASE}${apiPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: unknown; message?: string };
    if (!res.ok) {
      return { ok: false, error: json.message ?? "Request failed." };
    }
    return { ok: true, data: (json.data ?? {}) as Record<string, unknown> };
  } catch (err) {
    console.warn("[tandem] sessions request failed:", err);
    return { ok: false, error: "Server unavailable." };
  }
}

/** Fetch all persisted document sessions with metadata. */
export async function fetchSessions(): Promise<SessionsResult<SessionMetadata[]>> {
  try {
    const res = await fetch(`${API_BASE}${API_SESSIONS}`);
    const json = (await res.json().catch(() => ({}))) as {
      data?: { sessions?: SessionMetadata[] };
      message?: string;
    };
    if (!res.ok) {
      return { ok: false, error: json.message ?? "Failed to load sessions." };
    }
    return { ok: true, data: json.data?.sessions ?? [] };
  } catch (err) {
    console.warn("[tandem] fetchSessions failed:", err);
    return { ok: false, error: "Server unavailable." };
  }
}

/** Delete a single persisted session by file path. */
export async function deleteSessionByPath(filePath: string): Promise<SessionsResult<unknown>> {
  return postJson(API_SESSIONS_DELETE, { filePath });
}

/** Delete all persisted document sessions. */
export async function clearAllSessions(): Promise<SessionsResult<unknown>> {
  return postJson(API_SESSIONS_CLEAR, {});
}
