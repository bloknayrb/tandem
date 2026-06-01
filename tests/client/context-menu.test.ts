import { Schema } from "@tiptap/pm/model";
import { describe, expect, it, vi } from "vitest";
import { detectContext, normalizePlatform } from "../../src/client/editor/context-menu/detect";
import { dispatchContextAction } from "../../src/client/editor/context-menu/dispatch";
import {
  CONTEXT_MENU_ACTION_IDS,
  type ContextMenuActionId,
  isContextMenuActionId,
} from "../../src/client/editor/context-menu/types";

// ---- detectContext --------------------------------------------------------

/** Build a fake event target whose `closest` matches the given selectors. */
function targetMatching(...matches: string[]) {
  return { closest: (sel: string) => (matches.includes(sel) ? {} : null) };
}

describe("detectContext", () => {
  const base = { hasSelection: false, isEditable: true };

  it("returns link kind when over an anchor (precedence over table)", () => {
    const req = detectContext({
      targetEl: targetMatching("a[href]", "td, th"),
      platform: "macos",
      ...base,
    });
    expect(req?.kind).toBe("link");
    expect(req?.overLink).toBe(true);
  });

  it("returns tableCell kind inside a cell", () => {
    const req = detectContext({ targetEl: targetMatching("td, th"), platform: "windows", ...base });
    expect(req?.kind).toBe("tableCell");
  });

  it("returns editorText for plain text on Windows/Linux", () => {
    expect(detectContext({ targetEl: targetMatching(), platform: "windows", ...base })?.kind).toBe(
      "editorText",
    );
    expect(detectContext({ targetEl: targetMatching(), platform: "linux", ...base })?.kind).toBe(
      "editorText",
    );
  });

  it("returns null for plain text on macOS (preserve native Look Up menu)", () => {
    expect(detectContext({ targetEl: targetMatching(), platform: "macos", ...base })).toBeNull();
  });

  it("still shows link/table menus on macOS (Look Up irrelevant there)", () => {
    expect(
      detectContext({ targetEl: targetMatching("a[href]"), platform: "macos", ...base })?.kind,
    ).toBe("link");
    expect(
      detectContext({ targetEl: targetMatching("td, th"), platform: "macos", ...base })?.kind,
    ).toBe("tableCell");
  });

  it("propagates hasSelection/isEditable into the request", () => {
    const req = detectContext({
      targetEl: targetMatching(),
      platform: "linux",
      hasSelection: true,
      isEditable: false,
    });
    expect(req).toMatchObject({ hasSelection: true, isEditable: false });
  });
});

describe("normalizePlatform", () => {
  it("maps OS strings to the platform union", () => {
    expect(normalizePlatform("MacIntel")).toBe("macos");
    expect(normalizePlatform("darwin")).toBe("macos");
    expect(normalizePlatform("Win32")).toBe("windows");
    expect(normalizePlatform("Linux x86_64")).toBe("linux");
    expect(normalizePlatform("")).toBe("linux"); // safe default
  });
});

// ---- isContextMenuActionId ------------------------------------------------

describe("isContextMenuActionId", () => {
  it("accepts every id in the closed set", () => {
    for (const id of CONTEXT_MENU_ACTION_IDS) {
      expect(isContextMenuActionId(id)).toBe(true);
    }
  });

  it("rejects unknown / forged ids and non-strings", () => {
    expect(isContextMenuActionId("ctx:evil")).toBe(false);
    expect(isContextMenuActionId("cut")).toBe(false); // native, never emitted
    expect(isContextMenuActionId(undefined)).toBe(false);
    expect(isContextMenuActionId(42)).toBe(false);
  });
});

// ---- dispatchContextAction ------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/** Records every chained command name in order; `.run()` is a no-op terminal. */
function makeChainSpy() {
  const calls: string[] = [];
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "run") return () => true;
        return () => {
          calls.push(prop);
          return proxy;
        };
      },
    },
  );
  return { proxy, calls };
}

function makeEditor() {
  const chain = makeChainSpy();
  const dispatch = vi.fn();
  const focus = vi.fn();
  const tr = {
    replaceSelection: () => tr,
    scrollIntoView: () => tr,
  };
  const editor = {
    chain: () => chain.proxy,
    state: {
      schema,
      selection: { $from: { marks: () => [] } },
      tr,
    },
    view: { dispatch, focus },
  };
  return { editor: editor as never, chainCalls: chain.calls, dispatch, focus };
}

function baseDeps(editor: never) {
  return {
    editor,
    openHref: vi.fn(),
    getLinkHref: vi.fn(() => "https://example.com/page" as string | null),
    readClipboardText: vi.fn(async () => "pasted text" as string | null),
    writeClipboardText: vi.fn(async () => {}),
  };
}

async function run(id: ContextMenuActionId, overrides: Partial<ReturnType<typeof baseDeps>> = {}) {
  const { editor, chainCalls, dispatch, focus } = makeEditor();
  const deps = { ...baseDeps(editor), ...overrides };
  await dispatchContextAction(id, deps);
  return { chainCalls, dispatch, focus, deps };
}

describe("dispatchContextAction", () => {
  it("routes undo/redo through the (Yjs-backed) editor chain", async () => {
    expect((await run("ctx:undo")).chainCalls).toContain("undo");
    expect((await run("ctx:redo")).chainCalls).toContain("redo");
  });

  it("maps each table id to the correct Tiptap command", async () => {
    const cases: [ContextMenuActionId, string][] = [
      ["ctx:table:insertRowAbove", "addRowBefore"],
      ["ctx:table:insertRowBelow", "addRowAfter"],
      ["ctx:table:insertColLeft", "addColumnBefore"],
      ["ctx:table:insertColRight", "addColumnAfter"],
      ["ctx:table:deleteRow", "deleteRow"],
      ["ctx:table:deleteCol", "deleteColumn"],
      ["ctx:table:mergeCells", "mergeCells"],
      ["ctx:table:splitCell", "splitCell"],
      ["ctx:table:deleteTable", "deleteTable"],
    ];
    for (const [id, cmd] of cases) {
      expect((await run(id)).chainCalls).toContain(cmd);
    }
  });

  it("link:open funnels the href through openHref (which re-validates)", async () => {
    const { deps } = await run("ctx:link:open");
    expect(deps.openHref).toHaveBeenCalledWith("https://example.com/page");
  });

  it("link:open is a no-op when no href was captured", async () => {
    const { deps } = await run("ctx:link:open", { getLinkHref: vi.fn(() => null) });
    expect(deps.openHref).not.toHaveBeenCalled();
  });

  it("link:copy writes the raw href to the clipboard", async () => {
    const { deps } = await run("ctx:link:copy");
    expect(deps.writeClipboardText).toHaveBeenCalledWith("https://example.com/page");
  });

  it("link:remove extends to the mark range before unsetting", async () => {
    const { chainCalls } = await run("ctx:link:remove");
    expect(chainCalls).toEqual(expect.arrayContaining(["extendMarkRange", "unsetLink"]));
  });

  it("pastePlain reads the clipboard and dispatches an insertion", async () => {
    const { dispatch, deps } = await run("ctx:pastePlain");
    expect(deps.readClipboardText).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("pastePlain is a no-op on empty/denied clipboard", async () => {
    const { dispatch } = await run("ctx:pastePlain", {
      readClipboardText: vi.fn(async () => null),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
