import { describe, expect, it } from "vitest";
import {
  buildTabMenuContext,
  isTabContextMenuActionId,
  TAB_CONTEXT_MENU_ACTION_IDS,
} from "../../src/client/tabs/tab-context-menu";

describe("isTabContextMenuActionId", () => {
  it("accepts every id in the closed set", () => {
    for (const id of TAB_CONTEXT_MENU_ACTION_IDS) {
      expect(isTabContextMenuActionId(id)).toBe(true);
    }
  });

  it("rejects editor ids, unknown ids, and non-strings", () => {
    expect(isTabContextMenuActionId("ctx:undo")).toBe(false); // editor surface
    expect(isTabContextMenuActionId("ctx:tab:evil")).toBe(false);
    expect(isTabContextMenuActionId(undefined)).toBe(false);
    expect(isTabContextMenuActionId(7)).toBe(false);
  });
});

describe("buildTabMenuContext", () => {
  const tabs = [
    { id: "a", filePath: "/home/me/one.md" },
    { id: "b", filePath: "/home/me/two.md" },
    { id: "c", filePath: "/home/me/three.md" },
  ];

  it("enables Close Others only when more than one tab is open", () => {
    expect(buildTabMenuContext(tabs, "a").canCloseOthers).toBe(true);
    expect(buildTabMenuContext([tabs[0]], "a").canCloseOthers).toBe(false);
  });

  it("enables Close to the Right only when a tab follows in display order", () => {
    expect(buildTabMenuContext(tabs, "a").canCloseRight).toBe(true);
    expect(buildTabMenuContext(tabs, "b").canCloseRight).toBe(true);
    expect(buildTabMenuContext(tabs, "c").canCloseRight).toBe(false); // last tab
  });

  it("reports hasPath true for real on-disk files", () => {
    expect(buildTabMenuContext(tabs, "a").hasPath).toBe(true);
  });

  it("reports hasPath false for scratchpad and upload tabs", () => {
    const virtual = [
      {
        id: "s",
        filePath: "upload://scratchpad/550e8400-e29b-41d4-a716-446655440000/Scratchpad.md",
      },
      { id: "u", filePath: "upload://report.docx" },
    ];
    expect(buildTabMenuContext(virtual, "s").hasPath).toBe(false);
    expect(buildTabMenuContext(virtual, "u").hasPath).toBe(false);
  });

  it("returns all-false-ish context for an unknown tab id", () => {
    const ctx = buildTabMenuContext(tabs, "missing");
    // canCloseOthers still reflects the open-count; right/path are false.
    expect(ctx.canCloseRight).toBe(false);
    expect(ctx.hasPath).toBe(false);
  });
});
