import type { LicenseStatus } from "./license-types.js";

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
