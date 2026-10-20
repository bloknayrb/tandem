// @vitest-environment happy-dom

/**
 * The chat panel's offer to set up Tandem's own Claude (#2199): the pure
 * eligibility and timing rules, and the panel's row.
 */
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import {
  CLAUDE_CODE_OFFER_TEXT,
  claudeCodeOfferEligible,
  showClaudeCodeOffer,
} from "../../src/client/panels/chat-claude-code-offer";
import { DELIVERY_STALL_MS } from "../../src/shared/constants";
import type { ChatMessage } from "../../src/shared/types";

const base = {
  launcherNotConfigured: true,
  pushAttached: false,
  aiOff: false,
  solo: false,
  dismissed: false,
};

describe("claudeCodeOfferEligible", () => {
  it("is for a setup the launcher cannot run, with nothing being pushed to", () => {
    expect(claudeCodeOfferEligible(base)).toBe(true);
  });

  it.each([
    ["the launcher has a Claude Code setup", { launcherNotConfigured: false }],
    ["something is told about new messages already", { pushAttached: true }],
    ["the licence refuses the AI", { aiOff: true }],
    ["Solo holds the AI back", { solo: true }],
    ["the user said Not now", { dismissed: true }],
  ])("not when %s", (_l, patch) => {
    expect(claudeCodeOfferEligible({ ...base, ...patch })).toBe(false);
  });
});

describe("showClaudeCodeOffer", () => {
  it("on an empty chat", () => {
    expect(showClaudeCodeOffer(true, 0, null)).toBe(true);
  });

  it("not on every send: only once a message has waited past the stall threshold", () => {
    expect(showClaudeCodeOffer(true, 1, { kind: "waiting", waitedMs: 2_000 })).toBe(false);
    expect(showClaudeCodeOffer(true, 1, { kind: "waiting", waitedMs: DELIVERY_STALL_MS })).toBe(
      true,
    );
    expect(showClaudeCodeOffer(true, 1, { kind: "received" })).toBe(false);
    expect(showClaudeCodeOffer(true, 1, null)).toBe(false);
  });

  it("never when not eligible", () => {
    expect(showClaudeCodeOffer(false, 0, null)).toBe(false);
  });
});

describe("ChatPanel — the offer row", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  });

  function renderChat(messages: ChatMessage[], eligible: boolean) {
    const onClaudeCodeOfferSetup = vi.fn();
    const onClaudeCodeOfferDismiss = vi.fn();
    const r = render(ChatPanel, {
      props: {
        messages,
        visible: true,
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
        tandemClaudeResume: null,
        onResumeRemedy: () => {},
        tandemClaudeGreetingLate: null,
        onGreetingAction: () => {},
        claudeCodeOfferEligible: eligible,
        onClaudeCodeOfferSetup,
        onClaudeCodeOfferDismiss,
        aiDisabled: false,
      },
    });
    return { ...r, onClaudeCodeOfferSetup, onClaudeCodeOfferDismiss };
  }

  const row = (c: HTMLElement) =>
    c.querySelector<HTMLElement>("[data-testid='chat-claude-code-offer']");

  it("shows on an empty chat, is readable (not aria-hidden), and its buttons call back", async () => {
    const { container, onClaudeCodeOfferSetup, onClaudeCodeOfferDismiss } = renderChat([], true);
    await tick();
    const el = row(container);
    expect(el).not.toBeNull();
    expect(el?.getAttribute("aria-hidden")).toBeNull();
    // Announced through the panel's one live region, as the pickup rows are.
    expect(container.querySelector("[data-testid='chat-pickup-live']")?.textContent).toContain(
      CLAUDE_CODE_OFFER_TEXT,
    );
    await fireEvent.click(
      container.querySelector("[data-testid='chat-claude-code-offer-setup']") as HTMLElement,
    );
    await fireEvent.click(
      container.querySelector("[data-testid='chat-claude-code-offer-dismiss']") as HTMLElement,
    );
    expect(onClaudeCodeOfferSetup).toHaveBeenCalledTimes(1);
    expect(onClaudeCodeOfferDismiss).toHaveBeenCalledTimes(1);
  });

  it("sits beside a long-waiting pickup row, not instead of it", async () => {
    const sent: ChatMessage = {
      id: "u1",
      author: "user",
      text: "hi",
      timestamp: Date.now() - DELIVERY_STALL_MS - 1_000,
      read: false,
    };
    const { container } = renderChat([sent], true);
    await tick();
    expect(row(container)).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-pickup-status']")).not.toBeNull();
  });

  it("scrolls into view when it joins a waiting row at the stall threshold", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const t0 = 1_800_000_000_000;
      vi.setSystemTime(t0);
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
      const sent: ChatMessage = {
        id: "u1",
        author: "user",
        text: "hi",
        timestamp: t0,
        read: false,
      };
      const { container } = renderChat([sent], true);
      await tick();
      expect(row(container)).toBeNull();
      const before = scroll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(DELIVERY_STALL_MS + 1_000);
      await tick();
      expect(row(container)).not.toBeNull();
      expect(scroll.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("not when App says it is not eligible", async () => {
    const { container } = renderChat([], false);
    await tick();
    expect(row(container)).toBeNull();
  });
});
