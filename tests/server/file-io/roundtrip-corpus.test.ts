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
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, mdParser, saveMarkdown } from "../../../src/server/file-io/markdown.js";

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
  "loose-list.md": {},
  "table-aligned.md": {},
  "table-compact.md": {
    blockedOn: "table geometry",
    why: "hand-authored |---|---| cannot be reproduced; mdast carries no source markers",
  },
  "nested-marks.md": {},
  "inline-code-fence.md": {},
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

describe("literal backticks in prose never become a code span (V7, #1448)", () => {
  /** The mdast tree, minus source positions — "does it still mean the same?" */
  function meaning(markdown: string): string {
    const strip = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(strip)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => k !== "position")
                .map(([k, x]) => [k, strip(x)]),
            )
          : v;
    return JSON.stringify(strip(mdParser.parse(markdown)));
  }

  // An escaped backtick is NOT a code-span delimiter, so a fully-escaped run is
  // inert. Un-escape ONE of several and the survivor pairs with the next, which
  // is no longer shielded — literal prose becomes inline code, one-way, and an
  // idempotency-only assertion cannot see it because pass 2 serializes a genuine
  // code span.
  const PROSE = "The case that breaks: `x ?? ``y``` and text after it.\n";

  it("does not change what the document means", () => {
    expect(meaning(roundTrip(PROSE))).toBe(meaning(PROSE));
  });

  it("emits no inlineCode node, because the source had none", () => {
    expect(meaning(roundTrip(PROSE))).not.toContain("inlineCode");
  });

  it("is idempotent — the escapes do not erode on the second save", () => {
    const once = roundTrip(PROSE);
    expect(roundTrip(once)).toBe(once);
  });

  it("a lone literal backtick keeps its escape rather than becoming a delimiter", () => {
    // Tidier source is not worth a live delimiter. The escaped form renders
    // identically and cannot pair with a backtick in a sibling node — which is
    // the case the handler cannot see, and the one that shifted every code-span
    // boundary in docs/design-system-impl/testid-manifest.md.
    expect(roundTrip("a lone ` backtick\n")).toBe("a lone \\` backtick\n");
  });

  it("a text run ending in a backtick does not merge with the next span's fence", () => {
    const input = "trailing \\` then `a real span` after.\n";
    expect(roundTrip(input)).toBe(input);
    expect(meaning(roundTrip(input))).toBe(meaning(input));
  });
});

describe("code-span FENCE STYLE is invisible-tier (#1448)", () => {
  // These render identically and reparse to the same tree. mdast carries no
  // source marker for either, so no serializer option can reproduce them —
  // documented, not fixed. They change once and then hold.
  const CASES: Array<[string, string]> = [
    ["padding spaces are dropped", "A span: `` a ` b `` done.\n"],
    ["a longer-than-minimal fence shrinks", "A span: ``` a `` b ``` done.\n"],
  ];

  /** Every `inlineCode` value in a document, in order. */
  function codeValues(markdown: string): string[] {
    const found: string[] = [];
    visit(mdParser.parse(markdown), "inlineCode", (node) => {
      found.push(node.value);
    });
    return found;
  }

  it.each(CASES)("%s, but the span's content is unchanged", (_name, input) => {
    const out = roundTrip(input);
    expect(out).not.toBe(input); // if this flips, the case is no longer invisible-tier
    expect(codeValues(input)).toHaveLength(1); // positive anchor: there IS a span
    expect(codeValues(out)).toEqual(codeValues(input));
  });

  it.each(CASES)("%s, and then holds — it does not change again", (_name, input) => {
    const once = roundTrip(input);
    expect(roundTrip(once)).toBe(once);
  });
});

describe("round-trip corpus: line endings (W2)", () => {
  const LF = "# Title\n\nA paragraph soft-wrapped\nacross two lines.\n\n- a\n- b\n";
  const CRLF = LF.replace(/\n/g, "\r\n");

  it("an LF document keeps LF endings", () => {
    expect(roundTrip(LF)).toBe(LF);
  });

  it("a CRLF document keeps CRLF endings", () => {
    expect(roundTrip(CRLF)).toBe(CRLF);
  });

  it("never comes back MIXED, which was the pre-fix behaviour and worse than either", () => {
    // Before W2 the block separators became LF while the intra-paragraph soft
    // wrap kept its `\r`, so a Windows-authored file got BOTH forms.
    expect(roundTrip(CRLF)).not.toMatch(/[^\r]\n/);
    expect(roundTrip(LF)).not.toContain("\r");
  });

  it("a mixed-ending document resolves to the dominant form, not to both", () => {
    // Two CRLF endings against five LF: LF wins, and the `\r`s are gone.
    const mixed = "a\r\n\r\nb\nc\n\nd\n";
    expect(roundTrip(mixed)).not.toContain("\r");
  });
});
