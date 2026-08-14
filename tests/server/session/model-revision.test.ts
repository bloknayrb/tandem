/**
 * Session model-revision stamp (#1448 W3).
 *
 * A session's `ydocState` is an already-parsed document, so a parser fix does
 * not reach it. Without the stamp the fix ships and never arrives: a user who
 * upgrades keeps every defect their pre-fix session baked in for up to 30 days.
 */

import { describe, expect, it } from "vitest";
import { sessionModelIsStale } from "../../../src/server/session/manager.js";
import { DOCUMENT_MODEL_REVISION } from "../../../src/shared/constants.js";
import type { SessionData } from "../../../src/shared/types.js";

function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    filePath: "C:/notes/note.md",
    format: "md",
    ydocState: "",
    sourceFileMtime: 0,
    lastAccessed: 0,
    ...overrides,
  };
}

describe("sessionModelIsStale", () => {
  it("treats a session with no stamp as stale — that is the population to discard", () => {
    expect(sessionModelIsStale(session())).toBe(true);
  });

  it("treats a session stamped at the current revision as current", () => {
    expect(sessionModelIsStale(session({ modelRevision: DOCUMENT_MODEL_REVISION }))).toBe(false);
  });

  it("treats a session from a FUTURE revision as current, not stale", () => {
    // A downgrade must not silently throw away the newer session; the
    // comparison is one-directional on purpose.
    expect(sessionModelIsStale(session({ modelRevision: DOCUMENT_MODEL_REVISION + 1 }))).toBe(
      false,
    );
  });

  it("never discards a dirty session, however old its stamp", () => {
    // Those edits exist nowhere else — discarding them would be the data loss
    // the stamp exists to prevent.
    expect(sessionModelIsStale(session({ dirty: true }))).toBe(false);
  });

  it("never discards an upload:// session, which has no file to re-read", () => {
    expect(sessionModelIsStale(session({ filePath: "upload://abc/note.md" }))).toBe(false);
  });

  it("never discards a CLEAN session carrying an unresolved conflict", () => {
    // The session is the only record that the conflict happened: saveSession
    // stats the file at save time, so sourceFileMtime IS the external write's
    // mtime and sourceFileChanged reads false on reopen. Discarding it returns
    // before maybeRestoreSession's carry, which does not defer the conflict —
    // it destroys it. The banner never appears and the next autosave tick
    // overwrites the user's external edit. Re-reading a stale parse is an
    // improvement; losing a file is not a price to pay for one.
    expect(
      sessionModelIsStale(
        session({
          dirty: false,
          conflict: { kind: "external-edit", diskChanged: true, detectedAt: 1 },
        }),
      ),
    ).toBe(false);
  });

  it("still discards a clean session whose conflict field is absent or malformed", () => {
    // Positive control: the carve-out is keyed on a conflict that `narrowConflict`
    // actually recognizes, not on the field merely being set. Without this, a
    // guard that returned false for any truthy value would satisfy the test above.
    expect(sessionModelIsStale(session({ conflict: undefined }))).toBe(true);
    expect(sessionModelIsStale(session({ conflict: { kind: "nonsense" } as never }))).toBe(true);
  });

  it("the revision is a positive integer, so an unstamped session sorts below it", () => {
    expect(Number.isInteger(DOCUMENT_MODEL_REVISION)).toBe(true);
    expect(DOCUMENT_MODEL_REVISION).toBeGreaterThan(0);
  });
});
