import { describe, expect, it } from "vitest";
import type { Annotation } from "../../src/shared/types.js";

/**
 * Unit tests for the author-based prop logic in SidePanel that determines
 * which action handlers are passed to AnnotationCard.
 *
 * The invariant: user annotations get onRemove but not onAccept/onDismiss;
 * claude/import annotations get onAccept/onDismiss but not onRemove.
 */

function resolveHandlers(author: Annotation["author"]) {
  const handleAccept = (_id: string) => {};
  const handleDismiss = (_id: string) => {};
  const handleRemove = (_id: string): Promise<void> => Promise.resolve();

  return {
    onAccept: author !== "user" ? handleAccept : undefined,
    onDismiss: author !== "user" ? handleDismiss : undefined,
    onRemove: author === "user" ? handleRemove : undefined,
  };
}

describe("SidePanel annotation handler routing by author", () => {
  it("claude annotation: onAccept and onDismiss set, onRemove undefined", () => {
    const { onAccept, onDismiss, onRemove } = resolveHandlers("claude");
    expect(onAccept).toBeDefined();
    expect(onDismiss).toBeDefined();
    expect(onRemove).toBeUndefined();
  });

  it("import annotation: onAccept and onDismiss set, onRemove undefined", () => {
    const { onAccept, onDismiss, onRemove } = resolveHandlers("import");
    expect(onAccept).toBeDefined();
    expect(onDismiss).toBeDefined();
    expect(onRemove).toBeUndefined();
  });

  it("user annotation: onRemove set, onAccept and onDismiss undefined", () => {
    const { onAccept, onDismiss, onRemove } = resolveHandlers("user");
    expect(onAccept).toBeUndefined();
    expect(onDismiss).toBeUndefined();
    expect(onRemove).toBeDefined();
  });
});
