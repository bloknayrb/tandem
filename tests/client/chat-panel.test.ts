// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { AI_CTA } from "../../src/client/hooks/useAiReadiness.svelte";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import { GREETING_LATE_TEXT, type GreetingAction } from "../../src/client/panels/chat-greeting";
import type { ChatResume } from "../../src/client/panels/chat-resume";
import type { ChatMessage } from "../../src/shared/types";
import { reactiveCell } from "../helpers/reactive-cell.svelte";
import { spyChatAutoScroll } from "./chat-auto-scroll";

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
      tandemClaudeControl: null,
      onStartClaude: () => {},
      onTurnOffClaude: () => {},
      aiDisabled: false,
      tandemClaudeResume: null,
      onResumeRemedy: () => {},
      tandemClaudeGreetingLate: null,
      onGreetingAction: () => {},
      claudeCodeOfferEligible: false,
      onClaudeCodeOfferSetup: () => {},
      onClaudeCodeOfferDismiss: () => {},
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

describe("ChatPanel — Tandem's Claude Start / Turn off control (#2195)", () => {
  function renderWithControl(control: "start" | "turn-off" | null, messages: ChatMessage[] = []) {
    const onStartClaude = vi.fn();
    const onTurnOffClaude = vi.fn();
    const result = render(ChatPanel, {
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
        tandemClaudeControl: control,
        onStartClaude,
        onTurnOffClaude,
        aiDisabled: false,
        tandemClaudeResume: null,
        onResumeRemedy: () => {},
        tandemClaudeGreetingLate: null,
        onGreetingAction: () => {},
        claudeCodeOfferEligible: false,
        onClaudeCodeOfferSetup: () => {},
        onClaudeCodeOfferDismiss: () => {},
      },
    });
    const btn = result.container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-tandem-claude-toggle']",
    );
    return { ...result, btn, onStartClaude, onTurnOffClaude };
  }

  it("shows Start on an EMPTY chat — where it is most needed — and calls onStartClaude", () => {
    const { btn, onStartClaude, onTurnOffClaude, container } = renderWithControl("start");
    expect(btn).not.toBeNull();
    expect(btn?.textContent?.trim()).toBe("Start Tandem's Claude");
    btn?.click();
    expect(onStartClaude).toHaveBeenCalledOnce();
    expect(onTurnOffClaude).not.toHaveBeenCalled();
    // Export/Clear stay tied to there being messages.
    expect(container.querySelector("[data-testid='clear-chat-btn']")).toBeNull();
  });

  it("shows Turn off while it runs, naming Tandem's Claude", () => {
    const { btn, onTurnOffClaude } = renderWithControl("turn-off", [claudeMsg()]);
    expect(btn?.textContent?.trim()).toBe("Turn off Tandem's Claude");
    btn?.click();
    expect(onTurnOffClaude).toHaveBeenCalledOnce();
  });

  it("is absent when there is nothing to start or stop", () => {
    expect(renderWithControl(null).btn).toBeNull();
  });
});

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
        tandemClaudeResume: null,
        onResumeRemedy: () => {},
        tandemClaudeGreetingLate: null,
        onGreetingAction: () => {},
        claudeCodeOfferEligible: false,
        onClaudeCodeOfferSetup: () => {},
        onClaudeCodeOfferDismiss: () => {},
        tandemClaudeControl: null,
        onStartClaude: () => {},
        onTurnOffClaude: () => {},
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

describe("ChatPanel — auto-scroll moves the messages list, never its ancestors", () => {
  // `scrollIntoView` on an end sentinel also scrolled App's `overflow: hidden`
  // `.rail-full-right`, by a distance the user could not scroll back (#2329).
  // `tests/e2e/chat-autoscroll.spec.ts` measures the rail in a real layout.
  async function withSpy(run: (spy: ReturnType<typeof spyChatAutoScroll>) => Promise<void>) {
    const spy = spyChatAutoScroll();
    try {
      await run(spy);
    } finally {
      spy.restore();
    }
  }
  function list(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>("[data-testid='chat-messages']");
    if (!el) throw new Error("no messages list");
    // happy-dom lays nothing out; a distinct height proves where `top` comes from.
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1234 });
    return el;
  }

  it("a new message scrolls the list to its own bottom, and never calls scrollIntoView", () =>
    withSpy(async ({ scrolls, intoView }) => {
      const { container, rerender } = renderChat([claudeMsg()]);
      list(container);
      await tick();
      scrolls.mockClear();
      await rerender({ messages: [claudeMsg(), claudeMsg({ id: "m2", text: "next" })] });
      await tick();
      expect(scrolls).toHaveBeenCalledWith({ top: 1234, behavior: "smooth" });
      expect(intoView).not.toHaveBeenCalled();
    }));

  it("jumps instead of animating under reduced motion", () =>
    withSpy(async ({ scrolls }) => {
      const { container, rerender } = renderChat([claudeMsg()]);
      list(container);
      await rerender({ reduceMotion: true, messages: [claudeMsg(), claudeMsg({ id: "m2" })] });
      await tick();
      expect(scrolls).toHaveBeenLastCalledWith({ top: 1234, behavior: "auto" });
    }));

  it("showing the panel scrolls the list, and never calls scrollIntoView", () =>
    withSpy(async ({ scrolls, intoView }) => {
      const { container, rerender } = renderChat([claudeMsg()]);
      list(container);
      await rerender({ visible: false });
      await tick();
      scrolls.mockClear();
      await rerender({ visible: true });
      await tick();
      expect(scrolls).toHaveBeenCalledWith({ top: 1234, behavior: "smooth" });
      expect(intoView).not.toHaveBeenCalled();
    }));
});

describe("ChatPanel — the resume row (#2196)", () => {
  function renderWithResume(
    resume: ChatResume | null | { value: ChatResume | null },
    messages: ChatMessage[] = [],
  ) {
    const onResumeRemedy = vi.fn();
    const cell = resume !== null && "value" in resume ? resume : null;
    const props = {
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
      tandemClaudeControl: null,
      onStartClaude: () => {},
      onTurnOffClaude: () => {},
      tandemClaudeResume: cell ? null : (resume as ChatResume | null),
      onResumeRemedy,
      tandemClaudeGreetingLate: null,
      onGreetingAction: () => {},
      claudeCodeOfferEligible: false,
      onClaudeCodeOfferSetup: () => {},
      onClaudeCodeOfferDismiss: () => {},
      aiDisabled: false,
    };
    // A getter reads the cell, so only this prop is reactive (#2196).
    if (cell) {
      Object.defineProperty(props, "tandemClaudeResume", {
        get: () => cell.value,
        enumerable: true,
      });
    }
    const result = render(ChatPanel, { props });
    const q = (id: string) => result.container.querySelector<HTMLElement>(`[data-testid='${id}']`);
    return { ...result, q, onResumeRemedy };
  }

  const unread = (): ChatMessage =>
    claudeMsg({ id: "u1", author: "user", text: "are you there?", timestamp: Date.now() });

  it("resuming replaces the pickup row, and the one live region says resuming", () => {
    // Positive control: the same unread message shows the pickup row with no resume.
    expect(renderWithResume(null, [unread()]).q("chat-pickup-status")).not.toBeNull();
    cleanup();
    const { q } = renderWithResume({ kind: "resuming", verb: "resuming" }, [unread()]);
    expect(q("chat-tandem-claude-resuming")?.textContent).toContain("Claude is resuming…");
    expect(q("chat-pickup-status")).toBeNull();
    expect(q("chat-pickup-live")?.textContent).toContain("Claude is resuming…");
  });

  it("scrolls when resuming turns into the failed row, so its remedy is in view", async () => {
    const { scrolls: spy, restore } = spyChatAutoScroll();
    try {
      const { rerender } = renderWithResume({ kind: "resuming", verb: "starting" });
      await tick();
      spy.mockClear();
      await rerender({ tandemClaudeResume: { kind: "failed", remedy: "start" } });
      await tick();
      expect(spy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("does not scroll again when the row is recomputed with nothing changed", async () => {
    const { scrolls: spy, restore } = spyChatAutoScroll();
    try {
      // Only this prop changes, as in App: `rerender` would re-set every prop.
      const cell = reactiveCell<ChatResume | null>({ kind: "resuming", verb: "starting" });
      renderWithResume(cell);
      await tick();
      spy.mockClear();
      // A fresh object with the same kind, as every `chatResume` recompute is.
      cell.value = { kind: "resuming", verb: "starting" };
      await tick();
      expect(spy).not.toHaveBeenCalled();
      // Control: a change of kind still scrolls.
      cell.value = { kind: "failed", remedy: "start" };
      await tick();
      expect(spy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("says starting for a Claude that was off", () => {
    const { q } = renderWithResume({ kind: "resuming", verb: "starting" });
    expect(q("chat-tandem-claude-resuming")?.textContent).toContain("Starting Tandem's Claude…");
  });

  it("a failed start says the message is unanswered and its button runs the remedy", () => {
    const { q, onResumeRemedy } = renderWithResume({ kind: "failed", remedy: "sign-in" }, [
      unread(),
    ]);
    const row = q("chat-tandem-claude-resume-failed");
    expect(row?.textContent).toContain("hasn't been answered");
    // The row itself stays in the accessibility tree, so its button is reachable.
    expect(row?.closest("[aria-hidden='true']")).toBeNull();
    expect(q("chat-pickup-status")).toBeNull();
    const btn = q("chat-tandem-claude-resume-remedy") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe(AI_CTA["sign-in"].label);
    btn.click();
    expect(onResumeRemedy).toHaveBeenCalledWith("sign-in");
  });
});

describe("ChatPanel — the 'hasn't said hello' note (#2197)", () => {
  function renderWithGreeting(
    greeting: GreetingAction | null,
    opts: { resume?: ChatResume | null; messages?: ChatMessage[] } = {},
  ) {
    const onGreetingAction = vi.fn();
    const result = render(ChatPanel, {
      props: {
        messages: opts.messages ?? [],
        editor: null,
        activeDocId: null,
        openDocs: [],
        capturedAnchor: null,
        onCapturedAnchorChange: () => {},
        onSend: () => true,
        onClear: async () => {},
        onExport: async () => {},
        onInsert: () => false,
        tandemClaudeControl: null,
        onStartClaude: () => {},
        onTurnOffClaude: () => {},
        tandemClaudeResume: opts.resume ?? null,
        onResumeRemedy: () => {},
        tandemClaudeGreetingLate: greeting,
        onGreetingAction,
        claudeCodeOfferEligible: false,
        onClaudeCodeOfferSetup: () => {},
        onClaudeCodeOfferDismiss: () => {},
        aiDisabled: false,
      },
    });
    const q = (id: string) => result.container.querySelector<HTMLElement>(`[data-testid='${id}']`);
    return { ...result, q, onGreetingAction };
  }

  const unread = (): ChatMessage =>
    claudeMsg({ id: "u1", author: "user", text: "hi", timestamp: Date.now() });

  it("says how to fix it, replaces the pickup row, and its button restarts Tandem's Claude", () => {
    const { q, onGreetingAction } = renderWithGreeting("relaunch", { messages: [unread()] });
    const note = q("chat-greeting-late");
    expect(note?.textContent).toContain("hasn't said hello");
    expect(note?.textContent).toContain("signed in");
    expect(note?.textContent).toContain("Tandem's tools");
    expect(q("chat-pickup-status")).toBeNull();
    expect(note?.closest("[aria-hidden='true']")).toBeNull();
    expect(q("chat-pickup-live")?.textContent).toContain("hasn't said hello");
    const btn = q("chat-greeting-late-action") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("Restart Tandem's Claude");
    btn.click();
    expect(onGreetingAction).toHaveBeenCalledWith("relaunch");
  });

  it("a stopped launcher's own remedy labels the button (sign-in first)", () => {
    const { q, onGreetingAction } = renderWithGreeting("sign-in");
    const btn = q("chat-greeting-late-action") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe(AI_CTA["sign-in"].label);
    btn.click();
    expect(onGreetingAction).toHaveBeenCalledWith("sign-in");
  });

  it("the resume row outranks it", () => {
    const { q } = renderWithGreeting("relaunch", {
      resume: { kind: "resuming", verb: "starting" },
    });
    expect(q("chat-tandem-claude-resuming")).not.toBeNull();
    expect(q("chat-greeting-late")).toBeNull();
  });

  it("control: absent when not late", () => {
    expect(renderWithGreeting(null).q("chat-greeting-late")).toBeNull();
  });
});

describe("the greeting note points at a troubleshooting section that exists", () => {
  it("names the section by its heading", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const doc = fs.readFileSync(
      path.join(import.meta.dirname, "../../docs/troubleshooting.md"),
      "utf8",
    );
    const heading = "Tandem's Claude didn't say hello";
    expect(doc).toContain(`## ${heading}`);
    expect(GREETING_LATE_TEXT).toContain(`“${heading}”`);
  });
});
