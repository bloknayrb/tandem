// @vitest-environment happy-dom

/**
 * The two annotation surfaces with the licence off (#1521): `SidePanel` (the
 * right rail) and `MarginColumn` (the margin view) each derive `aiDisabled`
 * from `licenseStore.ui.aiOff` themselves and hand it to the cards, the
 * native annotation context menu and the action dispatcher. The leaf
 * components are pinned in `ai-off-controls.test.ts`; these pin that each
 * panel actually reads the licence and passes it on.
 *
 * Every assertion has a licence-on twin, so a panel that hard-codes
 * `aiDisabled` either way goes red.
 *
 * The Tauri runtime is faked: `__TAURI_INTERNALS__` on the happy-dom window
 * makes `isTauriRuntime()` true, `@tauri-apps/api/core`'s `invoke` records the
 * menu request, and `@tauri-apps/api/event`'s `listen` captures the handler so
 * a test can fire a menu action as the native menu would.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Annotation } from "../../src/shared/types";
import { range } from "../helpers/positions";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

let menuHandler: ((e: { payload?: { id?: string } }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (e: { payload?: { id?: string } }) => void) => {
    menuHandler = handler;
    return Promise.resolve(() => {});
  }),
}));

// Hand-stubbed rather than `importOriginal`: the panel must bind these stubs,
// not the real functions behind a spy.
const sendNoteToClaude = vi.fn();
const promoteNotesToComments = vi.fn();
vi.mock("../../src/client/panels/annotation-actions", () => ({
  heldInSoloOnCreate: vi.fn(() => false),
  editAnnotation: vi.fn(),
  sendNoteToClaude,
  promoteNotesToComments,
  removeAnnotation: vi.fn(async () => {}),
  replyToAnnotation: vi.fn(async () => true),
}));

const { licenseStore } = await import("../../src/client/hooks/useLicense.svelte");
const { __resetAnnotationContextMenuHostForTest } = await import(
  "../../src/client/panels/annotation-context-menu-host"
);
const { default: SidePanel } = await import("../../src/client/panels/SidePanel.svelte");
const { default: MarginColumn } = await import("../../src/client/panels/MarginColumn.svelte");

const RESTRICTED = { gateActive: true, status: "restricted", updateWindowCurrent: false } as const;
const DARK = { gateActive: false, status: "trial", updateWindowCurrent: false } as const;

function ann(id: string, author: Annotation["author"], type: Annotation["type"]): Annotation {
  return {
    id,
    author,
    type,
    range: range(0, 5),
    content: `${type} ${id}`,
    status: "pending",
    timestamp: 1_700_000_000_000,
    ...(author === "import" ? { importSource: { author: "Alice", file: "/t.docx" } } : {}),
  } as Annotation;
}

const NOTE = ann("n1", "user", "note");
const COMMENT = ann("c1", "claude", "comment");
const IMPORTED = ann("i1", "import", "note");

const byTestId = <T extends HTMLElement = HTMLButtonElement>(c: HTMLElement, id: string) =>
  c.querySelector<T>(`[data-testid='${id}']`);

/** Right-click a card and return the `show_annotation_context_menu` request. */
async function menuRequestFor(container: HTMLElement, id: string) {
  invoke.mockClear();
  // Right-click INSIDE the card (its Reply button), so the event bubbles through
  // the card to the panel's listener. MarginColumn's leader paths carry
  // `data-annotation-id` too, but sit outside its column element.
  const card = container.querySelector(`[data-testid='reply-btn-${id}']`);
  if (!card) throw new Error(`no card ${id}`);
  await fireEvent.contextMenu(card);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  const [cmd, args] = invoke.mock.calls[0] as unknown as [string, { req: Record<string, boolean> }];
  expect(cmd).toBe("show_annotation_context_menu");
  return args.req;
}

/** Fire a menu action as the native menu would, for the last right-clicked card. */
async function fireMenuAction(id: string): Promise<void> {
  await vi.waitFor(() => expect(menuHandler).not.toBeNull());
  menuHandler?.({ payload: { id } });
  await tick();
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  menuHandler = null;
  invoke.mockClear();
  sendNoteToClaude.mockClear();
  promoteNotesToComments.mockClear();
  __resetAnnotationContextMenuHostForTest();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  // The store is a module singleton: put it back to "gate off" for the next test.
  licenseStore.set(DARK);
});

function mountSidePanel(annotations: Annotation[]) {
  return render(SidePanel, {
    props: {
      annotations,
      editor: null,
      ydoc: new Y.Doc(),
      documentId: "doc-a",
      activeAnnotationId: null,
      // happy-dom's WAAPI aborts a cancelled transition as an unhandled error.
      reduceMotion: true,
      onActiveAnnotationChange: vi.fn(),
      review: {
        resolveAnnotation: vi.fn(),
        acceptReplySuggestion: vi.fn(),
        undoResolveAnnotation: vi.fn(() => false),
        handleAccept: vi.fn(),
        handleDismiss: vi.fn(),
        scrollToAnnotation: vi.fn(),
        getRecentlyResolved: () => new Set<string>(),
        getReviewIndex: () => 0,
        getReviewTargets: () => [],
        isTargetLost: () => false,
      },
    },
  });
}

describe.each([
  { licence: "off", status: RESTRICTED, aiOff: true },
  { licence: "on (twin)", status: DARK, aiOff: false },
])("SidePanel with the licence $licence", ({ status, aiOff }) => {
  beforeEach(() => licenseStore.set(status));

  it("Send to Claude is present and disabled only while off", async () => {
    const { container } = mountSidePanel([NOTE, COMMENT]);
    await tick();
    const send = byTestId(container, "send-to-claude-btn-n1");
    expect(send).not.toBeNull();
    expect(send?.disabled).toBe(aiOff);
  });

  it("a comment's reply follows the licence; a note's reply stays enabled", async () => {
    const { container } = mountSidePanel([NOTE, COMMENT]);
    await tick();
    expect(byTestId(container, "reply-btn-c1")?.disabled).toBe(aiOff);
    expect(byTestId(container, "reply-btn-n1")?.disabled).toBe(false);
  });

  it("the context menu request carries the licence for a comment and a note", async () => {
    const { container } = mountSidePanel([NOTE, COMMENT]);
    await tick();
    const commentReq = await menuRequestFor(container, "c1");
    expect(commentReq.canReply).toBe(!aiOff);
    expect(commentReq.canSendToClaude).toBe(false); // never offered on a comment
    const noteReq = await menuRequestFor(container, "n1");
    expect(noteReq.canSendToClaude).toBe(!aiOff);
    expect(noteReq.canReply).toBe(true); // a note's own thread stays live
  });

  it("a dispatched sendToClaude reaches the handler only while on", async () => {
    const { container } = mountSidePanel([NOTE, COMMENT]);
    await tick();
    await menuRequestFor(container, "n1");
    await fireMenuAction("ctx:annotation:sendToClaude");
    if (aiOff) expect(sendNoteToClaude).not.toHaveBeenCalled();
    else expect(sendNoteToClaude).toHaveBeenCalledTimes(1);
  });

  it("batch promote is disabled and refuses while off; promotes while on", async () => {
    const { container } = mountSidePanel([IMPORTED]);
    await tick();
    const box = container.querySelector<HTMLInputElement>(
      "[data-testid='annotation-select-checkbox-i1']",
    );
    expect(box).not.toBeNull();
    if (box) await fireEvent.click(box);
    await tick();
    const request = byTestId(container, "batch-promote-confirm");
    expect(request?.disabled).toBe(aiOff);
    // happy-dom never dispatches a click on a disabled button, so strip it: the
    // handler's own guard is what must refuse.
    if (request) request.disabled = false;
    request?.click();
    await tick();
    const commit = byTestId(container, "batch-promote-commit");
    if (aiOff) {
      expect(commit).toBeNull();
    } else {
      commit?.click();
      await tick();
    }
    expect(promoteNotesToComments).toHaveBeenCalledTimes(aiOff ? 0 : 1);
  });
});

function mountMarginColumn(annotations: Annotation[]) {
  const onSendToClaude = vi.fn();
  const onReply = vi.fn(async () => true);
  const r = render(MarginColumn, {
    props: {
      annotations,
      isTargetLost: () => false,
      positions: new Map(annotations.map((a, i) => [a.id, 100 + i * 120])),
      side: "right",
      mode: "full",
      width: 240,
      edgeInset: 8,
      gap: 24,
      activeAnnotationId: null,
      repliesById: new Map(),
      onClick: () => {},
      reduceMotion: true,
      onSendToClaude,
      onReply,
    },
  });
  return { ...r, onSendToClaude };
}

describe.each([
  { licence: "off", status: RESTRICTED, aiOff: true },
  { licence: "on (twin)", status: DARK, aiOff: false },
])("MarginColumn with the licence $licence", ({ status, aiOff }) => {
  beforeEach(() => licenseStore.set(status));

  it("Send to Claude and a comment's reply follow the licence; a note's reply does not", async () => {
    const { container } = mountMarginColumn([NOTE, COMMENT]);
    await tick();
    const send = byTestId(container, "send-to-claude-btn-n1");
    expect(send).not.toBeNull();
    expect(send?.disabled).toBe(aiOff);
    expect(byTestId(container, "reply-btn-c1")?.disabled).toBe(aiOff);
    expect(byTestId(container, "reply-btn-n1")?.disabled).toBe(false);
  });

  it("the context menu request and the dispatched sendToClaude follow the licence", async () => {
    const { container, onSendToClaude } = mountMarginColumn([NOTE, COMMENT]);
    await tick();
    const commentReq = await menuRequestFor(container, "c1");
    expect(commentReq.canReply).toBe(!aiOff);
    expect(commentReq.canSendToClaude).toBe(false);
    const noteReq = await menuRequestFor(container, "n1");
    expect(noteReq.canSendToClaude).toBe(!aiOff);
    await fireMenuAction("ctx:annotation:sendToClaude");
    expect(onSendToClaude).toHaveBeenCalledTimes(aiOff ? 0 : 1);
  });
});
