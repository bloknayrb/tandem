// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import FormattingToolbar from "../../src/client/editor/toolbar/FormattingToolbar.svelte";

/**
 * #1313 — the heading dropdown's guarded focus restore must actually restore.
 *
 * `closeHeadingMenu` exists so focus never strands on `<body>` when the focused
 * menu item unmounts. It did strand, and the reason is an ORDERING one that is
 * invisible in the component's own source: `editor.commands.focus()` does not
 * focus. Tiptap's `focus` command schedules `view.focus()` inside a
 * `requestAnimationFrame` (see `delayedFocus` in @tiptap/core), while Svelte
 * removes the menu on the MICROTASK flush — which lands first. So the sequence
 * was: focused item unmounts → browser drops focus to `<body>` → a whole frame
 * later the editor is focused. A frame is not nothing: a hidden or throttled
 * tab never runs the callback at all, and every probe that looks before the
 * next vsync sees `<body>`.
 *
 * The fix is `editor.view.focus()` — ProseMirror's own synchronous focus, which
 * lands BEFORE the unmount, so the item that unmounts is no longer the focused
 * one and there is no drop to `<body>` to recover from.
 *
 * These assertions therefore deliberately drain only MICROTASKS (which is what
 * `fireEvent`'s awaited `tick()` does) and never wait for an animation frame.
 * Waiting a frame would make them pass against the unfixed code.
 */

const mounted: Array<{ editor: Editor; container: HTMLElement }> = [];

function makeEditor(): Editor {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit],
    content: "<p>hello world</p>",
  });
  mounted.push({ editor, container: host });
  return editor;
}

afterEach(() => {
  for (const { editor, container } of mounted) {
    editor.destroy();
    container.remove();
  }
  mounted.length = 0;
  document.body.innerHTML = "";
});

/** Open the heading menu the way a keyboard user does: a `detail === 0` click. */
async function openHeadingMenu(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  expect(trigger, "heading trigger must exist").not.toBeNull();
  await fireEvent.click(trigger as Element, { detail: 0 });
  // The focus-in effect (#1303) runs on the flush `fireEvent` already awaited.
  expect(container.querySelector('[role="menu"]'), "menu must be open").not.toBeNull();
  expect(
    (document.activeElement as HTMLElement | null)?.getAttribute("role"),
    "focus must be on a menu item before we close it",
  ).toBe("menuitemradio");
}

describe("heading menu — focus restore on close (#1313)", () => {
  it("Escape returns focus to the editor without waiting for an animation frame", async () => {
    const editor = makeEditor();
    const { container } = render(FormattingToolbar, { props: { editor } });
    document.body.appendChild(container);

    await openHeadingMenu(container);

    await fireEvent.keyDown(document.activeElement as Element, {
      key: "Escape",
      bubbles: true,
    });

    expect(container.querySelector('[role="menu"]'), "menu must be closed").toBeNull();
    expect(document.activeElement, "focus must not strand on <body>").not.toBe(document.body);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("outside mousedown from inside the menu restores the editor on the same flush", async () => {
    const editor = makeEditor();
    const { container } = render(FormattingToolbar, { props: { editor } });
    document.body.appendChild(container);

    await openHeadingMenu(container);

    // `clickOutside` listens for mousedown on `document`. Post-#1303 focus is
    // inside the menu on the mouse path too, so this takes the same restoring
    // branch as Escape.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    await fireEvent.mouseDown(outside);

    expect(container.querySelector('[role="menu"]'), "menu must be closed").toBeNull();
    expect(document.activeElement, "focus must not strand on <body>").not.toBe(document.body);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("does not yank focus into the editor when the user has already moved elsewhere", async () => {
    const editor = makeEditor();
    const { container } = render(FormattingToolbar, { props: { editor } });
    document.body.appendChild(container);

    await openHeadingMenu(container);

    // The guard's whole point: `clickOutside` fires on mousedown, and if the
    // user is on their way somewhere else the restore must stay out of it.
    // A synchronous editor focus makes this MORE important, not less — it can
    // no longer be lost to a later frame.
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await fireEvent.mouseDown(elsewhere);

    expect(container.querySelector('[role="menu"]'), "menu must be closed").toBeNull();
    expect(document.activeElement, "restore must not have run").toBe(elsewhere);
  });
});
