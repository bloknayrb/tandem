// @vitest-environment happy-dom

/**
 * #2360 PR 1 — "Resolve" for a user's own comment.
 *
 * Resolve closes the user's own comment without deleting it: it writes
 * `status: "dismissed"` through the existing resolve path, applies nothing,
 * and asks nothing of Claude. Remove stays as it was (a hard delete).
 *
 * Auto-cleanup never registers in this repo's client project, so each render is
 * unmounted explicitly and queries are scoped to the container.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import AnnotationCard from "../../src/client/panels/AnnotationCard.svelte";
import AnnotationCardActions from "../../src/client/panels/AnnotationCardActions.svelte";
import { displayStatus, getCardLabel } from "../../src/client/panels/annotation-card-helpers.js";
import {
  ANNOTATION_CONTEXT_MENU_ACTION_IDS,
  buildAnnotationMenuContext,
  canRemove,
  canResolve,
  isAnnotationContextMenuActionId,
} from "../../src/client/panels/annotation-context-menu.js";
import { runAnnotationAction } from "../../src/client/panels/annotation-context-menu-host.js";
import type { Annotation, AnnotationStatus } from "../../src/shared/types.js";
import { range } from "../helpers/positions.js";

function ann(
  type: Annotation["type"],
  author: Annotation["author"],
  status: AnnotationStatus = "pending",
  extra: Partial<Annotation> = {},
): Annotation {
  return {
    id: "a1",
    author,
    range: range(0, 1),
    content: "body",
    status,
    timestamp: 0,
    type,
    ...extra,
  } as Annotation;
}

const byTestId = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);

describe("canResolve", () => {
  it("is true for a pending user comment only", () => {
    expect(canResolve(ann("comment", "user"))).toBe(true);
    // A promoted import is an ordinary user comment (#1714): resolvable on purpose.
    expect(
      canResolve(ann("comment", "user", "pending", { importSource: { author: "A", file: "f" } })),
    ).toBe(true);
  });

  it("is false for everything else", () => {
    expect(canResolve(ann("comment", "claude"))).toBe(false);
    expect(canResolve(ann("comment", "import"))).toBe(false);
    expect(canResolve(ann("note", "user"))).toBe(false);
    expect(canResolve(ann("highlight", "user"))).toBe(false);
    expect(canResolve(ann("comment", "user", "dismissed"))).toBe(false);
    expect(canResolve(ann("comment", "user", "accepted"))).toBe(false);
  });

  // This pinned Remove as pending-only when Resolve shipped (#2365). It is inverted on
  // purpose: after a reload a resolved comment had no action at all, and Bryan chose
  // "allow remove" (2026-11-05) over adding Reopen.
  it("lets Remove reach the user's own resolved comment", () => {
    expect(canRemove(ann("comment", "user"))).toBe(true);
    expect(canRemove(ann("comment", "user", "dismissed"))).toBe(true);
    // Closed by accepting Claude's reply rewrite: the same resolved list, same dead end.
    expect(canRemove(ann("comment", "user", "accepted"))).toBe(true);
  });

  it("does not let Remove reach anyone else's closed comment", () => {
    expect(canRemove(ann("comment", "claude", "dismissed"))).toBe(false);
    expect(canRemove(ann("comment", "claude", "accepted"))).toBe(false);
    expect(canRemove(ann("comment", "import", "dismissed"))).toBe(false);
    expect(canRemove(ann("note", "import", "accepted"))).toBe(false);
  });

  it("the native menu offers Remove on a resolved user comment", () => {
    const req = buildAnnotationMenuContext(ann("comment", "user", "dismissed"), false, false);
    expect(req.canRemove).toBe(true);
    expect(req.isNote).toBe(false);
    expect(req.canResolve).toBe(false);
  });
});

describe("native context menu: resolve", () => {
  it("the id is in the closed set", () => {
    expect(ANNOTATION_CONTEXT_MENU_ACTION_IDS).toContain("ctx:annotation:resolve");
    expect(isAnnotationContextMenuActionId("ctx:annotation:resolve")).toBe(true);
  });

  it("the request carries canResolve for a user comment and not for a Claude one", () => {
    expect(buildAnnotationMenuContext(ann("comment", "user"), false, false).canResolve).toBe(true);
    expect(buildAnnotationMenuContext(ann("comment", "claude"), false, false).canResolve).toBe(
      false,
    );
  });

  function handlers() {
    return {
      accept: vi.fn(),
      dismiss: vi.fn(),
      resolve: vi.fn(),
      remove: vi.fn(),
    };
  }

  it("dispatches to resolve only, and still works while the AI is off", () => {
    const h = handlers();
    runAnnotationAction("ctx:annotation:resolve", ann("comment", "user"), h, true);
    expect(h.resolve).toHaveBeenCalledWith("a1");
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("re-validates against the live record", () => {
    const h = handlers();
    for (const a of [
      ann("comment", "claude"),
      ann("note", "user"),
      ann("highlight", "user"),
      ann("comment", "user", "dismissed"),
    ]) {
      runAnnotationAction("ctx:annotation:resolve", a, h, false);
    }
    expect(h.resolve).not.toHaveBeenCalled();
  });
});

describe("AnnotationCardActions: Resolve + Remove branch", () => {
  function mount(props: Record<string, unknown> = {}) {
    const onResolve = vi.fn();
    const onRemove = vi.fn();
    const r = render(AnnotationCardActions, {
      props: {
        annotationId: "u1",
        annotationType: "comment",
        isPending: true,
        isEditing: false,
        onResolve,
        onRemove,
        aiDisabled: false,
        ...props,
      },
    });
    return { ...r, onResolve, onRemove };
  }

  it("renders both buttons; each click calls only its own handler", async () => {
    const { container, unmount, onResolve, onRemove } = mount();
    const resolve = byTestId(container, "resolve-btn-u1");
    const remove = byTestId(container, "remove-btn-u1");
    expect(resolve?.textContent?.trim()).toBe("Resolve");
    expect(remove?.textContent?.trim()).toBe("Remove");
    resolve?.click();
    await tick();
    expect(onResolve).toHaveBeenCalledWith("u1");
    expect(onRemove).not.toHaveBeenCalled();
    remove?.click();
    await tick();
    expect(onRemove).toHaveBeenCalledWith("u1");
    expect(onResolve).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("Remove alone (no onResolve) is the unchanged standalone button", () => {
    const { container, unmount } = mount({ onResolve: undefined });
    expect(byTestId(container, "resolve-btn-u1")).toBeNull();
    expect(byTestId(container, "remove-btn-u1")).not.toBeNull();
    unmount();
  });

  it("is not offered while editing or once resolved", () => {
    for (const p of [{ isEditing: true }, { isPending: false }]) {
      const { container, unmount } = mount(p);
      expect(byTestId(container, "resolve-btn-u1")).toBeNull();
      unmount();
    }
  });

  it("a resolved card shows Remove with no Undo, and it calls only onRemove", async () => {
    const { container, unmount, onRemove } = mount({ isPending: false, onResolve: undefined });
    expect(byTestId(container, "undo-btn")).toBeNull();
    const remove = byTestId(container, "remove-btn-u1");
    expect(remove?.getAttribute("aria-label")).toBe("Remove comment and its replies");
    remove?.click();
    await tick();
    expect(onRemove).toHaveBeenCalledWith("u1");
    unmount();
  });

  it("while undoable, Undo and Remove share one row, Undo first", async () => {
    const onUndo = vi.fn(() => true);
    const { container, unmount, onRemove } = mount({
      isPending: false,
      onResolve: undefined,
      undoable: true,
      onUndo,
    });
    const undo = byTestId(container, "undo-btn");
    const remove = byTestId(container, "remove-btn-u1");
    expect(undo?.parentElement).toBe(remove?.parentElement);
    expect(undo?.compareDocumentPosition(remove as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    undo?.click();
    await tick();
    expect(onUndo).toHaveBeenCalledWith("u1");
    expect(onRemove).not.toHaveBeenCalled();
    unmount();
  });

  it("a resolved card without onRemove keeps the Undo-only row", () => {
    const { container, unmount } = mount({
      isPending: false,
      onResolve: undefined,
      onRemove: undefined,
      undoable: true,
      onUndo: vi.fn(() => true),
    });
    expect(byTestId(container, "undo-btn")).not.toBeNull();
    expect(byTestId(container, "remove-btn-u1")).toBeNull();
    unmount();
  });

  it("a note still takes the note branch even if a caller passes onResolve", () => {
    const { container, unmount } = mount({ annotationType: "note", onSendToClaude: vi.fn() });
    expect(byTestId(container, "archive-btn-u1")).not.toBeNull();
    expect(byTestId(container, "resolve-btn-u1")).toBeNull();
    unmount();
  });
});

describe("a resolved user comment reads Resolved, not Dismissed", () => {
  it("displayStatus: user + dismissed (not by Claude) is 'resolved'; everything else is raw", () => {
    expect(displayStatus(ann("comment", "user", "dismissed"))).toBe("resolved");
    expect(displayStatus(ann("comment", "claude", "dismissed"))).toBe("dismissed");
    expect(displayStatus(ann("comment", "user", "accepted"))).toBe("accepted");
    expect(displayStatus(ann("comment", "user"))).toBe("pending");
    // Claude dismissing the user's comment must not read as the user's own action.
    expect(
      displayStatus(ann("comment", "user", "dismissed", { resolvedBy: "claude" } as never)),
    ).toBe("dismissed");
  });

  it("the screen-reader label agrees with the visible pill", () => {
    expect(getCardLabel(ann("comment", "user", "dismissed"))).toMatch(/resolved$/);
    expect(getCardLabel(ann("comment", "claude", "dismissed"))).toMatch(/dismissed$/);
  });

  function pill(a: Annotation) {
    const r = render(AnnotationCard, { props: { annotation: a, aiDisabled: false } });
    const el = r.container.querySelector<HTMLElement>(".ach-status");
    return { ...r, el };
  }

  it("neutral pill for the user's, red pill for Claude's", () => {
    const user = pill(ann("comment", "user", "dismissed"));
    expect(user.el?.textContent?.trim()).toBe("resolved");
    expect(user.el?.classList.contains("is-rejected")).toBe(false);
    expect(user.el?.classList.contains("is-accepted")).toBe(false);
    user.unmount();

    const claude = pill(ann("comment", "claude", "dismissed"));
    expect(claude.el?.textContent?.trim()).toBe("dismissed");
    expect(claude.el?.classList.contains("is-rejected")).toBe(true);
    claude.unmount();
  });
});
