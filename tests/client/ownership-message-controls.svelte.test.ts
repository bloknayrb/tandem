// @vitest-environment happy-dom

/**
 * A chat message's controls (#2358 PR 5e, ADR-054's 5e amendment; ownership
 * design §10.2, "Chat with no controlling badge"): the control line under each
 * unanswered message whose published facts offer Assign or Release (Bryan,
 * 2026-11-24, "A line per message (Recommended)"), its Release saying where
 * the message goes ("Yes, say where (Recommended)"), its refusals in Bryan's
 * copy ("Accept (Recommended)"), and the composer line's Start for stale chat
 * ("Yes (Recommended)"). The pure rules are `ownership-owner-view.test.ts`'.
 *
 * **The dark pin.** A dark server writes no `Y_MAP_OWNERSHIP_CHAT` and no
 * summary, so the chat panel renders exactly as with no ownership input:
 * rendered from a dark server's state, through the readers yjsSync uses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerLine,
  readChatOwners,
  readOwnershipSummary,
} from "../../src/client/ownership/owner-view";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import type {
  OwnershipSummary,
  PublishedChatMessageOwner,
} from "../../src/shared/ownership-published";
import type { ChatMessage } from "../../src/shared/types";

const T0 = 1_800_000_000_000;
const EMPTY = new Map<string, PublishedChatMessageOwner>();

const SUMMARY: OwnershipSummary = {
  tandemPresent: true,
  tandemRunning: true,
  tandemStartable: false,
  notPresentReason: null,
  otherAiAttached: false,
  chatWaiting: true,
  chatStale: false,
};

function user(id: string, at = T0): ChatMessage {
  return { id, author: "user", text: `text ${id}`, timestamp: at, read: false };
}

function facts(over: Partial<PublishedChatMessageOwner> = {}): PublishedChatMessageOwner {
  return {
    owner: { label: "owner-k7qx", displayKind: "terminal" },
    heldBy: "message",
    release: true,
    releaseTo: "tandem-claude",
    assign: true,
    since: T0,
    stale: false,
    ...over,
  };
}

function chatProps(
  messages: ChatMessage[],
  messageOwners: ReadonlyMap<string, PublishedChatMessageOwner>,
  ownershipSummary: OwnershipSummary | null,
  extra: Record<string, unknown> = {},
) {
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
    claudeCodeOfferEligible: false,
    onClaudeCodeOfferSetup: () => {},
    onClaudeCodeOfferDismiss: () => {},
    aiDisabled: false,
    ownerLine: null,
    ownerLineTakeBack: null,
    onOwnerLineRemedy: () => {},
    pickupClock: messageOwners,
    messageOwners,
    ownershipSummary,
    ...extra,
  };
}

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0 + 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));

describe("flag off: the chat panel renders exactly as today", () => {
  it("renders the same panel from a dark server's state as with no ownership input", () => {
    const messages = [user("m1"), user("m2", T0 + 500)];
    const plain = render(ChatPanel, { props: chatProps(messages, EMPTY, null) });
    const before = plain.container.innerHTML;
    plain.unmount();

    const owners = readChatOwners(undefined, EMPTY);
    expect(owners.size).toBe(0);
    const dark = render(ChatPanel, {
      props: chatProps(messages, owners, readOwnershipSummary(undefined)),
    });
    expect(dark.container.innerHTML).toBe(before);
    expect(dark.container.querySelector("[data-testid^='chat-message-owner']")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the control line under each unanswered message", () => {
  it("names the holder, offers Release saying where it goes and Assign, under every such message at any age", () => {
    const old = user("old", T0 - 60 * 60_000);
    const answered = user("answered", T0 - 30 * 60_000);
    const latest = user("latest", T0);
    const owners = new Map([
      ["old", facts({ owner: null, heldBy: "none", release: false, releaseTo: null })],
      ["latest", facts()],
    ]);
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([old, answered, latest], owners, SUMMARY),
    });
    const oldLine = getByTestId("chat-message-owner-old");
    expect(oldLine.textContent).toContain("Unassigned");
    expect(queryByTestId("chat-message-owner-release-old")).toBeNull();
    expect(getByTestId("chat-message-owner-assign-old").textContent?.trim()).toBe("Assign…");
    // An answered message has no published facts, so no line.
    expect(queryByTestId("chat-message-owner-answered")).toBeNull();

    expect(getByTestId("chat-message-owner-latest").textContent).toContain("terminal owner-k7qx");
    expect(getByTestId("chat-message-owner-release-latest").textContent?.trim()).toBe(
      "Release — Back to Tandem's Claude",
    );
  });

  it("says where Release goes for each destination", () => {
    const owners = new Map([
      ["a", facts({ releaseTo: "tandem-claude" })],
      ["b", facts({ releaseTo: "unassigned" })],
      ["c", facts({ releaseTo: "document" })],
    ]);
    const { getByTestId } = render(ChatPanel, {
      props: chatProps([user("a"), user("b"), user("c")], owners, SUMMARY),
    });
    expect(getByTestId("chat-message-owner-release-a").textContent?.trim()).toBe(
      "Release — Back to Tandem's Claude",
    );
    expect(getByTestId("chat-message-owner-release-b").textContent?.trim()).toBe(
      "Release — Unassigned",
    );
    expect(getByTestId("chat-message-owner-release-c").textContent?.trim()).toBe(
      "Release — Back to its document",
    );
  });

  it("shows only when it says something, and never on a message that follows its document", () => {
    const byPresence = facts({
      owner: { label: "owner-t", displayKind: "Tandem's Claude" },
      heldBy: "presence",
      release: false,
      releaseTo: null,
    });
    const onDoc = facts({ heldBy: "document", release: false, releaseTo: null, assign: false });
    const owners = new Map([
      ["p", byPresence],
      ["d", onDoc],
    ]);
    const msgs = [user("p"), user("d")];

    const lone = render(ChatPanel, { props: chatProps(msgs, owners, SUMMARY) });
    expect(lone.queryByTestId("chat-message-owner-p")).toBeNull();
    expect(lone.queryByTestId("chat-message-owner-d")).toBeNull();
    lone.unmount();

    const attached = render(ChatPanel, {
      props: chatProps(msgs, owners, { ...SUMMARY, otherAiAttached: true }),
    });
    expect(attached.getByTestId("chat-message-owner-p").textContent).toContain("Tandem's Claude");
    expect(attached.queryByTestId("chat-message-owner-d")).toBeNull();
    attached.unmount();

    // No summary (stdio mode, or no launcher): always.
    const noSummary = render(ChatPanel, { props: chatProps(msgs, owners, null) });
    expect(noSummary.getByTestId("chat-message-owner-p")).toBeTruthy();
    expect(noSummary.queryByTestId("chat-message-owner-d")).toBeNull();
  });

  it("offers Assign only where the facts do", () => {
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts({ assign: false })]]), SUMMARY),
    });
    expect(getByTestId("chat-message-owner-release-m")).toBeTruthy();
    expect(queryByTestId("chat-message-owner-assign-m")).toBeNull();
  });

  it("never on Claude's rows, even under a key with facts", () => {
    const claude: ChatMessage = {
      id: "c1",
      author: "claude",
      text: "hi",
      timestamp: T0,
      read: true,
    };
    const { queryByTestId } = render(ChatPanel, {
      props: chatProps([claude], new Map([["c1", facts()]]), SUMMARY),
    });
    expect(queryByTestId("chat-message-owner-c1")).toBeNull();
  });

  it("keeps the latest message's status row below its line", () => {
    const { getByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    const line = getByTestId("chat-message-owner-m");
    const status = getByTestId("chat-pickup-status");
    expect(line.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Release posts the message's id and action as JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { changed: true } }));
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    await fireEvent.click(getByTestId("chat-message-owner-release-m"));
    await settle();
    expect(posts()).toEqual([
      {
        url: expect.stringMatching(/\/api\/ownership$/),
        body: { messageId: "m", action: "release" },
      },
    ]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(queryByTestId("chat-message-owner-error-m")).toBeNull();
  });

  it.each([
    ["unknown-message", 404, "This message was removed"],
    ["follows-document", 409, "This message follows its document — use the document's tab"],
    ["answered", 409, "This message was already answered"],
    ["not-controllable", 409, "A local model is handling this message"],
  ])("shows a %s refusal inline", async (code, status, text) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: code }));
    const { getByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    await fireEvent.click(getByTestId("chat-message-owner-release-m"));
    await settle();
    const error = getByTestId("chat-message-owner-error-m");
    expect(error.textContent?.trim()).toBe(text);
    expect(getByTestId("chat-message-owner-m").contains(error)).toBe(true);
  });

  it("Assign… opens the owners list, and picking one assigns the message by label and closes it", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(200, { data: { changed: true } });
      expect(url).toMatch(/\/api\/ownership\/owners$/);
      return jsonResponse(200, {
        data: [
          { label: "owner-t", displayKind: "Tandem's Claude", holds: [], canTake: true },
          { label: "owner-p2zt", displayKind: "terminal", holds: ["a.md"], canTake: true },
        ],
      });
    });
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    expect(queryByTestId("chat-message-owner-menu")).toBeNull();
    await fireEvent.click(getByTestId("chat-message-owner-assign-m"));
    await settle();
    expect(getByTestId("chat-message-owner-menu")).toBeTruthy();
    expect(getByTestId("chat-message-owner-choice-owner-t").textContent).toContain(
      "Tandem's Claude",
    );
    expect(getByTestId("chat-message-owner-choice-owner-p2zt").textContent).toContain(
      "holds “a.md”",
    );
    await fireEvent.click(getByTestId("chat-message-owner-choice-owner-p2zt"));
    await settle();
    expect(posts()).toEqual([
      {
        url: expect.stringMatching(/\/api\/ownership$/),
        body: { messageId: "m", action: "assign", ownerLabel: "owner-p2zt" },
      },
    ]);
    expect(queryByTestId("chat-message-owner-menu")).toBeNull();
  });

  it("an Assign refusal shows inline and the list stays open; Escape closes it", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(409, { error: "owner-detached" });
      return jsonResponse(200, {
        data: [{ label: "owner-p2zt", displayKind: "terminal", holds: [], canTake: true }],
      });
    });
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    await fireEvent.click(getByTestId("chat-message-owner-assign-m"));
    await settle();
    await fireEvent.click(getByTestId("chat-message-owner-choice-owner-p2zt"));
    await settle();
    expect(getByTestId("chat-message-owner-error-m").textContent?.trim()).toBe(
      "That session just disconnected — pick another or Release",
    );
    expect(getByTestId("chat-message-owner-menu")).toBeTruthy();
    await fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    expect(queryByTestId("chat-message-owner-menu")).toBeNull();
  });

  it("keeps the owners list inside the window's right edge", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const { getByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    const assign = getByTestId("chat-message-owner-assign-m");
    const right = window.innerWidth - 40;
    assign.getBoundingClientRect = () =>
      ({ left: right, right: right + 30, top: 10, bottom: 20, width: 30, height: 10 }) as DOMRect;
    await fireEvent.click(assign);
    await settle();
    const left = Number.parseFloat(getByTestId("chat-message-owner-menu").style.left);
    expect(left + 320).toBeLessThanOrEqual(window.innerWidth);
  });

  it("an owners list fetched for an earlier opening never fills a later one", async () => {
    const resolvers: Array<(r: unknown) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    const assign = getByTestId("chat-message-owner-assign-m");
    await fireEvent.click(assign);
    await fireEvent.click(assign);
    await fireEvent.click(assign);
    await settle();
    expect(resolvers).toHaveLength(2);
    resolvers[0]?.(
      jsonResponse(200, {
        data: [{ label: "owner-old", displayKind: "terminal", holds: [], canTake: true }],
      }),
    );
    await settle();
    expect(queryByTestId("chat-message-owner-choice-owner-old")).toBeNull();
    resolvers[1]?.(
      jsonResponse(200, {
        data: [{ label: "owner-new", displayKind: "terminal", holds: [], canTake: true }],
      }),
    );
    await settle();
    expect(getByTestId("chat-message-owner-choice-owner-new")).toBeTruthy();
  });

  it("Escape from a row of the list hands focus back to Assign…", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ label: "owner-p2zt", displayKind: "terminal", holds: [], canTake: true }],
      }),
    );
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    const assign = getByTestId("chat-message-owner-assign-m");
    await fireEvent.click(assign);
    await settle();
    getByTestId("chat-message-owner-choice-owner-p2zt").focus();
    await fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    expect(queryByTestId("chat-message-owner-menu")).toBeNull();
    expect(document.activeElement).toBe(assign);
  });

  it("an empty owners list says so", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const { getByTestId } = render(ChatPanel, {
      props: chatProps([user("m")], new Map([["m", facts()]]), SUMMARY),
    });
    await fireEvent.click(getByTestId("chat-message-owner-assign-m"));
    await settle();
    expect(getByTestId("chat-message-owner-menu").textContent).toContain(
      "No session can take it now",
    );
  });
});

describe("the composer line's Start for stale chat (ownership design §10.2)", () => {
  it("offers 5b's Start with its take-back list where a message is stale and Start can help", async () => {
    const onRemedy = vi.fn();
    const stale = { ...SUMMARY, tandemPresent: false, tandemRunning: false, otherAiAttached: true };
    const line = composerLine(undefined, { ...stale, chatStale: true, tandemStartable: true });
    expect(line).toEqual({ kind: "to", text: "→ the first session to check in", remedy: "start" });
    const { getByTestId } = render(ChatPanel, {
      props: chatProps([], EMPTY, null, {
        ownerLine: line,
        ownerLineTakeBack: "Starting takes back “a.md”",
        onOwnerLineRemedy: onRemedy,
      }),
    });
    const action = getByTestId("chat-owner-line-action");
    expect(action.getAttribute("data-remedy")).toBe("start");
    expect(action.textContent?.trim()).toBe("Start Tandem's Claude");
    expect(getByTestId("chat-owner-line").textContent).toContain("Starting takes back “a.md”");
    await fireEvent.click(action);
    expect(onRemedy).toHaveBeenCalledWith("start");
  });

  it("offers nothing more with no stale chat, or where Start cannot help", () => {
    const base = { ...SUMMARY, tandemPresent: false, tandemRunning: false, otherAiAttached: true };
    expect(composerLine(undefined, { ...base, chatStale: false, tandemStartable: true })).toEqual({
      kind: "to",
      text: "→ the first session to check in",
    });
    expect(composerLine(undefined, { ...base, chatStale: true, tandemStartable: false })).toEqual({
      kind: "to",
      text: "→ the first session to check in",
    });
  });
});

/** The wiring no rendered component reaches (App mounts nothing in tests). */
describe("wiring, from source", () => {
  const root = join(import.meta.dirname, "../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("App hands the per-message facts and the summary to the chat panel", () => {
    const app = read("src/client/App.svelte");
    expect(app).toMatch(/messageOwners=\{yjsSync\.chatOwners\}/);
    expect(app).toMatch(/ownershipSummary=\{yjsSync\.ownershipSummary\}\s*\/>/);
  });

  it("the message controls never write a published key or a Y.Doc", () => {
    for (const f of [
      "src/client/panels/ChatMessageOwnerLine.svelte",
      "src/client/panels/ChatPanel.svelte",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/Y_MAP_OWNERSHIP_CHAT|Y_MAP_OWNERSHIP_SUMMARY/);
      expect(src, f).not.toMatch(/\.transact\(|withBrowser\(/);
    }
  });
});
