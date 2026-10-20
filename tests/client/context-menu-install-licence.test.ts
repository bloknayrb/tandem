// @vitest-environment happy-dom

/**
 * `installContextMenu` carries the licence (#1521) from a LIVE getter to both
 * ends of the native editor menu: the `show_context_menu` request built at the
 * right-click, and the action dispatch when the menu item fires. A value
 * captured at install would leave a menu reflecting the licence of the moment
 * the document opened, so each assertion flips the getter and looks again.
 *
 * `detect.ts` and `dispatch.ts` are covered on their own in
 * `context-menu.test.ts`; this pins the wiring between them. The editor is a
 * stub with only what `install.ts` touches; the Tauri runtime is faked as in
 * `annotation-context-menu-host.test.ts`.
 */

import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

let actionHandler: ((e: { payload?: { id?: string } }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (e: { payload?: { id?: string } }) => void) => {
    actionHandler = handler;
    return Promise.resolve(() => {});
  }),
}));

const { installContextMenu } = await import("../../src/client/editor/context-menu/install");

function stubEditor(): { editor: Editor; target: HTMLElement } {
  const dom = document.createElement("div");
  const target = document.createElement("p");
  target.textContent = "some text";
  dom.appendChild(target);
  document.body.appendChild(dom);
  // A live, non-empty selection, so the Ask-AI and comment arms are reachable.
  const selection = { from: 1, to: 5, empty: false, eq: (o: unknown) => o === selection };
  const editor = {
    view: { dom, posAtCoords: () => null, focus: vi.fn() },
    state: { selection },
    isEditable: true,
    isDestroyed: false,
    commands: { setTextSelection: vi.fn() },
    can: () => ({}),
  } as unknown as Editor;
  return { editor, target };
}

async function rightClick(target: HTMLElement): Promise<Record<string, unknown>> {
  invoke.mockClear();
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  const [cmd, args] = invoke.mock.calls[0] as unknown as [string, { req: Record<string, unknown> }];
  expect(cmd).toBe("show_context_menu");
  return args.req;
}

async function fireAction(id: string): Promise<void> {
  await vi.waitFor(() => expect(actionHandler).not.toBeNull());
  actionHandler?.({ payload: { id } });
  await Promise.resolve();
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  actionHandler = null;
  invoke.mockClear();
});

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.replaceChildren();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("installContextMenu — the licence getter", () => {
  it("is read at each right-click: the request's aiDisabled follows a flip", async () => {
    let aiDisabled = true;
    const { editor, target } = stubEditor();
    teardown = installContextMenu(editor, {
      openHref: vi.fn(),
      isAiDisabled: () => aiDisabled,
      platform: "windows",
    });

    expect((await rightClick(target)).aiDisabled).toBe(true);
    aiDisabled = false;
    expect((await rightClick(target)).aiDisabled).toBe(false);
  });

  it("reaches the dispatch: Ask AI and Comment refuse while off and run once on", async () => {
    let aiDisabled = true;
    const focusChat = vi.fn();
    const composeAnnotation = vi.fn();
    const { editor, target } = stubEditor();
    teardown = installContextMenu(editor, {
      openHref: vi.fn(),
      focusChat,
      composeAnnotation,
      isAiDisabled: () => aiDisabled,
      platform: "windows",
    });
    await rightClick(target);

    await fireAction("ctx:selection:askAi");
    await fireAction("ctx:selection:comment");
    expect(focusChat).not.toHaveBeenCalled();
    expect(composeAnnotation).not.toHaveBeenCalled();

    // A private note is not an AI action: it runs while off (positive control).
    await fireAction("ctx:selection:privateNote");
    expect(composeAnnotation).toHaveBeenCalledWith("note");

    aiDisabled = false;
    await fireAction("ctx:selection:askAi");
    await fireAction("ctx:selection:comment");
    expect(focusChat).toHaveBeenCalledTimes(1);
    expect(composeAnnotation).toHaveBeenCalledWith("comment");
  });
});
