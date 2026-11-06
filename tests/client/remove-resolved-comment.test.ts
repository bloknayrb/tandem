// @vitest-environment happy-dom

/**
 * Remove on the user's resolved comments, and the inline confirm (#2360 follow-up).
 *
 * After a reload a resolved comment had no action at all: Undo's window was gone and
 * Remove was pending-only. Bryan chose "allow remove" (2026-11-05), then, because
 * Remove sweeps every reply (Claude's included) with no undo, "yes, inline
 * confirmation": a comment with replies asks once, in place, before it goes.
 *
 * Auto-cleanup never registers in this repo's client project, so each render is
 * unmounted explicitly and queries are scoped to the container.
 */

import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("../../src/client/panels/annotation-actions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/client/panels/annotation-actions")>();
  return { ...real, removeAnnotation: vi.fn(async () => true) };
});

import AnnotationCardActions from "../../src/client/panels/AnnotationCardActions.svelte";
import { removeAnnotation } from "../../src/client/panels/annotation-actions";
import {
  buildAnnotationMenuContext,
  needsRemoveConfirm,
} from "../../src/client/panels/annotation-context-menu";
import { runAnnotationAction } from "../../src/client/panels/annotation-context-menu-host";
import SidePanel from "../../src/client/panels/SidePanel.svelte";
import type { UseAnnotationReviewReturn } from "../../src/client/panels/useAnnotationReview.svelte";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants";
import type { Annotation, AnnotationStatus } from "../../src/shared/types";
import { range } from "../helpers/positions";

function ann(
  type: Annotation["type"],
  author: Annotation["author"],
  status: AnnotationStatus = "pending",
  id = "a1",
): Annotation {
  return {
    id,
    author,
    range: range(0, 1),
    content: "body",
    status,
    timestamp: 0,
    type,
  } as Annotation;
}

const byTestId = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);

describe("needsRemoveConfirm", () => {
  it("is true only for a comment that has replies", () => {
    expect(needsRemoveConfirm(ann("comment", "user"), 1)).toBe(true);
    expect(needsRemoveConfirm(ann("comment", "user"), 0)).toBe(false);
    expect(needsRemoveConfirm(ann("highlight", "user"), 3)).toBe(false);
    expect(needsRemoveConfirm(ann("note", "user"), 3)).toBe(false);
  });
});

describe("native menu: a threaded comment's Remove goes through the card only", () => {
  it("the menu leaves Remove out when the comment has replies", () => {
    const open = ann("comment", "user");
    const resolved = ann("comment", "user", "dismissed");
    expect(buildAnnotationMenuContext(open, false, false, 0).canRemove).toBe(true);
    expect(buildAnnotationMenuContext(open, false, false, 2).canRemove).toBe(false);
    expect(buildAnnotationMenuContext(resolved, false, false, 0).canRemove).toBe(true);
    expect(buildAnnotationMenuContext(resolved, false, false, 1).canRemove).toBe(false);
  });

  it("a menu held open while a reply arrived is refused at dispatch", () => {
    const remove = vi.fn();
    runAnnotationAction("ctx:annotation:remove", ann("comment", "user"), { remove }, false, 1);
    expect(remove).not.toHaveBeenCalled();
    runAnnotationAction("ctx:annotation:remove", ann("comment", "user"), { remove }, false, 0);
    expect(remove).toHaveBeenCalledWith("a1");
  });
});

describe("AnnotationCardActions: inline confirm", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mount(props: Record<string, unknown> = {}) {
    const onRemove = vi.fn();
    const r = render(AnnotationCardActions, {
      props: {
        annotationId: "u1",
        annotationType: "comment",
        isPending: true,
        isEditing: false,
        onResolve: vi.fn(),
        onRemove,
        aiDisabled: false,
        confirmRemove: true,
        ...props,
      },
    });
    return { ...r, onRemove };
  }

  it.each([
    ["open comment (Resolve + Remove row)", {}],
    ["resolved comment", { isPending: false, onResolve: undefined }],
    ["standalone Remove", { onResolve: undefined }],
  ])("%s: first click arms, second deletes", async (_name, props) => {
    const { container, unmount, onRemove } = mount(props);
    const btn = () => byTestId(container, "remove-btn-u1");
    expect(btn()?.textContent?.trim()).toBe("Remove");
    btn()?.click();
    await tick();
    expect(onRemove).not.toHaveBeenCalled();
    expect(btn()?.textContent?.trim()).toBe("Delete thread?");
    expect(btn()?.getAttribute("aria-label")).toMatch(/activate again/i);
    vi.advanceTimersByTime(500); // past the double-click guard
    btn()?.click();
    await tick();
    expect(onRemove).toHaveBeenCalledWith("u1");
    unmount();
  });

  it("a double-click (or key repeat) arms but does not delete", async () => {
    const { container, unmount, onRemove } = mount();
    const btn = () => byTestId(container, "remove-btn-u1");
    btn()?.click();
    await tick();
    btn()?.click(); // same instant: under the minimum gap
    await tick();
    await fireEvent.click(btn() as HTMLElement, { detail: 2 });
    expect(onRemove).not.toHaveBeenCalled();
    expect(btn()?.textContent?.trim()).toBe("Delete thread?");
    unmount();
  });

  it("Escape and blur disarm", async () => {
    const { container, unmount, onRemove } = mount();
    const btn = () => byTestId(container, "remove-btn-u1");
    btn()?.click();
    await tick();
    await fireEvent.keyDown(btn() as HTMLElement, { key: "Escape" });
    expect(btn()?.textContent?.trim()).toBe("Remove");
    btn()?.click();
    await tick();
    await fireEvent.blur(btn() as HTMLElement);
    expect(btn()?.textContent?.trim()).toBe("Remove");
    expect(onRemove).not.toHaveBeenCalled();
    unmount();
  });

  it("the armed state is announced, and the name keeps the visible text", async () => {
    const { container, unmount } = mount();
    const status = container.querySelector("[role='status']");
    expect(status?.textContent?.trim()).toBe("");
    byTestId(container, "remove-btn-u1")?.click();
    await tick();
    expect(status?.textContent).toMatch(/again to delete/);
    expect(byTestId(container, "remove-btn-u1")?.getAttribute("aria-label")).toMatch(
      /^Delete thread\?/,
    );
    unmount();
  });

  it("disarms on its own after a few seconds, so a late click only arms again", async () => {
    const { container, unmount, onRemove } = mount();
    const btn = () => byTestId(container, "remove-btn-u1");
    btn()?.click();
    await tick();
    vi.advanceTimersByTime(5000);
    await tick();
    expect(btn()?.textContent?.trim()).toBe("Remove");
    btn()?.click();
    await tick();
    expect(onRemove).not.toHaveBeenCalled();
    unmount();
  });

  it("without replies, one click removes", async () => {
    const { container, unmount, onRemove } = mount({ confirmRemove: false });
    byTestId(container, "remove-btn-u1")?.click();
    await tick();
    expect(onRemove).toHaveBeenCalledWith("u1");
    unmount();
  });
});

describe("SidePanel: the resolved list offers Remove, and Remove forgets the resolve", () => {
  function makeReview(): UseAnnotationReviewReturn {
    return {
      resolveAnnotation: vi.fn(),
      acceptReplySuggestion: vi.fn(),
      undoResolveAnnotation: vi.fn(() => false),
      handleAccept: vi.fn(),
      handleDismiss: vi.fn(),
      scrollToAnnotation: vi.fn(),
      getRecentlyResolved: () => new Set<string>(),
      forgetResolved: vi.fn(),
      getReviewIndex: () => 0,
      getReviewTargets: () => [],
      isTargetLost: () => false,
    };
  }

  it("a resolved user comment renders Remove; clicking it removes and forgets the id", async () => {
    const review = makeReview();
    const resolved = ann("comment", "user", "dismissed", "r1");
    const { container, unmount } = render(SidePanel, {
      props: {
        annotations: [resolved],
        editor: null,
        ydoc: new Y.Doc(),
        documentId: "doc-a",
        activeAnnotationId: null,
        onActiveAnnotationChange: vi.fn(),
        review,
      },
    });
    const summary = container.querySelector<HTMLElement>("details summary");
    expect(summary, "the resolved list renders").not.toBeNull();
    await fireEvent.click(summary as HTMLElement);
    await tick();
    const remove = byTestId(container, "remove-btn-r1");
    expect(remove, "a resolved user comment offers Remove").not.toBeNull();
    remove?.click();
    await tick();
    expect(removeAnnotation).toHaveBeenCalledWith("r1", "doc-a");
    await vi.waitFor(() => expect(review.forgetResolved).toHaveBeenCalledWith("r1"));
    unmount();
  });

  it("a failed remove keeps the id (and so its Undo)", async () => {
    vi.mocked(removeAnnotation).mockResolvedValueOnce(false);
    const review = makeReview();
    const { container, unmount } = render(SidePanel, {
      props: {
        annotations: [ann("comment", "user", "dismissed", "r2")],
        editor: null,
        ydoc: new Y.Doc(),
        documentId: "doc-a",
        activeAnnotationId: null,
        onActiveAnnotationChange: vi.fn(),
        review,
      },
    });
    await fireEvent.click(container.querySelector<HTMLElement>("details summary") as HTMLElement);
    await tick();
    byTestId(container, "remove-btn-r2")?.click();
    await tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(review.forgetResolved).not.toHaveBeenCalled();
    unmount();
  });

  // The count reaches the card from the panel's own replies map: drop
  // `confirmRemove={needsRemoveConfirm(...)}` from AnnotationCard and this reds.
  it.each([
    ["resolved", "dismissed" as AnnotationStatus],
    ["closed by an accepted rewrite", "accepted" as AnnotationStatus],
    ["open", "pending" as AnnotationStatus],
  ])("a %s user comment with a reply arms first instead of removing", async (_n, status) => {
    vi.mocked(removeAnnotation).mockClear();
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("rep1", {
      id: "rep1",
      annotationId: "t1",
      author: "claude",
      text: "an answer",
      timestamp: 1,
    });
    const { container, unmount } = render(SidePanel, {
      props: {
        annotations: [ann("comment", "user", status, "t1")],
        editor: null,
        ydoc,
        documentId: "doc-a",
        activeAnnotationId: null,
        onActiveAnnotationChange: vi.fn(),
        review: makeReview(),
      },
    });
    const summary = container.querySelector<HTMLElement>("details summary");
    if (status !== "pending") await fireEvent.click(summary as HTMLElement);
    await tick();
    const btn = byTestId(container, "remove-btn-t1");
    expect(btn, "Remove renders").not.toBeNull();
    btn?.click();
    await tick();
    expect(removeAnnotation).not.toHaveBeenCalled();
    expect(byTestId(container, "remove-btn-t1")?.textContent?.trim()).toBe("Delete thread?");
    unmount();
  });

  it("a resolved Claude comment still offers no Remove", async () => {
    const { container, unmount } = render(SidePanel, {
      props: {
        annotations: [ann("comment", "claude", "dismissed", "c1")],
        editor: null,
        ydoc: new Y.Doc(),
        documentId: "doc-a",
        activeAnnotationId: null,
        onActiveAnnotationChange: vi.fn(),
        review: makeReview(),
      },
    });
    const summary = container.querySelector<HTMLElement>("details summary");
    await fireEvent.click(summary as HTMLElement);
    await tick();
    expect(
      container.querySelector("[data-annotation-id='c1']"),
      "sanity: card renders",
    ).not.toBeNull();
    expect(byTestId(container, "remove-btn-c1")).toBeNull();
    unmount();
  });
});
