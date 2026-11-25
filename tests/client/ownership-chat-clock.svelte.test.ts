// @vitest-environment happy-dom

/**
 * The editor's reading of each unanswered message's published clock and stale
 * flag (#2358 PR 5e, ADR-054's 5e amendment; ownership design §6.5, §10.2):
 * the pickup row counts from the message's `since` for its waiting time and
 * its cut-off (Bryan, 2026-11-24, "Both (Recommended)"), and stale chat drives
 * the stall banner (Bryan, 2026-11-24, "Yes, wire it (Recommended)"). The pure
 * rules are `chat-pickup.test.ts`', `delivery-stall.test.ts`' and
 * `ownership-owner-view.test.ts`'; the banner's reactive path is
 * `useAiReadiness.svelte.test.ts`'.
 *
 * **The dark pin.** A dark server writes no `Y_MAP_OWNERSHIP_CHAT`, so the
 * facts read as an empty map and the chat panel renders exactly as it did
 * before 5e: rendered from a dark server's state, through the reader yjsSync
 * uses, and compared with the panel rendered with no clock at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStaleWaitMs, readChatOwners } from "../../src/client/ownership/owner-view";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import { PICKUP_MAX_AGE_MS, type PickupClock } from "../../src/client/panels/chat-pickup";
import type { PublishedChatMessageOwner } from "../../src/shared/ownership-published";
import type { ChatMessage } from "../../src/shared/types";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const EMPTY = new Map<string, PublishedChatMessageOwner>();

function user(id: string, at: number): ChatMessage {
  return { id, author: "user", text: id, timestamp: at, read: false };
}

function facts(since: number, over: Partial<PublishedChatMessageOwner> = {}) {
  return {
    owner: { label: "owner-k7qx", displayKind: "terminal" },
    heldBy: "message",
    release: true,
    releaseTo: "unassigned",
    assign: true,
    tandemMayTake: false,
    since,
    stale: false,
    ...over,
  };
}

function chatProps(messages: ChatMessage[], pickupClock: PickupClock) {
  return {
    messages,
    editor: null,
    activeDocId: null,
    openDocs: [] as Array<{ id: string; fileName: string }>,
    capturedAnchor: null,
    onCapturedAnchorChange: () => {},
    onSend: () => true,
    onClear: async () => {},
    onExport: async () => {},
    onInsert: () => false,
    tandemClaudeControl: null,
    onStartClaude: () => {},
    onTurnOffClaude: () => {},
    localPickup: null,
    localPeriod: false,
    noticeAnnouncement: "",
    tandemClaudeResume: null,
    onResumeRemedy: () => {},
    tandemClaudeGreetingLate: null,
    onGreetingAction: () => {},
    claudeCodeOfferEligible: true,
    onClaudeCodeOfferSetup: () => {},
    onClaudeCodeOfferDismiss: () => {},
    aiDisabled: false,
    ownerLine: null,
    ownerLineTakeBack: null,
    onOwnerLineRemedy: () => {},
    pickupClock,
    messageOwners: new Map(),
    ownershipSummary: null,
  };
}

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-testid='chat-pickup-status']");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("flag off: the chat panel renders exactly as today", () => {
  it.each([
    ["a young waiting message", [user("a", T0 - 20_000)]],
    ["a message past the stall threshold (the offer shows)", [user("a", T0 - 3 * MIN)]],
    ["a message past the cut-off", [user("a", T0 - PICKUP_MAX_AGE_MS - MIN)]],
  ])("%s", (_name, messages) => {
    const plain = render(ChatPanel, { props: chatProps(messages, new Map()) });
    const before = plain.container.innerHTML;
    plain.unmount();

    const owners = readChatOwners(undefined, EMPTY);
    expect(owners.size).toBe(0);
    const dark = render(ChatPanel, { props: chatProps(messages, owners) });
    expect(dark.container.innerHTML).toBe(before);
  });

  it("no stale chat, so no banner signal", () => {
    expect(chatStaleWaitMs(readChatOwners(undefined, EMPTY), T0)).toBeNull();
  });
});

describe("flag on: the pickup row counts from the published clock", () => {
  it("a re-owed message older than the stall threshold reads waiting, not still waiting, and raises no offer", () => {
    const messages = [user("a", T0 - 9 * MIN)];
    const stalled = render(ChatPanel, { props: chatProps(messages, new Map()) });
    expect(row(stalled.container)?.textContent).toContain("still waiting");
    expect(stalled.queryByTestId("chat-claude-code-offer")).not.toBeNull();
    stalled.unmount();

    const owners = readChatOwners({ a: facts(T0 - 30_000) }, EMPTY);
    const reowed = render(ChatPanel, { props: chatProps(messages, owners) });
    expect(row(reowed.container)?.textContent?.trim()).toBe(
      "Sent · waiting for your AI to pick it up · 30 s",
    );
    expect(reowed.queryByTestId("chat-claude-code-offer")).toBeNull();
  });

  it("keeps the row past the cut-off from arrival while `since` is within it, and drops it once `since` is past it", () => {
    const messages = [user("a", T0 - PICKUP_MAX_AGE_MS - 5 * MIN)];
    const recent = render(ChatPanel, {
      props: chatProps(messages, readChatOwners({ a: facts(T0 - MIN) }, EMPTY)),
    });
    expect(row(recent.container)?.dataset.pickup).toBe("waiting");
    recent.unmount();

    const old = render(ChatPanel, {
      props: chatProps(messages, readChatOwners({ a: facts(T0 - PICKUP_MAX_AGE_MS - MIN) }, EMPTY)),
    });
    expect(row(old.container)).toBeNull();
  });
});

/**
 * App, yjsSync and the providers mount nothing in tests, so the wiring is
 * pinned from source, as 5b's is.
 */
describe("wiring, from source", () => {
  const root = join(import.meta.dirname, "../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("yjsSync reads the facts from CTRL_ROOM's awareness map with the same observer as the summary, and clears them with it", () => {
    const sync = read("src/client/hooks/yjsSync.svelte.ts");
    expect(sync).toMatch(
      /readChatOwners\(userAwareness\.get\(Y_MAP_OWNERSHIP_CHAT\), chatOwnersState\)/,
    );
    expect(sync).toMatch(/if \(event\.keysChanged\.has\(Y_MAP_OWNERSHIP_CHAT\)\) readChat\(\);/);
    expect(sync).toMatch(/readSummary\(\);\s*readChat\(\);/);
    expect(sync).toMatch(/ownershipSummaryState = null;\s*chatOwnersState = new Map\(\);/);
  });

  it("App hands the clock to the chat panel and the stale wait to the stall banner's readiness", () => {
    const app = read("src/client/App.svelte");
    expect(app).toMatch(/pickupClock=\{yjsSync\.chatOwners\}/);
    expect(app).toMatch(/chatStaleMs: \(\) => chatStaleMs,/);
    expect(app).toMatch(
      /chatStaleWaitMs\(yjsSync\.chatOwners, Math\.max\(chatStaleNow, Date\.now\(\)\)\)/,
    );
  });

  it("the client never writes the per-message facts (the server's guard reverts any write)", () => {
    const files = [
      "src/client/hooks/yjsSync.svelte.ts",
      "src/client/App.svelte",
      "src/client/panels/ChatPanel.svelte",
      "src/client/panels/chat-pickup.ts",
      "src/client/ownership/owner-view.ts",
      "src/client/hooks/useAiReadiness.svelte.ts",
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/\.set\(\s*Y_MAP_OWNERSHIP_CHAT/);
    }
  });
});
