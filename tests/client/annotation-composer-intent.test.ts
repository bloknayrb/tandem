import { describe, expect, it } from "vitest";
import {
  defaultAnnotationIntent,
  resolveAnnotationSubmission,
} from "../../src/client/editor/toolbar/annotation-composer-intent";

const modifiers = (partial: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }>) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...partial,
});

describe("annotation composer intent", () => {
  it("uses comment as the default for an ordinary composer", () => {
    expect(defaultAnnotationIntent(null)).toBe("comment");
    expect(resolveAnnotationSubmission(null, modifiers({ ctrlKey: true }))).toBe("comment");
  });

  it("routes the primary shortcut through the requested native-menu intent", () => {
    expect(resolveAnnotationSubmission("note", modifiers({ ctrlKey: true }))).toBe("note");
    expect(resolveAnnotationSubmission("comment", modifiers({ metaKey: true }))).toBe("comment");
  });

  it("preserves Alt+Enter as an explicit private-note shortcut", () => {
    expect(resolveAnnotationSubmission("comment", modifiers({ altKey: true }))).toBe("note");
    expect(resolveAnnotationSubmission("note", modifiers({ altKey: true, ctrlKey: true }))).toBe(
      "note",
    );
  });

  it("does not submit on an unmodified Enter", () => {
    expect(resolveAnnotationSubmission("note", modifiers({}))).toBeNull();
  });
});
