import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  decodeScratchpadBlocks,
  encodeScratchpadBlocks,
  extractFragmentBlocks,
  extractFragmentText,
  scratchpadBlockToParagraph,
  scratchpadStorageKey,
} from "../../src/client/hooks/useScratchpadPersistence.svelte";

/** Build a Y.Doc whose "default" XmlFragment holds the given paragraph lines. */
function docWithParagraphs(lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const paragraphs = lines.map((line) => {
    const p = new Y.XmlElement("paragraph");
    if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
    return p;
  });
  fragment.insert(0, paragraphs);
  return doc;
}

describe("scratchpadStorageKey", () => {
  it("namespaces by uuid so distinct scratchpads never collide", () => {
    expect(scratchpadStorageKey("inst1", "uuid-a")).toBe("tandem:scratchpad:inst1:uuid-a");
    expect(scratchpadStorageKey("inst1", "uuid-a")).not.toBe(
      scratchpadStorageKey("inst1", "uuid-b"),
    );
  });

  it("namespaces by install so two servers never read each other's recovery (#1387)", () => {
    // The whole fix in one assertion. Every Tandem server on a machine shares
    // one browser origin, so without this segment a scratchpad opened on any
    // server can restore content persisted while talking to another one.
    expect(scratchpadStorageKey("inst1", "uuid-a")).not.toBe(
      scratchpadStorageKey("inst2", "uuid-a"),
    );
  });

  it("keeps the `tandem:scratchpad:` prefix that the E2E cleanup matches on", () => {
    // The E2E cleanups clear recovery with a prefix match. If the install
    // segment were prepended instead of inserted, that cleanup would silently
    // stop matching and the suite would leak state between tests.
    expect(scratchpadStorageKey("inst1", "uuid-a").startsWith("tandem:scratchpad:")).toBe(true);
  });
});

describe("extractFragmentText", () => {
  it("returns empty string for an empty fragment", () => {
    const doc = new Y.Doc();
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("");
  });

  it("joins top-level blocks with newlines", () => {
    const doc = docWithParagraphs(["first line", "second line"]);
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("first line\nsecond line");
  });

  it("trims trailing blank blocks", () => {
    const doc = docWithParagraphs(["content", "", ""]);
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("content");
  });

  it("flattens nested block children (e.g. list items)", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const list = new Y.XmlElement("bulletList");
    const item = new Y.XmlElement("listItem");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("item text")]);
    item.insert(0, [para]);
    list.insert(0, [item]);
    fragment.insert(0, [list]);
    expect(extractFragmentText(fragment)).toBe("item text");
  });
});

describe("the persisted form survives a paragraph that holds its own newline", () => {
  // Since #1448 a paragraph's text can contain a literal newline — that is what
  // keeps a soft wrap a soft wrap. The persisted form used `\n` as the BLOCK
  // separator too, so restore could not tell the two apart and crash recovery
  // came back with one paragraph per wrapped line: the recovery path silently
  // reformatting the content it exists to preserve.

  it("round-trips a soft-wrapped paragraph as ONE block", () => {
    const doc = docWithParagraphs(["first line\nsecond line", "another paragraph"]);
    const blocks = extractFragmentBlocks(doc.getXmlFragment("default"));
    expect(blocks).toEqual([
      [{ insert: "first line\nsecond line" }],
      [{ insert: "another paragraph" }],
    ]);
    expect(decodeScratchpadBlocks(encodeScratchpadBlocks(blocks))).toEqual(blocks);
  });

  it("reads a pre-#1448 newline-delimited value rather than discarding it", () => {
    // An upgrade must not be the thing that loses a user's unsaved text. The old
    // form cannot represent an intra-block newline, so splitting it is the
    // correct reading of it.
    expect(decodeScratchpadBlocks("first\nsecond")).toEqual([
      [{ insert: "first" }],
      [{ insert: "second" }],
    ]);
  });

  it("reads a legacy value that merely STARTS with a bracket as legacy text", () => {
    expect(decodeScratchpadBlocks("[draft] notes\nmore")).toEqual([
      [{ insert: "[draft] notes" }],
      [{ insert: "more" }],
    ]);
  });

  it("reads a pre-#1489 JSON string[] value, upgrading it in place", () => {
    // The form written between #1448 and #1489. A block was a STRING there and
    // is an ARRAY now, so the two are structurally distinguishable and no
    // version field is needed — but the old one still has to be readable, or
    // upgrading discards whatever the user had unsaved at the time.
    expect(decodeScratchpadBlocks('["first line\\nsecond","other"]')).toEqual([
      [{ insert: "first line\nsecond" }],
      [{ insert: "other" }],
    ]);
  });

  it("rejects a malformed stored value rather than trusting its shape", () => {
    // localStorage is user-editable. An array of the wrong thing must not be
    // read as blocks — it would reach `text.insert(at, op.insert)` as undefined.
    expect(decodeScratchpadBlocks("[1,2,3]")).toEqual([[{ insert: "[1,2,3]" }]]);
    expect(decodeScratchpadBlocks('[[{"insert":5}]]')).toEqual([[{ insert: '[[{"insert":5}]]' }]]);
  });

  it("keeps extractFragmentText as the plain-text view for the emptiness check", () => {
    const doc = docWithParagraphs(["a", "b"]);
    expect(extractFragmentText(doc.getXmlFragment("default"))).toBe("a\nb");
  });
});

describe("#1489: formatting is preserved, never spelled out as HTML tags", () => {
  /**
   * A paragraph carrying real inline marks, the way the editor writes one.
   *
   * The `{ strong: null }` on " and " is LOAD-BEARING and was the difference
   * between this suite catching a regression and blessing it. Written as a bare
   * `t.insert(10, " and ")`, Yjs inherits the active bold, so the fixture had no
   * unformatted run following a formatted one — the only shape that exposes
   * mark bleed on restore. The round-trip test below passed for that reason
   * rather than because restore was correct.
   */
  function formattedDoc(): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    fragment.insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, "plain ");
    t.insert(6, "bold", { strong: {} });
    t.insert(10, " and ", { strong: null });
    t.insert(15, "italic", { em: {} });
    return doc;
  }

  it("does not persist marks as literal tag characters", () => {
    // The bug, and the assertion that fails on the old code. `toString()` on a
    // Y.XmlText RENDERS marks as HTML, so this block was persisted as
    //   "plain <strong>bold and </strong><em>italic</em>"
    // and restore then wrote those angle brackets into the document as text.
    const blocks = extractFragmentBlocks(formattedDoc().getXmlFragment("default"));
    const persisted = encodeScratchpadBlocks(blocks);
    expect(persisted).not.toContain("<strong>");
    expect(persisted).not.toContain("<em>");
    expect(persisted).not.toContain("&lt;");
  });

  it("carries the marks themselves, so recovery does not silently unformat", () => {
    // Stripping marks would also stop the tags — and would quietly hand back
    // unbolded text, which is its own unexpected change to the user's content.
    const blocks = extractFragmentBlocks(formattedDoc().getXmlFragment("default"));
    expect(blocks).toEqual([
      [
        { insert: "plain " },
        { insert: "bold", attributes: { strong: {} } },
        { insert: " and " },
        { insert: "italic", attributes: { em: {} } },
      ],
    ]);
  });

  /** Persist → restore, through the PRODUCT's builder rather than a copy of it. */
  function roundTrip(fragment: Y.XmlFragment): Y.XmlFragment {
    const decoded = decodeScratchpadBlocks(encodeScratchpadBlocks(extractFragmentBlocks(fragment)));
    const restored = new Y.Doc().getXmlFragment("default");
    restored.insert(0, decoded.map(scratchpadBlockToParagraph));
    return restored;
  }

  it("round-trips formatting through storage and back into a Y.Doc", () => {
    // Calls `scratchpadBlockToParagraph`, the function `restoreInto` actually
    // uses. An earlier version re-implemented the restore loop inline here,
    // which meant a change to the product's restore path could not fail it.
    const original = extractFragmentBlocks(formattedDoc().getXmlFragment("default"));
    const back = roundTrip(formattedDoc().getXmlFragment("default"));

    expect(extractFragmentBlocks(back)).toEqual(original);
    expect(extractFragmentText(back)).toBe("plain bold and italic");
  });

  it("does NOT bleed a mark onto the run after it", () => {
    // The regression the first cut of this fix introduced, and the reason the
    // fixture above turns bold off explicitly.
    //
    // `Y.XmlText.insert` with no attributes does not insert unformatted text —
    // it inherits the formatting active at that position. `toDelta()` normalizes
    // a mark-off to the ABSENCE of a key, so an unformatted run always extracts
    // as a bare `{insert}`. Restoring that naively gave:
    //     "plain " + "bold and italic"{strong}
    // i.e. bold a word, keep typing, crash — and recovery bolds the rest of your
    // paragraph. Asserted separately from the round trip because it is a
    // specific claim about a specific gesture.
    const back = extractFragmentBlocks(roundTrip(formattedDoc().getXmlFragment("default")));
    expect(back[0]).toContainEqual({ insert: " and " });
    expect(back[0].find((op) => op.insert === " and ")?.attributes).toBeUndefined();
  });

  it("is stable across a SECOND round trip", () => {
    // Bleed compounds: each restore re-persists what the previous one produced,
    // so a one-pass assertion can miss a defect that only diverges on pass two.
    const once = roundTrip(formattedDoc().getXmlFragment("default"));
    const twice = roundTrip(once);
    expect(extractFragmentBlocks(twice)).toEqual(extractFragmentBlocks(once));
  });

  it("survives multi-run astral-plane text", () => {
    // `at += op.insert.length` assumes Y.js indexes in UTF-16 code units, the
    // same unit `String.length` counts. A surrogate pair split down the middle
    // would corrupt the character, not just move it.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    fragment.insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, "👨‍👩‍👧 ");
    t.insert(t.length, "𝔘𝔫𝔦", { strong: {} });
    t.insert(t.length, " café", { strong: null });

    const original = extractFragmentBlocks(fragment);
    expect(extractFragmentBlocks(roundTrip(fragment))).toEqual(original);
    expect(extractFragmentText(roundTrip(fragment))).toBe("👨‍👩‍👧 𝔘𝔫𝔦 café");
  });

  it("the plain-text view still drops marks", () => {
    // `extractFragmentText` answers "are there any characters here", so it must
    // stay marks-free — and must not start leaking tags into that answer either.
    expect(extractFragmentText(formattedDoc().getXmlFragment("default"))).toBe(
      "plain bold and italic",
    );
  });
});
