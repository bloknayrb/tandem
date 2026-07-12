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
  it("cycles words → characters → sentences → paragraphs → pages → reading → words", () => {
    expect(nextMode("words")).toBe("characters");
    expect(nextMode("characters")).toBe("sentences");
    expect(nextMode("sentences")).toBe("paragraphs");
    expect(nextMode("paragraphs")).toBe("pages");
    expect(nextMode("pages")).toBe("reading");
    expect(nextMode("reading")).toBe("words");
  });

  it("modeLabel returns a short label for each mode", () => {
    expect(modeLabel("words")).toBe("words");
    expect(modeLabel("characters")).toBe("chars");
    expect(modeLabel("sentences")).toBe("sentences");
    expect(modeLabel("paragraphs")).toBe("paragraphs");
    expect(modeLabel("pages")).toBe("pages");
    expect(modeLabel("reading")).toBe("min read");
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

    it("round-trips the 'reading' mode", () => {
      saveMode("reading");
      expect(loadMode()).toBe("reading");
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
  function makeEditor(textContent: string, nodes: { text: string; type?: string }[] = []) {
    return {
      isDestroyed: false,
      state: {
        doc: {
          textContent,
          forEach: (cb: (node: { type: { name: string }; textContent: string }) => void) => {
            for (const n of nodes)
              cb({ type: { name: n.type ?? "paragraph" }, textContent: n.text });
          },
        },
      },
    };
  }

  it("returns 0 for null editor", () => {
    for (const m of [
      "words",
      "characters",
      "sentences",
      "paragraphs",
      "pages",
      "reading",
    ] as WordCountMode[]) {
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

  it("paragraphs = non-empty paragraph children only", () => {
    expect(
      getCount(
        makeEditor("body", [{ text: "first" }, { text: "" }, { text: "third" }]) as never,
        "paragraphs",
      ),
    ).toBe(2);
  });

  it("paragraphs excludes headings and blockquotes", () => {
    expect(
      getCount(
        makeEditor("body", [
          { text: "title", type: "heading" },
          { text: "body para", type: "paragraph" },
          { text: "quoted", type: "blockquote" },
        ]) as never,
        "paragraphs",
      ),
    ).toBe(1);
  });

  it("pages = ceil(words / 250) — publishing-standard manuscript page", () => {
    // Empty doc → 0 pages.
    expect(getCount(makeEditor("") as never, "pages")).toBe(0);
    expect(getCount(makeEditor("   ") as never, "pages")).toBe(0);
    // 1 word → 1 page (anything non-empty rounds up to 1).
    expect(getCount(makeEditor("hello") as never, "pages")).toBe(1);
    // 250 words → 1 page (boundary, ceil(250/250) = 1).
    const exact = Array.from({ length: 250 }, (_, i) => `w${i}`).join(" ");
    expect(getCount(makeEditor(exact) as never, "pages")).toBe(1);
    // 251 words → 2 pages.
    const overOne = Array.from({ length: 251 }, (_, i) => `w${i}`).join(" ");
    expect(getCount(makeEditor(overOne) as never, "pages")).toBe(2);
    // 500 words → 2 pages.
    const exactTwo = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
    expect(getCount(makeEditor(exactTwo) as never, "pages")).toBe(2);
  });

  it("reading = max(1, round(words / 200)) minutes, 0 words → 0", () => {
    // Empty doc → 0 minutes.
    expect(getCount(makeEditor("") as never, "reading")).toBe(0);
    expect(getCount(makeEditor("   ") as never, "reading")).toBe(0);
    // 1 word → 1 min read (rounds up from < 1).
    expect(getCount(makeEditor("hello") as never, "reading")).toBe(1);
    // 199 words → 1 min read (round(0.995) = 1).
    const words199 = Array.from({ length: 199 }, (_, i) => `w${i}`).join(" ");
    expect(getCount(makeEditor(words199) as never, "reading")).toBe(1);
    // 300 words → 2 min read (round(1.5) = 2).
    const words300 = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    expect(getCount(makeEditor(words300) as never, "reading")).toBe(2);
    // 500 words → 3 min read (round(2.5) = 3).
    const words500 = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
    expect(getCount(makeEditor(words500) as never, "reading")).toBe(3);
  });
});
