// @vitest-environment happy-dom

/**
 * The editor's ownership controls (#2358 PR 5b, ADR-054's 5b amendment;
 * ownership design §10.1, §10.2): the badge on a tab, its popover (Release,
 * Assign from `GET /api/ownership/owners`, Start), the native menu's two
 * leaves, and the composer line. The pure rules are `ownership-owner-view.test.ts`'s.
 *
 * **The dark pin.** A dark server publishes no owner key on any entry and no
 * summary, so the tab strip, the native menu request and the chat panel must
 * render exactly as they did before 5b. Each surface is rendered from a dark
 * server's state, through the same readers the client uses, and compared with
 * the same surface rendered with no ownership input at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { registerAction, unregisterAction } from "../../src/client/actions/registry.svelte";
import CommandPalette from "../../src/client/components/CommandPalette.svelte";
import {
  composerLine,
  ownerFieldsFromList,
  readOwnerFields,
  readOwnershipSummary,
} from "../../src/client/ownership/owner-view";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import StatusBar from "../../src/client/status/StatusBar.svelte";
import DocumentTabs from "../../src/client/tabs/DocumentTabs.svelte";
import {
  buildTabMenuContext,
  TAB_CONTEXT_MENU_ACTION_IDS,
} from "../../src/client/tabs/tab-context-menu";
import type { OpenTab } from "../../src/client/types";
import type { OwnershipSummary, PublishedOwnerFields } from "../../src/shared/ownership-published";
import type { ChatMessage } from "../../src/shared/types";

function makeTab(id: string): OpenTab {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `/tmp/${id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
    ydoc: new Y.Doc(),
    provider: {} as unknown as OpenTab["provider"],
  };
}

/** A dark server's `Y_MAP_OPEN_DOCUMENTS` entry: `toDocListEntry`'s six keys. */
function darkEntry(tab: OpenTab) {
  return {
    id: tab.id,
    filePath: tab.filePath,
    fileName: tab.fileName,
    format: tab.format,
    readOnly: tab.readOnly,
    source: tab.source,
  };
}

/** What yjsSync builds from a list (the same function). */
function ownersFrom(entries: Array<{ id: string }>): ReadonlyMap<string, PublishedOwnerFields> {
  return ownerFieldsFromList(entries, new Map());
}

const SUMMARY: OwnershipSummary = {
  tandemPresent: true,
  tandemRunning: true,
  tandemStartable: true,
  notPresentReason: null,
  otherAiAttached: true,
  chatWaiting: false,
  chatStale: false,
};

function stripProps(tabs: OpenTab[]) {
  return { tabs, activeTabId: tabs[0]?.id ?? null, onTabSwitch: vi.fn(), onTabClose: vi.fn() };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // biome-ignore lint/suspicious/noExplicitAny: test stub (happy-dom lacks the Web Animations API)
  (Element.prototype as any).animate = () => ({ cancel() {}, onfinish: null, effect: null });
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (Element.prototype as any).getAnimations = () => [];
});

afterEach(async () => {
  // Unmount, not only clear the body: a mounted palette or popover keeps its
  // window and document listeners, which would see the next test's events.
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  // Let a closed popover's deferred focus hand-back run against this empty
  // body: left pending, it would fire in the next test and, its badge gone,
  // fall back to that test's tab of the same id.
  await new Promise((r) => setTimeout(r, 0));
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe("flag off: the client renders exactly as today", () => {
  it("renders the same tab strip from a dark server's entries as with no ownership input", async () => {
    const tabs = [makeTab("a"), makeTab("b")];
    const plain = render(DocumentTabs, { props: stripProps(tabs) });
    const before = plain.container.innerHTML;
    plain.unmount();

    const owners = ownersFrom(tabs.map(darkEntry));
    expect(owners.size).toBe(0);
    const dark = render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        ownerFields: owners,
        ownershipSummary: readOwnershipSummary(undefined),
      },
    });
    expect(dark.container.innerHTML).toBe(before);
    expect(dark.queryByTestId("tab-owner-badge")).toBeNull();
    expect(dark.queryByTestId("tab-owner-menu")).toBeNull();
    // No clock is armed for an empty ownership state.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the native menu for no ownership leaf", () => {
    const tabs = [makeTab("a")];
    const plain = buildTabMenuContext(tabs, "a");
    expect(plain).toMatchObject({
      ownerRelease: false,
      ownerReleaseToTandem: false,
      ownerAssign: false,
    });
  });

  it("renders no composer line from a dark server's state", () => {
    const line = composerLine(
      readOwnerFields(darkEntry(makeTab("a"))),
      readOwnershipSummary(undefined),
    );
    expect(line).toBeNull();
    const { queryByTestId } = render(ChatPanel, { props: chatProps(line) });
    expect(queryByTestId("chat-owner-line")).toBeNull();
  });
});

describe("the owner badge and its popover", () => {
  const held: PublishedOwnerFields = {
    owner: { label: "owner-k7qx", displayKind: "terminal", kind: "claimed" },
    stale: null,
    hint: null,
    waitingSince: null,
  };

  function renderHeld(
    fields: PublishedOwnerFields = held,
    summary: OwnershipSummary | null = SUMMARY,
  ) {
    const tabs = [makeTab("a"), makeTab("b")];
    const onStartTandemClaude = vi.fn();
    const r = render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        ownerFields: new Map([["a", fields]]),
        ownershipSummary: summary,
        onStartTandemClaude,
      },
    });
    return { ...r, onStartTandemClaude };
  }

  it("shows the holder on the tab it holds, and only there", () => {
    const { getAllByTestId, getByTestId } = renderHeld();
    const badges = getAllByTestId("tab-owner-badge");
    expect(badges).toHaveLength(1);
    expect(getByTestId("tab-a").contains(badges[0])).toBe(true);
    expect(badges[0].textContent?.trim()).toBe("terminal owner-k7qx");
    expect(badges[0].getAttribute("title")).toBe("terminal owner-k7qx · claimed");
  });

  it("marks a stale holder", () => {
    const { getByTestId } = renderHeld({ ...held, stale: "disconnected" });
    const badge = getByTestId("tab-owner-badge");
    expect(badge.textContent?.trim()).toBe("terminal owner-k7qx (disconnected)");
    expect(badge.dataset.stale).toBe("disconnected");
  });

  it("opens the popover, lists the owners and Releases to Tandem's Claude", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ownership/owners")) {
        return jsonResponse(200, {
          data: [
            { label: "owner-t000", displayKind: "Tandem's Claude", holds: ["b.md"], canTake: true },
            { label: "owner-k7qx", displayKind: "terminal", holds: ["a.md"], canTake: true },
          ],
        });
      }
      if (url.endsWith("/api/ownership") && init?.method === "POST") {
        return jsonResponse(200, { data: { changed: true } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const { getByTestId, queryByTestId } = renderHeld();
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    const menu = getByTestId("tab-owner-menu");
    expect(menu.textContent).toContain("terminal owner-k7qx · claimed");
    expect(getByTestId("tab-owner-release").textContent).toContain("Back to Tandem's Claude");
    expect(getByTestId("tab-owner-assign-owner-t000").textContent).toContain("Tandem's Claude");
    expect(getByTestId("tab-owner-assign-owner-k7qx").textContent).toContain("holds “a.md”");

    await fireEvent.click(getByTestId("tab-owner-release"));
    await settle();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ documentId: "a", action: "release" });
    expect(queryByTestId("tab-owner-menu")).toBeNull();
  });

  it("Assigns by label and shows a refusal inline", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ownership/owners")) {
        return jsonResponse(200, {
          data: [{ label: "owner-p2zt", displayKind: "Claude Desktop", holds: [], canTake: true }],
        });
      }
      if (init?.method === "POST") return jsonResponse(409, { error: "busy" });
      throw new Error(`unexpected ${url}`);
    });
    const { getByTestId } = renderHeld();
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    await fireEvent.click(getByTestId("tab-owner-assign-owner-p2zt"));
    await settle();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      documentId: "a",
      action: "assign",
      ownerLabel: "owner-p2zt",
    });
    expect(getByTestId("tab-owner-error").textContent).toBe(
      "An operation is in progress — try again",
    );
    expect(getByTestId("tab-owner-menu")).toBeTruthy();
  });

  it("speaks a refusal through a region mounted before it (#1431, #2489)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ownership/owners")) return jsonResponse(200, { data: [] });
      if (init?.method === "POST") return jsonResponse(409, { error: "busy" });
      throw new Error(`unexpected ${url}`);
    });
    const { getByTestId, queryByTestId } = renderHeld();
    // The region exists, empty, before any popover or refusal.
    const region = getByTestId("tab-owner-announcer");
    expect(region.getAttribute("role")).toBe("alert");
    expect(region.textContent).toBe("");
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    await fireEvent.click(getByTestId("tab-owner-release"));
    await settle();
    // The same node now holds the sentence: a mutation, not an insertion.
    expect(getByTestId("tab-owner-announcer")).toBe(region);
    expect(region.textContent).toBe("An operation is in progress — try again");
    // The visible copy, inserted with its text, is not itself a live region.
    const visible = getByTestId("tab-owner-error");
    expect(visible.getAttribute("role")).toBeNull();
    expect(visible.getAttribute("aria-hidden")).toBe("true");
    // Closing empties it, so the same refusal next time is a change again.
    await fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    expect(queryByTestId("tab-owner-menu")).toBeNull();
    expect(region.textContent).toBe("");
  });

  it("lets window shortcuts through while the badge holds focus", async () => {
    const { getByTestId } = renderHeld();
    const badge = getByTestId("tab-owner-badge");
    badge.focus();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    try {
      await fireEvent.keyDown(badge, { key: "s", ctrlKey: true });
    } finally {
      window.removeEventListener("keydown", seen);
    }
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("hides Release where it changes nothing and Assign when nobody can take it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const { getByTestId, queryByTestId } = renderHeld(
      { owner: null, stale: null, hint: null, waitingSince: null },
      SUMMARY,
    );
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    expect(getByTestId("tab-owner-menu").textContent).toContain("Unassigned");
    expect(queryByTestId("tab-owner-release")).toBeNull();
    expect(queryByTestId("tab-owner-menu")?.textContent).not.toContain("Assign");
  });

  it("says where an unassigned Release goes while Tandem's Claude is not present", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const { getByTestId } = renderHeld(held, {
      ...SUMMARY,
      tandemPresent: false,
      tandemRunning: false,
    });
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    expect(getByTestId("tab-owner-release").textContent).toContain(
      "Unassigned — the next session to check in takes it, or Tandem's Claude when it is turned on; this one won't take it back on its own",
    );
  });

  it("offers Start on a hint, listing what it takes back", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const tabs = [makeTab("a"), makeTab("b")];
    const onStartTandemClaude = vi.fn();
    const { getByTestId, queryByTestId } = render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        ownerFields: new Map<string, PublishedOwnerFields>([
          [
            "a",
            {
              owner: { label: "owner-t000", displayKind: "Tandem's Claude", kind: "default" },
              stale: null,
              hint: "start-to-answer",
              waitingSince: Date.now() - 3 * 60_000,
            },
          ],
          ["b", held],
        ]),
        ownershipSummary: { ...SUMMARY, tandemRunning: false, otherAiAttached: false },
        onStartTandemClaude,
      },
    });
    const badge = getByTestId("tab-a").querySelector(
      '[data-testid="tab-owner-badge"]',
    ) as HTMLElement;
    expect(badge.textContent?.trim()).toBe("Waiting — Start to answer");
    await fireEvent.click(badge);
    await settle();
    expect(getByTestId("tab-owner-start").textContent).toContain("Starting takes back “b.md”");
    await fireEvent.click(getByTestId("tab-owner-start"));
    expect(onStartTandemClaude).toHaveBeenCalledOnce();
    expect(queryByTestId("tab-owner-menu")).toBeNull();
  });

  it("closes on Escape and when the entry loses its owner fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const tabs = [makeTab("a")];
    const r = render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        ownerFields: new Map([["a", held]]),
        ownershipSummary: SUMMARY,
      },
    });
    await fireEvent.click(r.getByTestId("tab-owner-badge"));
    await settle();
    await fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();

    await fireEvent.click(r.getByTestId("tab-owner-badge"));
    await settle();
    expect(r.getByTestId("tab-owner-menu")).toBeTruthy();
    await r.rerender({ ...stripProps(tabs), ownerFields: new Map(), ownershipSummary: null });
    await settle();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
    expect(r.queryByTestId("tab-owner-badge")).toBeNull();
    // The fields coming back does not reopen a popover nobody asked for.
    await r.rerender({
      ...stripProps(tabs),
      ownerFields: new Map([["a", held]]),
      ownershipSummary: SUMMARY,
    });
    await settle();
    expect(r.getByTestId("tab-owner-badge")).toBeTruthy();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
  });

  it("leaves an Escape another handler already took open (the palette's capture listener)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const r = renderHeld();
    await fireEvent.click(r.getByTestId("tab-owner-badge"));
    await settle();
    // The command palette closes itself on Escape from a capture-phase window
    // listener and preventDefaults; this stands in for it.
    const take = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", take, { capture: true });
    try {
      await fireEvent.keyDown(document, { key: "Escape", cancelable: true });
      await settle();
      expect(r.getByTestId("tab-owner-menu")).toBeTruthy();
    } finally {
      window.removeEventListener("keydown", take, { capture: true });
    }
    // Control: the same Escape, not taken, closes it.
    await fireEvent.keyDown(document, { key: "Escape", cancelable: true });
    await settle();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
  });

  it("leaves an Escape that cancels an IME composition open", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const r = renderHeld();
    await fireEvent.click(r.getByTestId("tab-owner-badge"));
    await settle();
    await fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    await settle();
    expect(r.getByTestId("tab-owner-menu")).toBeTruthy();
    await fireEvent.keyDown(document, { key: "Escape", isComposing: false });
    await settle();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
  });

  it("a second press on the badge closes its popover (mousedown is not outside)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const { getByTestId, queryByTestId } = renderHeld();
    const badge = getByTestId("tab-owner-badge");
    await fireEvent.mouseDown(badge);
    await fireEvent.click(badge);
    await settle();
    expect(getByTestId("tab-owner-menu")).toBeTruthy();
    await fireEvent.mouseDown(badge);
    await fireEvent.click(badge);
    await settle();
    expect(queryByTestId("tab-owner-menu")).toBeNull();
    expect(badge.getAttribute("aria-expanded")).toBe("false");
  });

  it("a Release settling after its popover closed does not close the next one", async () => {
    let resolvePost: (r: ReturnType<typeof jsonResponse>) => void = () => {};
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ownership/owners")) return jsonResponse(200, { data: [] });
      if (init?.method === "POST") {
        return new Promise<ReturnType<typeof jsonResponse>>((res) => {
          resolvePost = res;
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const { getByTestId } = renderHeld();
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    await fireEvent.click(getByTestId("tab-owner-release"));
    // Escape closes the first popover while its Release is in flight; then reopen.
    await fireEvent.keyDown(document, { key: "Escape" });
    await settle();
    await fireEvent.click(getByTestId("tab-owner-badge"));
    await settle();
    expect(getByTestId("tab-owner-menu")).toBeTruthy();
    resolvePost(jsonResponse(200, { data: { changed: true } }));
    await settle();
    expect(getByTestId("tab-owner-menu")).toBeTruthy();
  });

  it("does not switch tabs when the badge is clicked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const tabs = [makeTab("a"), makeTab("b")];
    const onTabSwitch = vi.fn();
    const { getByTestId } = render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        activeTabId: "b",
        onTabSwitch,
        ownerFields: new Map([["a", held]]),
        ownershipSummary: SUMMARY,
      },
    });
    await fireEvent.click(getByTestId("tab-owner-badge"));
    expect(onTabSwitch).not.toHaveBeenCalled();
  });
});

describe("the native menu's leaves", () => {
  it("asks for Release and Assign from the published state", () => {
    const tabs = [makeTab("a")];
    expect(
      buildTabMenuContext(tabs, "a", false, { release: true, releaseToTandem: true, assign: true }),
    ).toMatchObject({ ownerRelease: true, ownerReleaseToTandem: true, ownerAssign: true });
    expect(
      buildTabMenuContext(tabs, "a", false, {
        release: false,
        releaseToTandem: true,
        assign: false,
      }),
    ).toMatchObject({ ownerRelease: false, ownerReleaseToTandem: false, ownerAssign: false });
    expect(
      buildTabMenuContext(tabs, "gone", false, {
        release: true,
        releaseToTandem: true,
        assign: true,
      }),
    ).toMatchObject({ ownerRelease: false, ownerAssign: false });
  });

  it("Rust emits exactly the tab ids the webview accepts", () => {
    const rust = readFileSync(
      join(import.meta.dirname, "../../src-tauri/src/context_menu.rs"),
      "utf8",
    );
    const production = rust.slice(0, rust.indexOf("#[cfg(test)]"));
    const rustIds = [...new Set(production.match(/"ctx:tab:[A-Za-z]+"/g) ?? [])]
      .map((s) => s.slice(1, -1))
      .sort();
    expect(rustIds).toContain("ctx:tab:release");
    expect(rustIds).toContain("ctx:tab:assign");
    expect(rustIds).toEqual([...TAB_CONTEXT_MENU_ACTION_IDS].sort());
  });
});

function chatProps(
  ownerLine: ReturnType<typeof composerLine>,
  onOwnerLineRemedy: (r: "start" | "settings") => void = () => {},
  ownerLineTakeBack: string | null = null,
) {
  return {
    messages: [] as ChatMessage[],
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
    ownerLine,
    ownerLineTakeBack,
    onOwnerLineRemedy,
    pickupClock: new Map(),
    messageOwners: new Map(),
    ownershipSummary: null,
  };
}

describe("the composer line", () => {
  it("names who will answer", () => {
    const { getByTestId, queryByTestId } = render(ChatPanel, {
      props: chatProps({ kind: "to", text: "→ terminal owner-k7qx" }),
    });
    expect(getByTestId("chat-owner-line").textContent?.trim()).toBe("→ terminal owner-k7qx");
    expect(queryByTestId("chat-owner-line-action")).toBeNull();
  });

  it("offers Start or Settings when no AI will answer", async () => {
    const onRemedy = vi.fn();
    const start = render(ChatPanel, {
      props: chatProps(
        { kind: "none", text: "No AI will answer", remedy: "start" },
        onRemedy,
        "Starting takes back “a.md”",
      ),
    });
    expect(start.getByTestId("chat-owner-line").textContent).toContain(
      "Starting takes back “a.md”",
    );
    await fireEvent.click(start.getByTestId("chat-owner-line-action"));
    expect(onRemedy).toHaveBeenCalledWith("start");
    start.unmount();

    const settings = render(ChatPanel, {
      props: chatProps(
        { kind: "none", text: "No AI will answer", remedy: "settings" },
        onRemedy,
        "x",
      ),
    });
    expect(settings.getByTestId("chat-owner-line-action").textContent?.trim()).toBe(
      "Open Settings",
    );
    expect(settings.container.querySelector(".chat-owner-line-note")).toBeNull();
    await fireEvent.click(settings.getByTestId("chat-owner-line-action"));
    expect(onRemedy).toHaveBeenLastCalledWith("settings");
  });
});

/**
 * The wiring no rendered component reaches: `createYjsSync` needs live
 * providers and App mounts nothing in tests, so these are pinned from source.
 */
describe("wiring, from source", () => {
  const root = join(import.meta.dirname, "../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("yjsSync reads the owner fields from every list it reconciles and the summary from CTRL_ROOM's awareness map", () => {
    const sync = read("src/client/hooks/yjsSync.svelte.ts");
    expect(sync).toMatch(/ownerFieldsFromList\(docList, ownerFieldsState\)/);
    expect(sync).toMatch(/ydoc\.getMap\(Y_MAP_USER_AWARENESS\)/);
    expect(sync).toMatch(/readOwnershipSummary\(userAwareness\.get\(Y_MAP_OWNERSHIP_SUMMARY\)\)/);
    expect(sync).toMatch(/userAwareness\.unobserve\(summaryObserver\)/);
  });

  it("the client never writes the published keys (the server's guard reverts any write)", () => {
    const files = [
      "src/client/hooks/yjsSync.svelte.ts",
      "src/client/App.svelte",
      "src/client/tabs/DocumentTabs.svelte",
      "src/client/tabs/TabOwnerPopover.svelte",
      "src/client/ownership/owner-view.ts",
      "src/client/ownership/ownership-api.ts",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\.set\(\s*Y_MAP_OWNERSHIP_SUMMARY/);
      expect(src, f).not.toMatch(/\.set\(\s*Y_MAP_OPEN_DOCUMENTS/);
    }
  });

  it("App hands the published state to the tab strip and the composer line to the chat panel", () => {
    const app = read("src/client/App.svelte");
    expect(app).toMatch(/ownerFields=\{yjsSync\.ownerFields\}/);
    expect(app).toMatch(/ownershipSummary=\{yjsSync\.ownershipSummary\}/);
    expect(app).toMatch(/onStartTandemClaude=\{startClaude\}/);
    expect(app).toMatch(/ownerLine=\{ownerComposerLine\}/);
    expect(app).toMatch(/ownerLineTakeBack=\{ownerTakeBackText\}/);
    expect(app).toMatch(
      /composerLine\(\s*yjsSync\.activeTabId === null \? undefined : yjsSync\.ownerFields\.get\(yjsSync\.activeTabId\),\s*yjsSync\.ownershipSummary,\s*\)/,
    );
  });
});

/**
 * Every Start says which documents it takes back (design §10.2; Bryan,
 * 2026-11-24, "Yes, all Starts (Recommended)"): the chat header's Start and
 * the status bar's Start chip, from the same `takeBackText` the popover and
 * the composer line use. Null while ownership is off, which leaves both as today.
 */
describe("every Start lists what it takes back", () => {
  const TAKE_BACK = "Starting takes back “a.md”";

  function renderHeader(control: "start" | "turn-off", takeBack: string | null) {
    return render(ChatPanel, {
      props: { ...chatProps(null, () => {}, takeBack), tandemClaudeControl: control },
    });
  }

  it("the chat header's Start shows the sentence and adds it to its title", () => {
    const { getByTestId } = renderHeader("start", TAKE_BACK);
    expect(getByTestId("chat-tandem-claude-take-back").textContent?.trim()).toBe(TAKE_BACK);
    expect(getByTestId("chat-tandem-claude-toggle").getAttribute("title")).toBe(
      `Start Tandem's Claude. Its conversation resumes. ${TAKE_BACK}.`,
    );
  });

  it("Turn off says nothing about taking back", () => {
    const { getByTestId, queryByTestId } = renderHeader("turn-off", TAKE_BACK);
    expect(queryByTestId("chat-tandem-claude-take-back")).toBeNull();
    expect(getByTestId("chat-tandem-claude-toggle").getAttribute("title")).not.toContain(
      "takes back",
    );
  });

  it("flag off (no sentence): the header renders as before", () => {
    const { getByTestId, queryByTestId } = renderHeader("start", null);
    expect(queryByTestId("chat-tandem-claude-take-back")).toBeNull();
    expect(getByTestId("chat-tandem-claude-toggle").getAttribute("title")).toBe(
      "Start Tandem's Claude. Its conversation resumes.",
    );
  });

  const barProps = {
    connected: true,
    connectionStatus: "connected" as const,
    reconnectAttempts: 0,
    disconnectedSince: null,
    claudeStatus: null,
    claudeActive: false,
    aiLiveIndicator: null,
    aiLauncherAttached: false,
    aiLocalChat: null,
    aiLauncherRestarting: false,
    aiLauncherStarting: false,
    aiLauncherStandby: "off" as const,
    aiLauncherStandbyRecent: false,
    onStartClaude: () => {},
    aiSessionCount: null,
    aiNotice: null,
    onOpenLicenseSettings: () => {},
    aiState: "stopped" as const,
    soloMode: false,
    aiChip: "start" as const,
  };

  it("the status bar's Start chip adds the sentence to its title and name", () => {
    const plain = render(StatusBar, { props: barProps });
    const chip = plain.getByTestId("status-ai-indicator");
    const title = chip.getAttribute("title") ?? "";
    const label = chip.getAttribute("aria-label") ?? "";
    const before = plain.container.innerHTML;
    plain.unmount();

    // Flag off: a null sentence renders exactly as the bar with no prop.
    const dark = render(StatusBar, { props: { ...barProps, startTakeBack: null } });
    expect(dark.container.innerHTML).toBe(before);
    dark.unmount();

    const lit = render(StatusBar, { props: { ...barProps, startTakeBack: TAKE_BACK } });
    const litChip = lit.getByTestId("status-ai-indicator");
    expect(litChip.getAttribute("title")).toBe(`${title} ${TAKE_BACK}.`);
    expect(litChip.getAttribute("aria-label")).toBe(`${label} ${TAKE_BACK}.`);
  });

  it("only the Start chip carries it", () => {
    const { getByTestId } = render(StatusBar, {
      props: { ...barProps, aiChip: "restart" as const, startTakeBack: TAKE_BACK },
    });
    expect(getByTestId("status-ai-indicator").getAttribute("title")).not.toContain("takes back");
  });

  it("App hands the same sentence to the status bar", () => {
    const app = readFileSync(join(import.meta.dirname, "../../src/client/App.svelte"), "utf8");
    expect(app).toMatch(/startTakeBack=\{ownerTakeBackText\}/);
  });
});

/**
 * The rest of the Starts (Bryan, 2026-11-24, "Yes, all Starts (Recommended)"):
 * the failed resume row's remedy and the late-greeting note's action when they
 * offer `start` (both run through App's `aiCtaHandler`), and the command
 * palette's `launcher-start`. Null while ownership is off: markup unchanged.
 */
describe("every Start lists what it takes back: the chat rows and the palette", () => {
  const TAKE_BACK = "Starting takes back “a.md”";

  function renderResume(remedy: "start" | "restart", takeBack: string | null) {
    return render(ChatPanel, {
      props: {
        ...chatProps(null, () => {}, takeBack),
        tandemClaudeResume: { kind: "failed" as const, remedy },
      },
    });
  }

  function renderGreeting(action: "start" | "restart" | "relaunch", takeBack: string | null) {
    return render(ChatPanel, {
      props: { ...chatProps(null, () => {}, takeBack), tandemClaudeGreetingLate: action },
    });
  }

  it("the resume row's Start remedy shows the sentence and adds it to its title and name", () => {
    const { getByTestId } = renderResume("start", TAKE_BACK);
    expect(getByTestId("chat-tandem-claude-resume-take-back").textContent?.trim()).toBe(TAKE_BACK);
    const button = getByTestId("chat-tandem-claude-resume-remedy");
    expect(button.getAttribute("title")).toBe(
      `Tandem's Claude isn't running. Click to start it. ${TAKE_BACK}.`,
    );
    expect(button.getAttribute("aria-label")).toBe(`Start Tandem's Claude. ${TAKE_BACK}.`);
  });

  it("the resume row's other remedies say nothing about taking back", () => {
    const { getByTestId, queryByTestId } = renderResume("restart", TAKE_BACK);
    expect(queryByTestId("chat-tandem-claude-resume-take-back")).toBeNull();
    expect(getByTestId("chat-tandem-claude-resume-remedy").getAttribute("title")).not.toContain(
      "takes back",
    );
  });

  it("the late-greeting note's Start shows the sentence and adds it to its title and name", () => {
    const { getByTestId } = renderGreeting("start", TAKE_BACK);
    expect(getByTestId("chat-greeting-late-take-back").textContent?.trim()).toBe(TAKE_BACK);
    const button = getByTestId("chat-greeting-late-action");
    expect(button.getAttribute("title")).toBe(
      `Tandem's Claude isn't running. Click to start it. ${TAKE_BACK}.`,
    );
    expect(button.getAttribute("aria-label")).toBe(`Start Tandem's Claude. ${TAKE_BACK}.`);
  });

  it("the late-greeting note's relaunch and restart say nothing about taking back", () => {
    for (const action of ["relaunch", "restart"] as const) {
      const r = renderGreeting(action, TAKE_BACK);
      expect(r.queryByTestId("chat-greeting-late-take-back"), action).toBeNull();
      expect(
        r.getByTestId("chat-greeting-late-action").getAttribute("title"),
        action,
      ).not.toContain("takes back");
      r.unmount();
    }
  });

  it("flag off (no sentence): both rows render exactly as before", () => {
    for (const renderRow of [
      () => renderResume("start", null),
      () => renderGreeting("start", null),
    ]) {
      const dark = renderRow();
      expect(dark.queryByTestId("chat-tandem-claude-resume-take-back")).toBeNull();
      expect(dark.queryByTestId("chat-greeting-late-take-back")).toBeNull();
      const html = dark.container.innerHTML;
      expect(html).not.toContain("takes back");
      dark.unmount();
    }
    const resume = renderResume("start", null);
    expect(resume.getByTestId("chat-tandem-claude-resume-remedy").getAttribute("title")).toBe(
      "Tandem's Claude isn't running. Click to start it.",
    );
    expect(resume.getByTestId("chat-tandem-claude-resume-remedy").getAttribute("aria-label")).toBe(
      "Start Tandem's Claude.",
    );
    resume.unmount();
    const greeting = renderGreeting("start", null);
    expect(greeting.getByTestId("chat-greeting-late-action").getAttribute("title")).toBe(
      "Tandem's Claude isn't running. Click to start it.",
    );
  });

  describe("the command palette's Start", () => {
    beforeEach(() => {
      registerAction(
        { id: "launcher-start", label: "Start Tandem's Claude", group: "claude", run() {} },
        { replace: true },
      );
    });
    afterEach(() => {
      unregisterAction("launcher-start");
    });

    function renderPalette(details?: ReadonlyMap<string, string>) {
      return render(CommandPalette, {
        props: {
          open: true,
          onClose: () => {},
          editor: null,
          annotations: [],
          ...(details ? { actionDetails: details } : {}),
        },
      });
    }

    it("shows the sentence under the entry's label", async () => {
      const { getByTestId } = renderPalette(new Map([["launcher-start", TAKE_BACK]]));
      await settle();
      const item = getByTestId("palette-item-launcher-start");
      expect(getByTestId("palette-item-detail-launcher-start").textContent?.trim()).toBe(TAKE_BACK);
      expect(item.textContent).toContain("Start Tandem's Claude");
      expect(item.textContent).toContain(TAKE_BACK);
    });

    it("flag off (no details): the palette renders exactly as with no prop", async () => {
      const plain = renderPalette();
      await settle();
      const before = plain.getByTestId("palette-item-launcher-start").outerHTML;
      plain.unmount();
      const dark = renderPalette(new Map());
      await settle();
      expect(dark.queryByTestId("palette-item-detail-launcher-start")).toBeNull();
      expect(dark.getByTestId("palette-item-launcher-start").outerHTML).toBe(before);
    });

    it("App gives the sentence to launcher-start only, and only while a Start would start", () => {
      const root = join(import.meta.dirname, "../..");
      const app = readFileSync(join(root, "src/client/App.svelte"), "utf8");
      expect(app).toMatch(/actionDetails=\{paletteDetails\}/);
      expect(app).toMatch(
        /ownerTakeBackText !== null && !aiReadiness\.launcherRunning\s*\?\s*new Map\(\[\["launcher-start", ownerTakeBackText\]\]\)\s*:\s*NO_PALETTE_DETAILS/,
      );
      const builtin = readFileSync(join(root, "src/client/actions/builtin.svelte.ts"), "utf8");
      expect(builtin).toMatch(/id: "launcher-start",\s*label: "Start Tandem's Claude"/);
    });
  });
});

/**
 * The popover is a dialog (role="dialog"), so it takes focus when it opens and
 * gives it back to its opener when it closes (Escape, an outside press, or a
 * successful action), or to its tab when the opener has left the DOM.
 */
describe("the owner popover's focus", () => {
  const held: PublishedOwnerFields = {
    owner: { label: "owner-k7qx", displayKind: "terminal", kind: "claimed" },
    stale: null,
    hint: null,
    waitingSince: null,
  };

  function renderStrip(fields: PublishedOwnerFields = held) {
    const tabs = [makeTab("a")];
    return render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        ownerFields: new Map([["a", fields]]),
        ownershipSummary: SUMMARY,
      },
    });
  }

  /** Past the popover's deferred hand-back (a zero-delay timer). */
  async function nextTask() {
    await settle();
    await new Promise((r) => setTimeout(r, 0));
    await settle();
  }

  it("focuses the first row on open and returns focus to the badge on Escape", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const r = renderStrip();
    const badge = r.getByTestId("tab-owner-badge");
    badge.focus();
    await fireEvent.click(badge);
    await settle();
    expect(document.activeElement).toBe(r.getByTestId("tab-owner-release"));
    await fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await nextTask();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("holds focus on the dialog until the owners list brings a row", async () => {
    let resolve: (v: unknown) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    // With a Release row, focus is on it at once, before the owners list answers.
    const held1 = renderStrip();
    await fireEvent.click(held1.getByTestId("tab-owner-badge"));
    await settle();
    expect(document.activeElement).toBe(held1.getByTestId("tab-owner-release"));
    held1.unmount();
    // Unowned with Tandem's Claude present: no Release, so nothing to focus yet.
    const r = renderStrip({ owner: null, stale: null, hint: null, waitingSince: null });
    await fireEvent.click(r.getByTestId("tab-owner-badge"));
    await settle();
    const menu = r.getByTestId("tab-owner-menu");
    expect(r.queryByTestId("tab-owner-release")).toBeNull();
    expect(document.activeElement).toBe(menu);
    resolve(
      jsonResponse(200, {
        data: [{ label: "owner-p2zt", displayKind: "Claude Desktop", holds: [], canTake: true }],
      }),
    );
    await settle();
    expect(document.activeElement).toBe(r.getByTestId("tab-owner-assign-owner-p2zt"));
  });

  it("returns focus to the badge after a successful action, and keeps it inside on a refusal", async () => {
    let status = 409;
    let answer: () => void = () => {};
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ownership/owners")) return jsonResponse(200, { data: [] });
      if (init?.method === "POST") {
        if (status === 409) await new Promise<void>((res) => (answer = res));
        return status === 200
          ? jsonResponse(200, { data: { changed: true } })
          : jsonResponse(409, { error: "busy" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const r = renderStrip();
    const badge = r.getByTestId("tab-owner-badge");
    await fireEvent.click(badge);
    await settle();
    await fireEvent.click(r.getByTestId("tab-owner-release"));
    await settle();
    // The pressed row is disabled while the request runs; a browser applying the
    // focus fixup rule drops focus to the body then.
    expect(r.getByTestId("tab-owner-release").hasAttribute("disabled")).toBe(true);
    // (happy-dom will not blur a disabled button, so park focus and drop it.)
    const parked = document.createElement("input");
    document.body.appendChild(parked);
    parked.focus();
    parked.remove();
    expect(document.activeElement).toBe(document.body);
    answer();
    await nextTask();
    expect(r.getByTestId("tab-owner-error")).toBeTruthy();
    expect(document.activeElement).toBe(r.getByTestId("tab-owner-release"));

    status = 200;
    await fireEvent.click(r.getByTestId("tab-owner-release"));
    await nextTask();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("an outside press returns focus to the badge, unless the press took focus itself", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const r = renderStrip();
    const badge = r.getByTestId("tab-owner-badge");
    await fireEvent.click(badge);
    await settle();
    expect(document.activeElement).toBe(r.getByTestId("tab-owner-release"));
    // A press on something that takes no focus: focus lands nowhere, so it goes back.
    await fireEvent.mouseDown(document.body);
    await nextTask();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
    expect(document.activeElement).toBe(badge);

    // A press on a control that takes focus keeps it there.
    const input = document.createElement("input");
    document.body.appendChild(input);
    await fireEvent.click(badge);
    await settle();
    await fireEvent.mouseDown(input);
    input.focus();
    await nextTask();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("falls back to the tab when a successful Release's republish hid the badge", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/ownership/owners")) return jsonResponse(200, { data: [] });
      if (init?.method === "POST") return jsonResponse(200, { data: { changed: true } });
      throw new Error(`unexpected ${url}`);
    });
    // No other AI attached: once the document is unowned, the badge goes.
    const summary: OwnershipSummary = { ...SUMMARY, otherAiAttached: false };
    const tabs = [makeTab("a")];
    const r = render(DocumentTabs, {
      props: {
        ...stripProps(tabs),
        ownerFields: new Map([["a", held]]),
        ownershipSummary: summary,
      },
    });
    await fireEvent.click(r.getByTestId("tab-owner-badge"));
    await settle();
    await fireEvent.click(r.getByTestId("tab-owner-release"));
    await settle();
    expect(r.queryByTestId("tab-owner-menu")).toBeNull();
    // The server's republish lands before the deferred hand-back runs.
    await r.rerender({
      ...stripProps(tabs),
      ownerFields: new Map([["a", { owner: null, stale: null, hint: null, waitingSince: null }]]),
      ownershipSummary: summary,
    });
    await settle();
    expect(r.queryByTestId("tab-owner-badge")).toBeNull();
    await nextTask();
    const pill = r.container.querySelector('[data-testid="tab-a"][role="tab"]');
    expect(pill).toBeTruthy();
    expect(document.activeElement).toBe(pill);
  });

  it("does not reach for a badge that has left the DOM", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const r = renderStrip();
    const badge = r.getByTestId("tab-owner-badge");
    await fireEvent.click(badge);
    await settle();
    const focus = vi.spyOn(badge, "focus");
    badge.remove();
    await fireEvent.keyDown(document, { key: "Escape" });
    await nextTask();
    expect(focus).not.toHaveBeenCalled();
  });
});
