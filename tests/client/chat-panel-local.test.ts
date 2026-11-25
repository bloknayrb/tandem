// @vitest-environment happy-dom

/**
 * ChatPanel while a local model may answer chat (#1123 part B): the local
 * pickup rows (R5), notice rows (R6), the Claude Code offer in the local
 * period (R5.2) and a local reply's byline (R9.1). `BYO_MODELS_ENABLED` is
 * flipped on by mocking the constant; the flag-off rendering of the same rows
 * is the last describe in `chat-panel-local-dark.test.ts`.
 */
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPickupInputs } from "../../src/client/panels/chat-pickup";
import type { ChatMessage } from "../../src/shared/types";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const { default: ChatPanel } = await import("../../src/client/panels/ChatPanel.svelte");

const T0 = 1_800_000_000_000;
const G = "gen-now";

const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: "user",
  text: id,
  timestamp: T0,
  read: false,
  ...extra,
});
const claude = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: "claude",
  text: id,
  timestamp: T0 + 1,
  read: true,
  ...extra,
});
const inputs = (over: Partial<LocalPickupInputs> = {}): LocalPickupInputs => ({
  runGeneration: G,
  sentLocal: new Set(),
  readKnownLocal: true,
  aiOff: false,
  ...over,
});

function renderChat(
  messages: ChatMessage[],
  over: {
    localPickup?: LocalPickupInputs | null;
    localPeriod?: boolean;
    noticeAnnouncement?: string;
    claudeCodeOfferEligible?: boolean;
    onInsert?: (m: ChatMessage) => boolean;
  } = {},
) {
  return render(ChatPanel, {
    props: {
      messages,
      editor: null,
      activeDocId: null,
      openDocs: [{ id: "d1", fileName: "notes.md" }],
      capturedAnchor: null,
      onCapturedAnchorChange: () => {},
      onSend: () => true,
      onClear: async () => {},
      onExport: async () => {},
      onInsert: over.onInsert ?? (() => false),
      canInsert: true,
      tandemClaudeControl: null,
      onStartClaude: () => {},
      onTurnOffClaude: () => {},
      tandemClaudeResume: null,
      onResumeRemedy: () => {},
      tandemClaudeGreetingLate: null,
      onGreetingAction: () => {},
      claudeCodeOfferEligible: over.claudeCodeOfferEligible ?? false,
      onClaudeCodeOfferSetup: () => {},
      onClaudeCodeOfferDismiss: () => {},
      aiDisabled: false,
      localPickup: over.localPickup === undefined ? inputs() : over.localPickup,
      localPeriod: over.localPeriod ?? false,
      noticeAnnouncement: over.noticeAnnouncement ?? "",
      ownerLine: null,
      ownerLineTakeBack: null,
      onOwnerLineRemedy: () => {},
    },
  });
}

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-testid='chat-pickup-status']");
const live = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-testid='chat-pickup-live']");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0 + 5_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the local pickup row (R5)", () => {
  it("running: the working line with the dots, and the live region says the same", () => {
    const { container } = renderChat([
      user("u", { localRun: { status: "running", generation: G } }),
    ]);
    expect(row(container)?.dataset.pickup).toBe("local-working");
    expect(row(container)?.textContent?.trim()).toBe("Your local model is working on this…");
    expect(row(container)?.querySelectorAll(".chat-typing-dot")).toHaveLength(3);
    expect(live(container)?.textContent).toBe("Your local model is working on this…");
  });

  it("stopped with nothing for it: the stopped line, no dots", () => {
    const { container } = renderChat([
      user("u", { localRun: { status: "stopped", reason: "error", generation: G } }),
    ]);
    expect(row(container)?.dataset.pickup).toBe("local-stopped");
    expect(row(container)?.textContent?.trim()).toBe("Your local model stopped without answering.");
    expect(row(container)?.querySelectorAll(".chat-typing-dot")).toHaveLength(0);
    expect(live(container)?.textContent).toBe("Your local model stopped without answering.");
  });

  it("sent by this window: 'Sent to your local model'", () => {
    const { container } = renderChat([user("u")], {
      localPickup: inputs({ sentLocal: new Set(["u"]) }),
    });
    expect(row(container)?.dataset.pickup).toBe("local-sent");
    expect(row(container)?.textContent?.trim()).toBe("Sent to your local model");
  });

  it("no Claude Code offer beside a local kind, even past the stall threshold", () => {
    vi.setSystemTime(T0 + 9 * 60_000);
    const { container } = renderChat(
      [user("u", { localRun: { status: "running", generation: G } })],
      { claudeCodeOfferEligible: true },
    );
    expect(container.querySelector("[data-testid='chat-claude-code-offer']")).toBeNull();
  });

  it("no Claude Code offer on an empty chat in the local period; shown out of it", () => {
    const inside = renderChat([], { claudeCodeOfferEligible: true, localPeriod: true });
    expect(inside.container.querySelector("[data-testid='chat-claude-code-offer']")).toBeNull();
    inside.unmount();
    const outside = renderChat([], { claudeCodeOfferEligible: true, localPeriod: false });
    expect(
      outside.container.querySelector("[data-testid='chat-claude-code-offer']"),
    ).not.toBeNull();
  });
});

describe("notice rows (R6)", () => {
  const kinds = [
    ["no-document", "u"],
    ["no-local-model", "u"],
    ["no-reply", "u"],
    ["claude-again", undefined],
  ] as const;
  for (const [kind, replyTo] of kinds) {
    it(`${kind}: a notice, labelled Tandem, plain text, no Insert, no agent colour, badge and time kept`, () => {
      const notice = claude("n1", {
        chatNotice: kind,
        text: "**not bold** <b>x</b>",
        ...(replyTo ? { replyTo } : {}),
        documentId: "d1",
      });
      const { container } = renderChat([user("u"), notice]);
      const el = container.querySelector<HTMLElement>("[data-testid='chat-notice-n1']");
      expect(el).not.toBeNull();
      expect(el?.classList.contains("chat-bubble")).toBe(false);
      expect(el?.dataset.notice).toBe(kind);
      expect(container.querySelector("[data-testid='chat-author-n1']")?.textContent?.trim()).toBe(
        "Tandem",
      );
      // Plain text: the markdown and the tag are shown as written.
      expect(el?.textContent).toContain("**not bold** <b>x</b>");
      expect(el?.querySelector("b")).toBeNull();
      expect(el?.textContent).not.toContain("Insert into open document");
      expect(el?.style.getPropertyValue("--chat-agent-color")).toBe("");
      expect(el?.textContent).toContain("notes.md");
    });
  }

  it("the live region announces what App passes, in its own region", () => {
    const { container } = renderChat([], {
      noticeAnnouncement: "Your local model produced no reply.",
    });
    const region = container.querySelector<HTMLElement>("[data-testid='chat-notice-live']");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("Your local model produced no reply.");
  });

  it("a user row carrying chatNotice renders as the user's bubble", () => {
    const fake = { ...user("u"), chatNotice: "no-reply" } as ChatMessage;
    const { container } = renderChat([fake]);
    expect(container.querySelector("[data-testid='chat-notice-u']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-author-u']")?.textContent?.trim()).toBe(
      "You",
    );
  });
});

describe("a local reply's byline (R9.1)", () => {
  it("names the row's agentIdentity and colours it with its token", async () => {
    const reply = claude("r1", {
      replyTo: "u",
      agentIdentity: { provider: "local-llamacpp", displayName: "My Llama" },
    });
    const { container } = renderChat([user("u"), reply]);
    await tick();
    const author = container.querySelector<HTMLElement>("[data-testid='chat-author-r1']");
    expect(author?.textContent?.trim()).toBe("My Llama");
    expect(author?.getAttribute("style")).toContain("var(--tandem-agent-local-llamacpp)");
  });
});
