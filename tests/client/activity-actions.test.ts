import { describe, expect, it } from "vitest";
import { resolveActivityAction } from "../../src/client/components/activityActions.js";
import type { ActivityItem } from "../../src/client/hooks/useNotifications.svelte";
import type { TandemNotification } from "../../src/shared/types.js";

function activityItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "id-1",
    type: "save-error",
    severity: "error",
    message: "Save failed",
    timestamp: Date.now(),
    count: 1,
    ...overrides,
  };
}

describe("resolveActivityAction", () => {
  it("maps a save-error with a documentId to a Retry action", () => {
    const action = resolveActivityAction(activityItem({ documentId: "doc-7" }));
    expect(action).toEqual({ label: "Retry", documentId: "doc-7" });
  });

  it("returns null for a save-error missing its documentId (nothing to retry)", () => {
    expect(resolveActivityAction(activityItem({ documentId: undefined }))).toBeNull();
  });

  // Every non-save-error type has no safe production action in v1 (Undo deferred).
  const otherTypes: TandemNotification["type"][] = [
    "annotation-error",
    "session-restored",
    "general-error",
    "file-reloaded",
    "review-pending",
    "launcher",
  ];
  it.each(otherTypes)("returns null for type %s even with a documentId", (type) => {
    expect(resolveActivityAction(activityItem({ type, documentId: "doc-7" }))).toBeNull();
  });
});
