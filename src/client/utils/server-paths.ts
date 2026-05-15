/**
 * Shared helper for opening server-emitted file paths (changelog,
 * workflows.md, etc.) via the `/api/open` route.
 *
 * Server paths come from `/api/info` and route through
 * `resolveAndValidatePath` on the server, so no client-side path validation
 * is needed here. Each caller decides what to do with the result — the
 * helper deliberately does NOT call any close/dismiss callback because the
 * SettingsModal closes itself on success while the SettingsAboutTab keeps
 * the modal open after opening documentation.
 */
import { API_OPEN } from "../../shared/api-paths";
import { API_BASE } from "./fileUpload";

export type OpenServerPathResult = { ok: true } | { ok: false; error: string };

export async function openServerPath(
  filePath: string,
  options: { readOnly?: boolean; notFoundMessage?: string; failureMessage?: string } = {},
): Promise<OpenServerPathResult> {
  const {
    readOnly = false,
    notFoundMessage = "File not found.",
    failureMessage = "Failed to open file.",
  } = options;
  try {
    const res = await fetch(`${API_BASE}${API_OPEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, readOnly }),
    });
    if (!res.ok) {
      let msg = failureMessage;
      try {
        const data = (await res.json()) as { message?: string };
        if (data.message) msg = data.message;
      } catch {
        // ignore JSON parse failure
      }
      if (res.status === 404) msg = notFoundMessage;
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Server unavailable." };
  }
}
