import { describe, expect, it } from "vitest";
import {
  CONTEXT_MENU_ALLOW_SELECTOR,
  installGlobalContextMenuPolicy,
  isContextMenuAllowed,
} from "../../src/client/context-menu-policy";

/** Build a detached element (optionally with children) matching `html`. */
function el(html: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  return wrapper.firstElementChild as HTMLElement;
}

describe("isContextMenuAllowed", () => {
  it("rejects a non-Element target (null, text node stand-in)", () => {
    expect(isContextMenuAllowed(null)).toBe(false);
  });

  it("admits the Tiptap editor DOM (.ProseMirror)", () => {
    const editor = el('<div class="tandem-editor ProseMirror"><p>hello</p></div>');
    const p = editor.querySelector("p")!;
    expect(isContextMenuAllowed(editor)).toBe(true);
    // A click on nested editor content must resolve up to the ProseMirror
    // ancestor via closest() — this is the passthrough the macOS Look Up /
    // Services / spellcheck menu depends on.
    expect(isContextMenuAllowed(p)).toBe(true);
  });

  it("admits a tab pill (data-testid + role=tab), not the scroll container", () => {
    const strip = el(
      '<div data-testid="tab-scroll-container"><button data-testid="tab-doc1" role="tab"><span>doc1.md</span></button></div>',
    );
    const tab = strip.querySelector('[data-testid="tab-doc1"]')!;
    const label = tab.querySelector("span")!;
    expect(isContextMenuAllowed(tab)).toBe(true);
    expect(isContextMenuAllowed(label)).toBe(true);
    // The strip container itself carries a `data-testid^="tab-"` prefix match
    // too, but lacks role="tab" — it must NOT be admitted, or blank tab-strip
    // padding (today's stray-native-menu case) would stay unsuppressed.
    expect(isContextMenuAllowed(strip)).toBe(false);
  });

  it("admits an annotation card (data-annotation-id), not the list container", () => {
    const list = el(
      '<div role="list"><div data-annotation-id="ann-1"><p>comment text</p></div></div>',
    );
    const card = list.querySelector("[data-annotation-id]")!;
    const text = card.querySelector("p")!;
    expect(isContextMenuAllowed(card)).toBe(true);
    expect(isContextMenuAllowed(text)).toBe(true);
    expect(isContextMenuAllowed(list)).toBe(false);
  });

  it("admits real form fields and contenteditable", () => {
    expect(isContextMenuAllowed(el("<input />"))).toBe(true);
    expect(isContextMenuAllowed(el("<textarea></textarea>"))).toBe(true);
    expect(isContextMenuAllowed(el('<div contenteditable="true"></div>'))).toBe(true);
  });

  it("admits an explicit [data-allow-context-menu] marker and its descendants", () => {
    const bubble = el('<div data-allow-context-menu><span>chat text</span></div>');
    const span = bubble.querySelector("span")!;
    expect(isContextMenuAllowed(bubble)).toBe(true);
    expect(isContextMenuAllowed(span)).toBe(true);
  });

  it("admits the IntegrationWizardModal copyable-snippet classes", () => {
    expect(isContextMenuAllowed(el('<code class="iw-code">http://127.0.0.1:3479/mcp</code>'))).toBe(
      true,
    );
    expect(isContextMenuAllowed(el('<code class="iw-code-inline">/mcp</code>'))).toBe(true);
  });

  it("suppresses generic app chrome with no marker (the stray-menu class this exists to kill)", () => {
    expect(isContextMenuAllowed(el("<div>StatusBar text</div>"))).toBe(false);
    expect(isContextMenuAllowed(el('<button data-testid="some-button">Click</button>'))).toBe(
      false,
    );
    // Blank tab-strip padding: a div inside the scroll container, not a tab.
    const strip = el('<div data-testid="tab-scroll-container"><div>padding</div></div>');
    expect(isContextMenuAllowed(strip.firstElementChild)).toBe(false);
  });
});

describe("CONTEXT_MENU_ALLOW_SELECTOR", () => {
  it("is a single combined selector string usable directly with closest()", () => {
    expect(typeof CONTEXT_MENU_ALLOW_SELECTOR).toBe("string");
    expect(CONTEXT_MENU_ALLOW_SELECTOR).toContain(".ProseMirror");
  });
});

describe("installGlobalContextMenuPolicy", () => {
  it("prevents default on the capture phase for a non-allowlisted target", () => {
    const doc = document;
    const target = doc.createElement("div");
    doc.body.appendChild(target);

    const teardown = installGlobalContextMenuPolicy(doc);
    try {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      teardown();
      target.remove();
    }
  });

  it("does NOT preventDefault for an allowlisted target (editor)", () => {
    const doc = document;
    const editor = doc.createElement("div");
    editor.className = "ProseMirror";
    doc.body.appendChild(editor);

    const teardown = installGlobalContextMenuPolicy(doc);
    try {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      editor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      teardown();
      editor.remove();
    }
  });

  it("defers to an existing bubble-phase listener on an allowlisted surface", () => {
    // Mirrors the coexistence contract: the four #923 handlers are bubble-phase
    // and call preventDefault only when THEY resolve an actionable target. A
    // capture listener that returns early (no preventDefault/stopPropagation)
    // for allowlisted targets must let that bubble handler still run and win.
    const doc = document;
    const tab = doc.createElement("button");
    tab.setAttribute("data-testid", "tab-doc1");
    tab.setAttribute("role", "tab");
    doc.body.appendChild(tab);

    let bubbleHandlerRan = false;
    const bubbleHandler = (e: MouseEvent) => {
      bubbleHandlerRan = true;
      e.preventDefault();
    };
    tab.addEventListener("contextmenu", bubbleHandler);

    const teardown = installGlobalContextMenuPolicy(doc);
    try {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      tab.dispatchEvent(event);
      expect(bubbleHandlerRan).toBe(true);
      expect(event.defaultPrevented).toBe(true); // by the bubble handler, not the capture one
    } finally {
      teardown();
      tab.removeEventListener("contextmenu", bubbleHandler);
      tab.remove();
    }
  });
});
