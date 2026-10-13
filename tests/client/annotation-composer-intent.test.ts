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
    expect(defaultAnnotationIntent(null, false)).toBe("comment");
    expect(resolveAnnotationSubmission(null, modifiers({ ctrlKey: true }), false)).toBe("comment");
  });

  it("routes the primary shortcut through the requested native-menu intent", () => {
    expect(resolveAnnotationSubmission("note", modifiers({ ctrlKey: true }), false)).toBe("note");
    expect(resolveAnnotationSubmission("comment", modifiers({ metaKey: true }), false)).toBe(
      "comment",
    );
  });

  it("preserves Alt+Enter as an explicit private-note shortcut", () => {
    expect(resolveAnnotationSubmission("comment", modifiers({ altKey: true }), false)).toBe("note");
    expect(
      resolveAnnotationSubmission("note", modifiers({ altKey: true, ctrlKey: true }), false),
    ).toBe("note");
  });

  it("does not submit on an unmodified Enter", () => {
    expect(resolveAnnotationSubmission("note", modifiers({}), false)).toBeNull();
  });

  it("forces a private note while the AI is off (#1521), whatever the intent", () => {
    expect(defaultAnnotationIntent(null, true)).toBe("note");
    // The native "Comment to AI" menu path sets "comment" directly.
    expect(defaultAnnotationIntent("comment", true)).toBe("note");
    expect(resolveAnnotationSubmission("comment", modifiers({ ctrlKey: true }), true)).toBe("note");
    expect(resolveAnnotationSubmission(null, modifiers({ metaKey: true }), true)).toBe("note");
    expect(resolveAnnotationSubmission("comment", modifiers({ altKey: true }), true)).toBe("note");
  });
});
