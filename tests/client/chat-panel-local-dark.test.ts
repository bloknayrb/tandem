// @vitest-environment happy-dom

/**
 * ChatPanel with `BYO_MODELS_ENABLED` off, forced by this file's mock (#1123 part B,
 * R10.1): rows carrying `localRun` or `chatNotice` — a session restored from a
 * flag-on build — render exactly as on master, whatever local inputs App
 * passes.
 */
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import type { ChatMessage } from "../../src/shared/types";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

const T0 = Date.now();

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
      tandemClaudeResume: null,
      onResumeRemedy: () => {},
      tandemClaudeGreetingLate: null,
      onGreetingAction: () => {},
      claudeCodeOfferEligible: false,
      onClaudeCodeOfferSetup: () => {},
      onClaudeCodeOfferDismiss: () => {},
      aiDisabled: false,
      localPickup: {
        runGeneration: "g",
        sentLocal: new Set(["u"]),
        readKnownLocal: true,
        aiOff: false,
      },
      localPeriod: true,
      noticeAnnouncement: "",
      ownerLine: null,
      ownerLineTakeBack: null,
      pickupClock: new Map(),
      messageOwners: new Map(),
      ownershipSummary: null,
      onOwnerLineRemedy: () => {},
    },
  });
}

describe("ChatPanel, flag off", () => {
  it("the anchor: the file-level mock applied, so the flag reads false here", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  it("no chat-notice-live region is rendered (review round 1, item 1)", () => {
    const { container } = renderChat([]);
    expect(container.querySelector("[data-testid='chat-notice-live']")).toBeNull();
    // Today's one live region only.
    expect(container.querySelectorAll("[role='status']")).toHaveLength(1);
  });

  it("a notice row renders as a Claude bubble, as on master", () => {
    const { container } = renderChat([
      { id: "n", author: "claude", text: "x", timestamp: T0, read: true, chatNotice: "no-reply" },
    ]);
    expect(container.querySelector("[data-testid='chat-notice-n']")).toBeNull();
    expect(container.querySelector(".chat-bubble.claude")).not.toBeNull();
    expect(container.textContent).toContain("Insert into open document");
  });

  it("a user row carrying localRun gets today's pickup row", () => {
    const { container } = renderChat([
      {
        id: "u",
        author: "user",
        text: "q",
        timestamp: T0,
        read: false,
        localRun: { status: "running", generation: "g" },
      },
    ]);
    const row = container.querySelector<HTMLElement>("[data-testid='chat-pickup-status']");
    expect(row?.dataset.pickup).toBe("waiting");
  });
});
