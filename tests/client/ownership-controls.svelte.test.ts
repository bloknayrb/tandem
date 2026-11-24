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
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  composerLine,
  ownerFieldsFromList,
  readOwnerFields,
  readOwnershipSummary,
} from "../../src/client/ownership/owner-view";
import ChatPanel from "../../src/client/panels/ChatPanel.svelte";
import DocumentTabs from "../../src/client/tabs/DocumentTabs.svelte";
import {
  buildTabMenuContext,
  TAB_CONTEXT_MENU_ACTION_IDS,
} from "../../src/client/tabs/tab-context-menu";
import type { OpenTab } from "../../src/client/types";
import type { OwnershipSummary, PublishedOwnerFields } from "../../src/shared/ownership-published";

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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
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
    messages: [],
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
  } as const;
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
