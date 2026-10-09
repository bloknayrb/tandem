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
import { CLIENT_EXTENSIONS } from "../../shared/constants";
import { API_BASE } from "./fileUpload";

export type OpenServerPathResult = { ok: true } | { ok: false; error: string };

/**
 * Whether `/api/open` would accept this server path's extension. The server's
 * check (`assertSupportedExtension`) runs on the same allowlist, so a path that
 * fails here would only come back `UNSUPPORTED_FORMAT`. Used to keep a button
 * off screen rather than offer an open that cannot succeed, e.g. the bare
 * `LICENSE` of a dev or npm tree. Either separator, since the path comes from
 * the server host and may be a Windows path.
 */
export function hasOpenableExtension(filePath: string): boolean {
  const ext = /\.[^./\\]+$/.exec(filePath)?.[0].toLowerCase();
  return ext !== undefined && CLIENT_EXTENSIONS.has(ext);
}

export async function openServerPath(
  filePath: string,
  options: {
    readOnly?: boolean;
    /** Force-reload from disk, clearing existing doc state (annotations,
     *  awareness, content). Used by "Replay tutorial" so the welcome doc
     *  re-seeds fresh. NOTE: the server license-gates the force sub-path. */
    force?: boolean;
    notFoundMessage?: string;
    failureMessage?: string;
  } = {},
): Promise<OpenServerPathResult> {
  const {
    readOnly = false,
    force = false,
    notFoundMessage = "File not found.",
    failureMessage = "Failed to open file.",
  } = options;
  try {
    const res = await fetch(`${API_BASE}${API_OPEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, readOnly, force }),
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
  } catch (err) {
    console.warn("[tandem] openServerPath failed:", err);
    return { ok: false, error: "Server unavailable." };
  }
}
