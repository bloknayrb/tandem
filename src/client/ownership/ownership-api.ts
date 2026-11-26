/**
 * The editor's two calls to the ownership routes (#2358 PR 5b; ownership
 * design §10.1): `POST /api/ownership` for Release and Assign of a document,
 * and `GET /api/ownership/owners` for Assign's choices. Both are registered
 * only while ownership is on; the client calls them only from controls that
 * exist only when the server publishes owner fields, so a dark build never
 * calls either.
 *
 * The POST is a JSON body (the route refuses anything else, so a `text/plain`
 * simple request cannot reach it) and carries the page's own `Origin`, which
 * the route's `assertOriginAllowlisted` checks.
 */

import { API_OWNERSHIP, API_OWNERSHIP_OWNERS } from "../../shared/api-paths";
import type { PublishedDisplayKind } from "../../shared/ownership-published";
import { API_BASE } from "../utils/fileUpload";

export type OwnershipAction = "release" | "assign";

export type OwnershipResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string | null };

/** One record Assign may name (`GET /api/ownership/owners`). */
export interface OwnerChoice {
  readonly label: string;
  readonly displayKind: PublishedDisplayKind;
  /** The file names of the documents it holds (session-influenced: shown quoted). */
  readonly holds: readonly string[];
  readonly canTake: boolean;
}

const DISPLAY_KINDS = new Set(["Tandem's Claude", "terminal", "Claude Desktop", "other app"]);

/** Release or Assign one open document. Never throws. */
export function postDocumentOwnership(
  documentId: string,
  action: OwnershipAction,
  ownerLabel?: string,
): Promise<OwnershipResult> {
  return postOwnership({ documentId, action }, ownerLabel);
}

/**
 * Release or Assign one unanswered chat message (#2358 PR 5e; the route's
 * `{messageId, action, ownerLabel?}`, ADR-054's 5a-2 amendment). Never throws.
 */
export function postMessageOwnership(
  messageId: string,
  action: OwnershipAction,
  ownerLabel?: string,
): Promise<OwnershipResult> {
  return postOwnership({ messageId, action }, ownerLabel);
}

async function postOwnership(
  target:
    | { documentId: string; action: OwnershipAction }
    | { messageId: string; action: OwnershipAction },
  ownerLabel: string | undefined,
): Promise<OwnershipResult> {
  const body: Record<string, string> = { ...target };
  if (target.action === "assign" && ownerLabel !== undefined) body.ownerLabel = ownerLabel;
  try {
    const res = await fetch(`${API_BASE}${API_OWNERSHIP}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: { changed?: unknown };
      error?: unknown;
    } | null;
    if (res.ok) return { ok: true, changed: json?.data?.changed === true };
    return { ok: false, error: typeof json?.error === "string" ? json.error : null };
  } catch {
    return { ok: false, error: null };
  }
}

/**
 * The records that can take a document now, or null when the list could not
 * be read. Entries of a shape this client does not know are dropped.
 */
export async function fetchOwnerChoices(): Promise<OwnerChoice[] | null> {
  try {
    const res = await fetch(`${API_BASE}${API_OWNERSHIP_OWNERS}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json?.data)) return null;
    const out: OwnerChoice[] = [];
    for (const row of json.data as unknown[]) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.label !== "string" || r.label.length === 0) continue;
      if (typeof r.displayKind !== "string" || !DISPLAY_KINDS.has(r.displayKind)) continue;
      if (r.canTake !== true) continue;
      const holds = Array.isArray(r.holds)
        ? r.holds.filter((h): h is string => typeof h === "string")
        : [];
      out.push({
        label: r.label,
        displayKind: r.displayKind as PublishedDisplayKind,
        holds,
        canTake: true,
      });
    }
    return out;
  } catch {
    return null;
  }
}
