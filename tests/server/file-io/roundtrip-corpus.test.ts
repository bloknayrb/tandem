/**
 * Curated round-trip corpus (#1448).
 *
 * One fixture per construct, asserting byte-identity on the FIRST pass. That
 * distinction is the whole point: the existing fidelity suites assert
 * idempotency (`pass2 === pass1`), which every defect in #1448 satisfies — each
 * one mangles the document once and is then a stable fixed point.
 *
 * Fixtures with a known defect are registered here with the defect they are
 * blocked on, and asserted to STILL be broken. That is deliberate: when a fix
 * lands, this test fails and forces the registration to be removed, so the
 * corpus cannot quietly accumulate an allowlist. A fixture that is neither
 * clean nor registered is a new regression.
 *
 * Line endings are synthesized rather than committed — `.gitattributes` pins
 * `*.md text eol=lf`, so a CRLF fixture checked into git arrives as LF and the
 * test would silently pass on the wrong input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../src/server/file-io/markdown.js";

const CORPUS_DIR = fileURLToPath(new URL("../../fixtures/roundtrip/", import.meta.url));

/**
 * `blockedOn` names the open defect from #1448. Absent means the fixture must
 * round-trip byte-identically today.
 */
const CORPUS: Record<string, { blockedOn?: string; why?: string }> = {
  "soft-wrap.md": {},
  "tight-list.md": {},
  "raw-blocks.md": {},
  "frontmatter.md": {},
  "loose-list.md": { blockedOn: "V2", why: "spread is hardcoded false in yDocToMdast" },
  "table-aligned.md": { blockedOn: "V-table-padding", why: "tablePipeAlign defaults to true" },
  "table-compact.md": { blockedOn: "V-table-padding", why: "tablePipeAlign defaults to true" },
  "nested-marks.md": { blockedOn: "V5", why: "deltaToPhrasingContent rebuilds nested marks wrong" },
  "inline-code-fence.md": {
    blockedOn: "V7",
    why: "code-span fence length is not recomputed from the content's backtick runs",
  },
};

function roundTrip(input: string): string {
  const doc = new Y.Doc();
  try {
    loadMarkdown(doc, input);
    return saveMarkdown(doc);
  } finally {
    doc.destroy();
  }
}

const read = (name: string) => readFileSync(`${CORPUS_DIR}${name}`, "utf-8");

describe("round-trip corpus", () => {
  it("every fixture on disk is registered", () => {
    const onDisk = readdirSync(CORPUS_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(onDisk).toEqual(Object.keys(CORPUS).sort());
  });

  const clean = Object.entries(CORPUS).filter(([, v]) => !v.blockedOn);
  it.each(clean)("%s round-trips byte-identically", (name) => {
    expect(roundTrip(read(name))).toBe(read(name));
  });

  const blocked = Object.entries(CORPUS).filter(([, v]) => v.blockedOn);
  it.each(blocked)("%s is still blocked on %o", (name, meta) => {
    // Asserting the defect is still present. When it is fixed this fails, which
    // is the signal to delete the registration — not to widen it.
    expect(
      roundTrip(read(name)),
      `${name} now round-trips cleanly. Remove its ${meta.blockedOn} registration from CORPUS.`,
    ).not.toBe(read(name));
  });
});

describe("verbatim blocks keep their newlines (V6, #1458)", () => {
  /**
   * Put a raw block's source into the Y.Doc with its newline held as a sibling
   * `hardBreak` element rather than a literal `\n`, then serialize.
   *
   * This is the shape a deliberate Shift+Enter produces inside a raw block. It
   * stays reachable after the `whitespace: "pre"` paragraph fix — that fix stops
   * the editor MANUFACTURING hardBreaks from soft wraps, it does not stop a user
   * typing one — so the reader has to handle both forms regardless.
   */
  function serializeRawBlockWithHardBreak(before: string, after: string): string {
    const doc = new Y.Doc();
    try {
      const fragment = doc.getXmlFragment("default");
      const para = new Y.XmlElement("paragraph");
      para.setAttribute("markdownRaw", "true");
      // Attach before populating — a detached Y.XmlText reverses segment order.
      fragment.insert(0, [para]);
      const head = new Y.XmlText();
      const tail = new Y.XmlText();
      para.insert(0, [head, new Y.XmlElement("hardBreak"), tail]);
      head.insert(0, before);
      tail.insert(0, after);
      return saveMarkdown(doc);
    } finally {
      doc.destroy();
    }
  }

  it("a hardBreak between two text runs is read back as a newline", () => {
    // Before the fix this silently dropped the break and emitted
    // "<div></div>" on one line.
    expect(serializeRawBlockWithHardBreak("<div>", "</div>")).toContain("<div>\n</div>");
  });

  it("a multi-line raw HTML block round-trips", () => {
    const raw = '<div class="callout">\n  <span>one</span>\n  <span>two</span>\n</div>\n';
    expect(roundTrip(raw)).toBe(raw);
  });
});

describe("round-trip corpus: line endings (W2)", () => {
  const LF = "# Title\n\nA paragraph soft-wrapped\nacross two lines.\n\n- a\n- b\n";
  const CRLF = LF.replace(/\n/g, "\r\n");

  it("an LF document keeps LF endings", () => {
    expect(roundTrip(LF)).toBe(LF);
  });

  it.fails("a CRLF document keeps CRLF endings", () => {
    expect(roundTrip(CRLF)).toBe(CRLF);
  });

  it("today a CRLF document comes back with MIXED endings, which is worse than either", () => {
    const out = roundTrip(CRLF);
    expect(out).toContain("\r\n"); // the intra-paragraph soft wrap keeps its \r
    expect(out).toMatch(/[^\r]\n/); // block separators have lost theirs
  });
});
