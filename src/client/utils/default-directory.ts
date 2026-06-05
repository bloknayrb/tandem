import { loadSettings } from "../hooks/useTandemSettings.js";
import { API_BASE } from "./fileUpload.js";

/**
 * Shared smart-default directory resolution (#1023).
 *
 * Both the Save-As dialog (`actions/builtin.svelte.ts`) and the native
 * Open-file picker (`utils/browse-file.ts`) start in the same folder: the
 * user's configured default save directory, else the Claude working directory,
 * else the OS home directory. Centralizing the precedence here keeps the two
 * dialogs in sync — a single "where do my files live" notion for the desktop
 * app.
 *
 * Each tier is consulted lazily via `||` short-circuit so we never fetch the
 * integrations endpoint or call into Tauri once an earlier tier resolves.
 */

/** Configured default save folder from persisted settings (#1023), or null. */
export function readDefaultSaveDirectory(): string | null {
  try {
    return loadSettings().defaultSaveDirectory;
  } catch {
    return null;
  }
}

/**
 * Best-effort, time-boxed lookup of the configured Claude working directory.
 * Never throws and never blocks the dialog for more than ~250ms — any
 * failure/timeout yields null so the next fallback tier (home) applies. Reads
 * the same read-only `GET /api/integrations` the Settings tab uses.
 */
export async function fetchClaudeWorkingDir(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    const res = await fetch(`${API_BASE}/api/integrations`, { signal: controller.signal });
    if (!res.ok) return null;
    const file = (await res.json()) as {
      integrations?: { kind?: string; workingDirectory?: string }[];
    };
    const dir = file.integrations?.find((i) => i.kind === "claude-code")?.workingDirectory;
    return typeof dir === "string" && dir.trim() ? dir.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the OS home directory via the Tauri path API, or null if unavailable. */
export async function resolveTauriHomeDir(): Promise<string | null> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    const home = await homeDir();
    return typeof home === "string" && home.trim() ? home : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the smart-default directory using the precedence:
 * configured save folder → Claude working dir → OS home. Returns null when no
 * tier resolves (the caller then lets the OS pick its own default).
 *
 * First non-empty tier wins; `||` short-circuits the async work so we never hit
 * the integrations endpoint or Tauri once an earlier tier resolves.
 */
export async function resolveDefaultDirectory(): Promise<string | null> {
  return (
    readDefaultSaveDirectory() || (await fetchClaudeWorkingDir()) || (await resolveTauriHomeDir())
  );
}
