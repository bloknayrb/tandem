/**
 * #999 (#923 Phase 3) — pure gating predicates + request builder for the native
 * annotation-card context menu. These predicates are the single source of truth shared by
 * the menu AND the in-card buttons, so the truth-table here is the contract that keeps the
 * two from drifting. The predicates reproduce the EFFECTIVE rendered behaviour of
 * `AnnotationCardActions.svelte` (whose if/else-if priority means an import note renders
 * Accept/Reject, not Send to Claude).
 */
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_CONTEXT_MENU_ACTION_IDS,
  buildAnnotationMenuContext,
  canAccept,
  canCopy,
  canDismiss,
  canEdit,
  canRemove,
  canReply,
  canSendToClaude,
  copyTextFor,
  isAnnotationContextMenuActionId,
} from "../../src/client/panels/annotation-context-menu.js";
import type { Annotation, AnnotationStatus } from "../../src/shared/types.js";
import { range } from "../helpers/positions.js";

function ann(
  type: Annotation["type"],
  author: Annotation["author"],
  status: AnnotationStatus = "pending",
): Annotation {
  return {
    id: "a1",
    author,
    range: range(0, 1),
    content: "body",
    status,
    timestamp: 0,
    type,
  } as Annotation;
}

describe("annotation context-menu gating predicates", () => {
  it("Accept/Dismiss: non-user authors, pending — incl. import notes (mirror Accept branch)", () => {
    for (const a of [ann("comment", "claude"), ann("note", "import"), ann("comment", "import")]) {
      expect(canAccept(a)).toBe(true);
      expect(canDismiss(a)).toBe(true);
    }
    // User-authored → no review actions.
    expect(canAccept(ann("note", "user"))).toBe(false);
    expect(canDismiss(ann("highlight", "user"))).toBe(false);
    // Resolved → off even for claude.
    expect(canAccept(ann("comment", "claude", "accepted"))).toBe(false);
  });

  it("Reply: note + comment, pending; never highlight", () => {
    expect(canReply(ann("note", "user"), false)).toBe(true);
    expect(canReply(ann("note", "import"), false)).toBe(true);
    expect(canReply(ann("comment", "claude"), false)).toBe(true);
    expect(canReply(ann("highlight", "user"), false)).toBe(false);
    expect(canReply(ann("comment", "claude", "dismissed"), false)).toBe(false);
  });

  it("Edit: user-authored only (corrected), pending — never claude/import", () => {
    expect(canEdit(ann("note", "user"))).toBe(true);
    expect(canEdit(ann("highlight", "user"))).toBe(true);
    expect(canEdit(ann("comment", "user"))).toBe(true);
    expect(canEdit(ann("comment", "claude"))).toBe(false);
    expect(canEdit(ann("note", "import"))).toBe(false);
    expect(canEdit(ann("note", "user", "accepted"))).toBe(false);
  });

  it("Send to Claude: user notes only, pending (import notes show Accept instead)", () => {
    expect(canSendToClaude(ann("note", "user"), false)).toBe(true);
    expect(canSendToClaude(ann("note", "import"), false)).toBe(false); // → Accept branch
    expect(canSendToClaude(ann("comment", "user"), false)).toBe(false);
    expect(canSendToClaude(ann("highlight", "user"), false)).toBe(false);
    expect(canSendToClaude(ann("note", "user", "dismissed"), false)).toBe(false);
  });

  it("Remove/Archive: user-authored only, pending", () => {
    expect(canRemove(ann("note", "user"))).toBe(true);
    expect(canRemove(ann("highlight", "user"))).toBe(true);
    expect(canRemove(ann("comment", "user"))).toBe(true);
    expect(canRemove(ann("comment", "claude"))).toBe(false);
    expect(canRemove(ann("note", "import"))).toBe(false);
  });

  it("Copy: always available, even resolved", () => {
    expect(canCopy(ann("highlight", "user"))).toBe(true);
    expect(canCopy(ann("comment", "claude", "accepted"))).toBe(true);
  });

  it("Accept and Send are mutually exclusive by author (no card offers both)", () => {
    for (const a of [
      ann("note", "user"),
      ann("note", "import"),
      ann("comment", "claude"),
      ann("highlight", "user"),
    ]) {
      expect(canAccept(a) && canSendToClaude(a, false)).toBe(false);
    }
  });
});

describe("buildAnnotationMenuContext", () => {
  it("user note → compose + copy + archive (isNote true)", () => {
    const req = buildAnnotationMenuContext(ann("note", "user"), false, false);
    expect(req).toEqual({
      canAccept: false,
      canDismiss: false,
      canReply: true,
      canEdit: true,
      canSendToClaude: true,
      canCopy: true,
      canRemove: true,
      isNote: true,
    });
  });

  it("claude comment → review + reply + copy, no edit/remove/send", () => {
    const req = buildAnnotationMenuContext(ann("comment", "claude"), false, false);
    expect(req).toMatchObject({
      canAccept: true,
      canDismiss: true,
      canReply: true,
      canEdit: false,
      canSendToClaude: false,
      canRemove: false,
      isNote: false,
    });
  });

  it("user highlight → edit + copy + remove (isNote false), no reply", () => {
    const req = buildAnnotationMenuContext(ann("highlight", "user"), false, false);
    expect(req).toMatchObject({
      canReply: false,
      canEdit: true,
      canRemove: true,
      canCopy: true,
      isNote: false,
    });
  });

  it("resolved annotation → copy only", () => {
    const req = buildAnnotationMenuContext(ann("comment", "claude", "accepted"), false, false);
    expect(req).toEqual({
      canAccept: false,
      canDismiss: false,
      canReply: false,
      canEdit: false,
      canSendToClaude: false,
      canCopy: true,
      canRemove: false,
      isNote: false,
    });
  });
});

describe("licence refusal (#1521): aiDisabled gates the AI writes only", () => {
  it("Send to Claude is refused while the AI is off; the twin allows it", () => {
    expect(canSendToClaude(ann("note", "user"), true)).toBe(false);
    expect(canSendToClaude(ann("note", "user"), false)).toBe(true);
  });

  it("a reply to a comment is refused; a reply in the user's own note thread is not (#1000)", () => {
    expect(canReply(ann("comment", "claude"), true)).toBe(false);
    expect(canReply(ann("note", "user"), true)).toBe(true);
    expect(canReply(ann("comment", "claude"), false)).toBe(true);
  });

  it("the menu builder forwards it", () => {
    const off = buildAnnotationMenuContext(ann("note", "user"), true, false);
    expect(off.canSendToClaude).toBe(false);
    expect(off.canReply).toBe(true);
    expect(buildAnnotationMenuContext(ann("comment", "claude"), true, false).canReply).toBe(false);
    expect(buildAnnotationMenuContext(ann("note", "user"), false, false).canSendToClaude).toBe(
      true,
    );
  });
});

describe("action-id validation (closed set / cross-surface rejection)", () => {
  it("accepts the closed annotation id set", () => {
    for (const id of ANNOTATION_CONTEXT_MENU_ACTION_IDS) {
      expect(isAnnotationContextMenuActionId(id)).toBe(true);
    }
  });

  it("rejects editor/tab ids and junk (cross-delivery on the shared event)", () => {
    for (const id of [
      "ctx:tab:close",
      "ctx:link:open",
      "ctx:undo",
      "ctx:annotation:bogus",
      "",
      null,
      42,
    ]) {
      expect(isAnnotationContextMenuActionId(id)).toBe(false);
    }
  });
});

describe("copyTextFor", () => {
  it("uses content when present", () => {
    expect(copyTextFor({ content: "hello", textSnapshot: "snap" })).toBe("hello");
  });

  it("falls back to textSnapshot for an empty body (highlight)", () => {
    expect(copyTextFor({ content: "   ", textSnapshot: "highlighted text" })).toBe(
      "highlighted text",
    );
  });

  it("never returns undefined", () => {
    expect(copyTextFor({ content: "" })).toBe("");
    expect(copyTextFor({ content: "  " })).toBe("");
  });
});
