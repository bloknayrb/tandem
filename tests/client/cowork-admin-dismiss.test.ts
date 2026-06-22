import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetAdminDismissForTests,
  adminPopupDismissed,
  dismissAdminPopup,
  noteUacDeclinedAt,
} from "../../src/client/cowork/coworkAdminDismiss.svelte.js";

// ---------------------------------------------------------------------------
// Session-scoped dismiss state for CoworkAdminDeclinedModal.
//
// The modal's `visible` guard is `uacDeclined && !adminPopupDismissed()`. These
// tests cover the re-arm semantics that the 30s status poll and the disable-clears-
// the-flag path depend on. Module state is reset between cases.
// ---------------------------------------------------------------------------

describe("coworkAdminDismiss", () => {
  beforeEach(() => {
    _resetAdminDismissForTests();
  });

  it("starts not dismissed", () => {
    expect(adminPopupDismissed()).toBe(false);
  });

  it("dismiss() hides it for the session", () => {
    dismissAdminPopup();
    expect(adminPopupDismissed()).toBe(true);
  });

  it("an unchanged timestamp does NOT re-arm a dismissed popup (30s poll is a no-op)", () => {
    noteUacDeclinedAt("2026-06-22T00:00:00Z");
    dismissAdminPopup();
    expect(adminPopupDismissed()).toBe(true);
    // Same timestamp arriving again on the next poll must not un-dismiss.
    noteUacDeclinedAt("2026-06-22T00:00:00Z");
    expect(adminPopupDismissed()).toBe(true);
  });

  it("a NEW non-null timestamp re-arms the popup (fresh decline)", () => {
    noteUacDeclinedAt("2026-06-22T00:00:00Z");
    dismissAdminPopup();
    expect(adminPopupDismissed()).toBe(true);
    noteUacDeclinedAt("2026-06-22T01:00:00Z");
    expect(adminPopupDismissed()).toBe(false);
  });

  it("a non-null → null transition (disable cleared the flag) does NOT re-arm", () => {
    noteUacDeclinedAt("2026-06-22T00:00:00Z");
    dismissAdminPopup();
    expect(adminPopupDismissed()).toBe(true);
    // Disable clears uacDeclinedAt to null — must be ignored, not treated as a decline.
    noteUacDeclinedAt(null);
    expect(adminPopupDismissed()).toBe(true);
  });
});
