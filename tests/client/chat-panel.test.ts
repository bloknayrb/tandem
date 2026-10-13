// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import type { ChatMessage } from "../../src/shared/types";

function renderChat(messages: ChatMessage[]) {
  return render(ChatPanel, {
    props: {
      messages,
      editor: null,
      activeDocId: null,
      openDocs: [],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
      onSend: () => true,
      onClear: async () => {},
      onExport: async () => {},
      onInsert: () => false,
      aiDisabled: false,
    },
  });
}

function claudeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    author: "claude",
    text: "hello",
    timestamp: 1,
    ...overrides,
  } as ChatMessage;
}

function authorStyle(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-testid='chat-author-${id}']`)?.getAttribute("style") ?? "";
}

function bubble(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-testid='chat-author-${id}']`)?.parentElement
    ?.parentElement as HTMLElement;
}

describe("ChatPanel per-agent author color (#1123 M4)", () => {
  it("a claude message WITH agentIdentity colors the author with the per-agent token", () => {
    const messages = [
      claudeMsg({ agentIdentity: { provider: "local-ollama", displayName: "Qwen 2.5" } }),
    ];
    const { container } = renderChat(messages);
    const style = authorStyle(container, "m1");
    expect(style).toContain("var(--tandem-agent-local-ollama)");
    // The distinct fallbacks matter: it must NOT collapse to the accent baseline
    // nor to the annotation coral token.
    expect(style).not.toContain("var(--tandem-accent)");
    expect(style).not.toContain("var(--tandem-author-claude)");
    expect(bubble(container, "m1").classList).toContain("identified");
    expect(bubble(container, "m1").style.getPropertyValue("--chat-agent-color")).toBe(
      "var(--tandem-agent-local-ollama)",
    );
  });

  it("a claude message WITHOUT agentIdentity uses the coral author tokens", () => {
    const { container } = renderChat([claudeMsg()]);
    const style = authorStyle(container, "m1");
    expect(style).toContain("var(--tandem-author-claude-fg-strong)");
    expect(style).not.toContain("color: var(--tandem-author-claude);");
    expect(style).not.toContain("var(--tandem-accent)");
    expect(style).not.toContain("var(--tandem-agent-");
    expect(bubble(container, "m1").classList).toContain("claude");
    expect(bubble(container, "m1").classList).not.toContain("identified");
    expect(bubble(container, "m1").style.getPropertyValue("--chat-agent-color")).toBe(
      "var(--tandem-author-claude)",
    );
  });

  it("a user message uses the muted token, unaffected by identity wiring", () => {
    const { container } = renderChat([claudeMsg({ id: "u1", author: "user", text: "hi" })]);
    expect(authorStyle(container, "u1")).toContain("var(--tandem-fg-muted)");
  });

  it("disables per-message insertion when the App reports no editable formatted document", () => {
    const view = renderChat([claudeMsg()]);
    const button = view.container.querySelector<HTMLButtonElement>(".chat-message-actions button");
    expect(button?.disabled).toBe(true);
  });
});

/**
 * `ChatPanel.svelte:372` is one of the two `{@html}` sinks in the client — the
 * other is `AnnotationBody.svelte:73`, added by #1626 — and `renderMarkdown`
 * exists solely to make them safe. Nothing else pins that this one still routes
 * through it — a refactor to `{@html msg.text}` keeps every
 * test in `chat-markdown.test.ts` green while shipping an XSS, because those
 * tests exercise the function directly and never assert that anyone calls it.
 *
 * This is the wiring test. It asserts the rendered DOM, so it fails on the
 * refactor regardless of how the markup is spelled.
 */
describe("ChatPanel — the {@html} sink is routed through renderMarkdown", () => {
  it("does not build a script element from a claude message", () => {
    const view = renderChat([claudeMsg({ text: "<script>alert(1)</script>" })]);

    expect(view.container.querySelectorAll("script")).toHaveLength(0);
    expect(view.container.textContent).toContain("<script>alert(1)</script>");
  });

  it("does not build an event-handler attribute from a claude message", () => {
    const view = renderChat([claudeMsg({ text: '<img src=x onerror="alert(1)">' })]);

    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    for (const el of Array.from(view.container.querySelectorAll("*"))) {
      expect(el.getAttributeNames().filter((n) => n.toLowerCase().startsWith("on"))).toEqual([]);
    }
  });

  it("still renders markdown for a claude message, so the sink is genuinely live", () => {
    // Without this arm the two above would also pass on a plain-text render,
    // which is the wrong fix for the right reason.
    const view = renderChat([claudeMsg({ text: "**bold**" })]);

    expect(view.container.querySelector(".chat-markdown strong")?.textContent).toBe("bold");
  });

  it("renders a user message as plain text, markup and all", () => {
    const view = renderChat([claudeMsg({ id: "u1", author: "user", text: "**not bold**" })]);

    expect(view.container.querySelector("strong")).toBeNull();
    expect(view.container.textContent).toContain("**not bold**");
  });
});

/**
 * #1521: while the licence refuses the AI the composer and send are disabled
 * and Enter sends nothing; the history stays readable. The twin is the normal
 * send path with `aiDisabled: false`.
 */
describe("ChatPanel — AI off by licence", () => {
  function mount(aiDisabled: boolean) {
    const onSend = vi.fn(() => true);
    const r = render(ChatPanel, {
      props: {
        messages: [claudeMsg()],
        editor: null,
        activeDocId: null,
        openDocs: [],
        capturedAnchor: null,
        onCapturedAnchorChange: () => {},
        onSend,
        onClear: async () => {},
        onExport: async () => {},
        onInsert: () => false,
        aiDisabled,
      },
    });
    const input = r.container.querySelector<HTMLTextAreaElement>(
      "[data-testid='chat-composer-input']",
    ) as HTMLTextAreaElement;
    const send = r.container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-send-btn']",
    ) as HTMLButtonElement;
    return { ...r, onSend, input, send };
  }

  it("disables the composer and send, and Enter does not send", async () => {
    const { input, send, onSend, container, unmount } = mount(true);
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("AI features are off");
    await fireEvent.input(input, { target: { value: "hello" } });
    await tick();
    expect(send.disabled).toBe(true);
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    // The user's own history is still there.
    expect(container.textContent).toContain("hello");
    unmount();
  });

  it("the twin: enabled, Enter sends", async () => {
    const { input, send, onSend, unmount } = mount(false);
    expect(input.disabled).toBe(false);
    await fireEvent.input(input, { target: { value: "hi there" } });
    await tick();
    expect(send.disabled).toBe(false);
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hi there");
    unmount();
  });
});
