// @vitest-environment happy-dom

/**
 * #1777 item 3 — six Enter handlers ignored IME composition.
 *
 * A CJK / Vietnamese / Korean user confirms an IME candidate with Enter. That
 * keydown carries `isComposing: true` (and, on Safari and some IMEs, arrives
 * with `isComposing` already false but `keyCode === 229`). Before the guard,
 * every one of these six handlers read it as a submit: a half-converted chat
 * message was sent, a link applied, a tab renamed mid-candidate.
 *
 * Each handler gets BOTH polarities. The composing case alone is satisfied by a
 * guard that returns unconditionally — the paired `isComposing: false` positive
 * is what proves the handler still works.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/editor/extensions/find-replace.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFindState: () => ({ matches: [{ from: 1, to: 2 }], activeIndex: 0 }),
  replaceActive: vi.fn(),
  replaceAll: vi.fn(async () => ({ replaced: 1, partial: false })),
}));

import CommandPalette from "../../src/client/components/CommandPalette.svelte";
import OutlinePanel from "../../src/client/components/OutlinePanel.svelte";
import FindReplaceBar from "../../src/client/editor/find-replace/FindReplaceBar.svelte";
import LinkEditor from "../../src/client/editor/toolbar/LinkEditor.svelte";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import TabRenameInput from "../../src/client/tabs/TabRenameInput.svelte";

afterEach(cleanup);

/** The confirm keydown an IME delivers, in its two observed shapes. */
const COMPOSING = { key: "Enter", isComposing: true, keyCode: 13 };
/** Safari / some IMEs: composition already ended, only the 229 sentinel left. */
const SAFARI_CONFIRM = { key: "Enter", isComposing: false, keyCode: 229 };
const REAL_ENTER = { key: "Enter", isComposing: false, keyCode: 13 };

function q(root: ParentNode, testid: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid='${testid}']`);
  if (!el) throw new Error(`no [data-testid='${testid}'] in the rendered tree`);
  return el;
}

/** Minimal editor surface FindReplaceBar / OutlinePanel touch. */
function editorStub() {
  return {
    state: {},
    // A real node: OutlinePanel's scroll-spy effect walks `view.dom.closest(...)`.
    view: { dom: document.createElement("div") },
    isDestroyed: false,
    on: vi.fn(),
    off: vi.fn(),
    commands: {
      find: vi.fn(),
      findClose: vi.fn(),
      findNext: vi.fn(),
      findPrev: vi.fn(),
    },
  } as unknown as import("@tiptap/core").Editor;
}

function renderChat(onSend: () => boolean) {
  return render(ChatPanel, {
    props: {
      messages: [],
      editor: null,
      activeDocId: null,
      openDocs: [],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
      onSend,
      onClear: async () => {},
      onExport: async () => {},
      onInsert: () => false,
    },
  });
}

describe("ChatPanel — Enter mid-composition does not send (#1777)", () => {
  it("holds the message while composing", async () => {
    const onSend = vi.fn(() => true);
    const { container } = renderChat(onSend);
    const input = q(container, "chat-composer-input") as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "こんにち" } });
    await fireEvent.keyDown(input, COMPOSING);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("holds the message on the Safari keyCode-229 confirm", async () => {
    const onSend = vi.fn(() => true);
    const { container } = renderChat(onSend);
    const input = q(container, "chat-composer-input") as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "こんにち" } });
    await fireEvent.keyDown(input, SAFARI_CONFIRM);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends on a real Enter", async () => {
    const onSend = vi.fn(() => true);
    const { container } = renderChat(onSend);
    const input = q(container, "chat-composer-input") as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "hello" } });
    await fireEvent.keyDown(input, REAL_ENTER);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe("LinkEditor — Enter mid-composition does not apply (#1777)", () => {
  it("holds while composing, applies on a real Enter", async () => {
    const onApply = vi.fn();
    const { container } = render(LinkEditor, {
      props: { open: true, initialValue: "https://a.example", onApply, onClose: vi.fn() },
    });
    const input = q(container, "toolbar-link-input");
    await fireEvent.keyDown(input, COMPOSING);
    expect(onApply).not.toHaveBeenCalled();

    await fireEvent.keyDown(input, REAL_ENTER);
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});

describe("FindReplaceBar — Enter mid-composition does not search (#1777)", () => {
  it("holds while composing, searches on a real Enter", async () => {
    const editor = editorStub();
    const { container } = render(FindReplaceBar, {
      props: { editor, open: true, onClose: vi.fn() },
    });
    const bar = q(container, "find-replace-bar");
    await fireEvent.keyDown(bar, COMPOSING);
    expect(editor.commands.findNext).not.toHaveBeenCalled();

    await fireEvent.keyDown(bar, REAL_ENTER);
    expect(editor.commands.findNext).toHaveBeenCalledTimes(1);
  });
});

describe("TabRenameInput — Enter mid-composition does not commit (#1777)", () => {
  it("holds while composing", async () => {
    const oncommit = vi.fn();
    const { container } = render(TabRenameInput, {
      props: { initial: "notes.md", testId: "tab-rename", oncommit, oncancel: vi.fn() },
    });
    const input = q(container, "tab-rename") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "ノート.md" } });
    await fireEvent.keyDown(input, COMPOSING);
    expect(oncommit).not.toHaveBeenCalled();
  });

  it("commits on a real Enter", async () => {
    const oncommit = vi.fn();
    const { container } = render(TabRenameInput, {
      props: { initial: "notes.md", testId: "tab-rename", oncommit, oncancel: vi.fn() },
    });
    const input = q(container, "tab-rename") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "renamed.md" } });
    await fireEvent.keyDown(input, REAL_ENTER);
    expect(oncommit).toHaveBeenCalledWith("renamed.md");
  });

  it("still stops propagation while composing (the tab's own keydown must not see it)", async () => {
    const { container } = render(TabRenameInput, {
      props: { initial: "notes.md", testId: "tab-rename", oncommit: vi.fn(), oncancel: vi.fn() },
    });
    const input = q(container, "tab-rename") as HTMLInputElement;
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    await fireEvent.keyDown(input, COMPOSING);
    document.body.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("CommandPalette — Enter mid-composition does not run a result (#1777)", () => {
  // The palette's Enter branch preventDefault()s before running the selected
  // result, so `defaultPrevented` is the handler's own observable signal and
  // needs no action registry to be driven.
  it("leaves the confirm keydown untouched while composing, claims a real Enter", async () => {
    const { container } = render(CommandPalette, {
      props: { open: true, onClose: vi.fn() },
    });
    const input = q(container, "palette-input");

    const composing = new KeyboardEvent("keydown", {
      ...COMPOSING,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);

    const real = new KeyboardEvent("keydown", { ...REAL_ENTER, bubbles: true, cancelable: true });
    input.dispatchEvent(real);
    expect(real.defaultPrevented).toBe(true);
  });
});

describe("OutlinePanel — Enter mid-composition does not search (#1777)", () => {
  it("holds while composing, searches on a real Enter", async () => {
    const editor = editorStub();
    const { container } = render(OutlinePanel, {
      props: { editor, headings: [] },
    });
    const input = q(container, "outline-search-input");
    await fireEvent.keyDown(input, COMPOSING);
    expect(editor.commands.findNext).not.toHaveBeenCalled();

    await fireEvent.keyDown(input, REAL_ENTER);
    expect(editor.commands.findNext).toHaveBeenCalledTimes(1);
  });
});
