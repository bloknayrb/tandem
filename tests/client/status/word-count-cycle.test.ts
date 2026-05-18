import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCount,
  loadMode,
  modeLabel,
  nextMode,
  saveMode,
  type WordCountMode,
} from "../../../src/client/status/word-count-cycle.js";

describe("word-count-cycle — cycle order + persistence", () => {
  it("cycles words → characters → sentences → paragraphs → words", () => {
    expect(nextMode("words")).toBe("characters");
    expect(nextMode("characters")).toBe("sentences");
    expect(nextMode("sentences")).toBe("paragraphs");
    expect(nextMode("paragraphs")).toBe("words");
  });

  it("modeLabel returns a short label for each mode", () => {
    expect(modeLabel("words")).toBe("words");
    expect(modeLabel("characters")).toBe("chars");
    expect(modeLabel("sentences")).toBe("sentences");
    expect(modeLabel("paragraphs")).toBe("paragraphs");
  });

  describe("loadMode / saveMode", () => {
    let store: Map<string, string>;

    beforeEach(() => {
      store = new Map();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
        key: () => null,
        get length() {
          return store.size;
        },
      } satisfies Storage);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("defaults to 'words' when no stored value", () => {
      expect(loadMode()).toBe("words");
    });

    it("round-trips a saved mode", () => {
      saveMode("sentences");
      expect(loadMode()).toBe("sentences");
    });

    it("rejects unknown stored values and defaults to 'words'", () => {
      store.set("tandem-status-count-mode", "syllables");
      expect(loadMode()).toBe("words");
    });

    it("survives a localStorage that throws (incognito)", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("storage disabled");
        },
        setItem: () => {
          throw new Error("storage disabled");
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      } satisfies Storage);
      expect(loadMode()).toBe("words");
      expect(() => saveMode("characters")).not.toThrow();
    });
  });
});

describe("word-count-cycle — getCount derivations", () => {
  function makeEditor(textContent: string, paragraphs: { text: string }[] = []) {
    return {
      isDestroyed: false,
      state: {
        doc: {
          textContent,
          forEach: (cb: (node: { type: { name: string }; textContent: string }) => void) => {
            for (const p of paragraphs) cb({ type: { name: "paragraph" }, textContent: p.text });
          },
        },
      },
    };
  }

  it("returns 0 for null editor", () => {
    for (const m of ["words", "characters", "sentences", "paragraphs"] as WordCountMode[]) {
      expect(getCount(null, m)).toBe(0);
    }
  });

  it("characters = raw text length", () => {
    const e = makeEditor("hello world");
    expect(getCount(e as never, "characters")).toBe(11);
  });

  it("words = whitespace-split tokens", () => {
    expect(getCount(makeEditor("hello") as never, "words")).toBe(1);
    expect(getCount(makeEditor("hello world") as never, "words")).toBe(2);
    expect(getCount(makeEditor("   ") as never, "words")).toBe(0);
    expect(getCount(makeEditor("") as never, "words")).toBe(0);
    // Repeated whitespace doesn't double-count
    expect(getCount(makeEditor("a   b   c") as never, "words")).toBe(3);
  });

  it("sentences = [.!?]+ boundary count", () => {
    expect(getCount(makeEditor("One.") as never, "sentences")).toBe(1);
    expect(getCount(makeEditor("One. Two! Three?") as never, "sentences")).toBe(3);
    // No terminator → still 1 sentence if text non-empty
    expect(getCount(makeEditor("trailing fragment") as never, "sentences")).toBe(1);
    expect(getCount(makeEditor("") as never, "sentences")).toBe(0);
  });

  it("paragraphs = non-empty paragraph/heading/blockquote children", () => {
    expect(
      getCount(
        makeEditor("body", [{ text: "first" }, { text: "" }, { text: "third" }]) as never,
        "paragraphs",
      ),
    ).toBe(2);
  });
});
