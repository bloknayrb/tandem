/**
 * `store.lock` payload format + parsing, isolated from {@link ../store.ts} so
 * that lightweight consumers (the `tandem doctor` CLI) can read a lock without
 * pulling in the store's file-io / notifications / platform dependency graph.
 *
 * Two on-disk formats, both must stay readable:
 *   - v2 (#1077): JSON `{pid, startedAtMs?, app}` — written by current versions.
 *   - legacy: a bare PID string — written by older versions.
 */

/** App identifier stamped into v2 lockfiles. */
export const LOCK_APP_ID = "tandem";

/** Parsed contents of `store.lock` (v2 JSON or legacy raw-PID). */
export interface LockfileContents {
  pid: number;
  /** v2 only — epoch ms when the holder took the lock. */
  startedAtMs?: number;
  /** v2 only — always `"tandem"` when written by Tandem. */
  app?: string;
}

/** Serialize the v2 lockfile payload for the current process. */
export function lockfilePayload(): string {
  return JSON.stringify({ pid: process.pid, startedAtMs: Date.now(), app: LOCK_APP_ID });
}

/**
 * Parse `store.lock` contents. Two formats:
 *   - v2 (#1077): JSON `{pid, startedAtMs?, app}` — written by current versions.
 *   - legacy: a bare PID string — written by older versions; must stay readable.
 *
 * Returns `null` for garbage content (callers treat that as a stale lock).
 */
export function parseLockfile(raw: string): LockfileContents | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const pid = parsed.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        startedAtMs: typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : undefined,
        app: typeof parsed.app === "string" ? parsed.app : undefined,
      };
    } catch {
      return null;
    }
  }
  // Legacy raw-PID format. parseInt (not Number()) preserves the historical
  // tolerance for trailing junk after the digits.
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid };
}
