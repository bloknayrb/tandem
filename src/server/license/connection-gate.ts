import { CTRL_ROOM } from "../../shared/constants.js";
import type { LicenseState, LicenseStatus } from "./license-types.js";

/**
 * Surface A decision (#1116, ADR-040): should a Hocuspocus client connection be
 * marked read-only? In `restricted` mode, document-room connections are read-only
 * so browser-authored edits AND annotations are rejected server-side (no CRDT
 * revert — the server simply does not apply updates from a read-only connection).
 * CTRL_ROOM stays writable so chat / mode toggle / awareness keep working — the
 * read-only *data* escape hatch (you can still open, read, and export your work).
 */
export function connectionShouldBeReadOnly(
  documentName: string,
  ctrlRoom: string,
  status: LicenseStatus,
): boolean {
  return status === "restricted" && documentName !== ctrlRoom;
}

/**
 * Apply the Surface A gate to a live connection: set `readOnly = true` when the
 * resolved license state restricts this document room. Returns whether it
 * clamped (so the caller can log). Extracted from `onAuthenticate` so the
 * load-bearing ASSIGNMENT — not just the pure predicate — is unit-testable
 * against a connection stub. No-op when the gate is inactive (dark build).
 */
export function applyConnectionGate(
  connection: { readOnly?: boolean },
  documentName: string,
  state: LicenseState,
): boolean {
  if (!state.gateActive) return false;
  if (connectionShouldBeReadOnly(documentName, CTRL_ROOM, state.status)) {
    connection.readOnly = true;
    return true;
  }
  return false;
}
