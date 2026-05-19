// @vitest-environment happy-dom

import type { Editor as TiptapEditor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import {
  applyLink,
  getInitialLinkHref,
  withPreventDefault,
} from "../../src/client/editor/toolbar/handlers.js";

/**
 * Build a minimal TiptapEditor stub sufficient for the toolbar handlers.
 * No shared Editor mock exists in the suite; this is built from scratch.
 * The handlers consume:
 *   - editor.getAttributes(name)
 *   - editor.isActive(name)
 *   - editor.chain().focus().setLink({ href }).run()
 *   - editor.chain().focus().unsetLink().run()
 * All other surfaces stay untyped because the handlers don't touch them.
 */
function makeEditor(opts: { href?: string; linkActive?: boolean } = {}): {
  editor: TiptapEditor;
  spies: {
    setLink: ReturnType<typeof vi.fn>;
    unsetLink: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
} {
  const run = vi.fn(() => true);
  const setLink = vi.fn(() => chain);
  const unsetLink = vi.fn(() => chain);
  const focus = vi.fn(() => chain);
  const chain = {
    focus,
    setLink,
    unsetLink,
    run,
  };

  const editor = {
    getAttributes: vi.fn((name: string) => (name === "link" ? { href: opts.href } : {})),
    isActive: vi.fn((name: string) => name === "link" && Boolean(opts.linkActive)),
    chain: vi.fn(() => chain),
  } as unknown as TiptapEditor;

  return { editor, spies: { setLink, unsetLink, focus, run } };
}

describe("withPreventDefault", () => {
  it("calls preventDefault on the event and forwards to the command", () => {
    const command = vi.fn();
    const wrapped = withPreventDefault(command);
    const e = new MouseEvent("mousedown", { cancelable: true });
    const pdSpy = vi.spyOn(e, "preventDefault");
    wrapped(e);
    expect(pdSpy).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("command callback receives no arguments (signature contract)", () => {
    const command = vi.fn();
    const wrapped = withPreventDefault(command);
    wrapped(new MouseEvent("mousedown", { cancelable: true }));
    expect(command).toHaveBeenCalledWith();
  });
});

describe("getInitialLinkHref", () => {
  it("returns the href when the cursor sits inside a link mark", () => {
    const { editor } = makeEditor({ href: "https://example.com" });
    expect(getInitialLinkHref(editor)).toBe("https://example.com");
  });

  it("returns the empty string when no link mark is active", () => {
    const { editor } = makeEditor({ href: undefined });
    expect(getInitialLinkHref(editor)).toBe("");
  });

  it("queries the link mark by name", () => {
    const { editor } = makeEditor({ href: "https://x" });
    getInitialLinkHref(editor);
    expect(editor.getAttributes).toHaveBeenCalledWith("link");
  });
});

describe("applyLink", () => {
  it("trims URL, focuses, and calls setLink with the trimmed href", () => {
    const { editor, spies } = makeEditor({ linkActive: false });
    applyLink(editor, "   https://example.com   ");
    expect(spies.focus).toHaveBeenCalledTimes(1);
    expect(spies.setLink).toHaveBeenCalledWith({ href: "https://example.com" });
    expect(spies.run).toHaveBeenCalledTimes(1);
    expect(spies.unsetLink).not.toHaveBeenCalled();
  });

  it("unsets the link when URL is empty AND the selection already has a link", () => {
    const { editor, spies } = makeEditor({ linkActive: true });
    applyLink(editor, "");
    expect(spies.unsetLink).toHaveBeenCalledTimes(1);
    expect(spies.setLink).not.toHaveBeenCalled();
    expect(spies.focus).toHaveBeenCalledTimes(1);
    expect(spies.run).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when URL is empty AND no link is active", () => {
    const { editor, spies } = makeEditor({ linkActive: false });
    applyLink(editor, "");
    expect(spies.setLink).not.toHaveBeenCalled();
    expect(spies.unsetLink).not.toHaveBeenCalled();
    expect(spies.focus).not.toHaveBeenCalled();
    expect(spies.run).not.toHaveBeenCalled();
  });

  it("treats whitespace-only URL as empty (trims then evaluates)", () => {
    const { editor, spies } = makeEditor({ linkActive: true });
    applyLink(editor, "   \t  ");
    // Trimmed is empty → falls through to the unsetLink branch.
    expect(spies.unsetLink).toHaveBeenCalledTimes(1);
    expect(spies.setLink).not.toHaveBeenCalled();
  });
});
