/**
 * Editor round-trip fidelity (#1448).
 *
 * These are the assertions no existing suite could make: byte-identity on the
 * FIRST pass, through the editor rather than around it. See
 * `editor-roundtrip-harness.ts` for why the DOM re-read has to be modelled
 * exactly.
 *
 * Several cases below document defects that are still open. They are written as
 * the behaviour we want and marked `.fails`, so the suite goes green the moment
 * the fix lands and cannot be forgotten — rather than encoding the bug as if it
 * were the spec.
 */

import { describe, expect, it } from "vitest";
import { editorRoundTrip, productionSchema, schemaWith } from "./editor-roundtrip-harness.js";

const SOFT_WRAPPED =
  "At work I kept asking Claude to draft a report for me. I had it write into\na scratch file in my vault, and it updated the instant Claude touched it.\n";

describe("editor round-trip: the negative control", () => {
  it("attaching the editor and touching nothing does not change the document", () => {
    const { output } = editorRoundTrip(SOFT_WRAPPED, { edit: false });
    expect(output).toBe(SOFT_WRAPPED);
  });

  it("the server-only path was never the problem", () => {
    // Pinning this makes the diagnosis un-forgettable: if someone "fixes"
    // soft wraps in the serializer, this stays green and the real defect
    // (the DOM re-read) survives untouched.
    const { serverOnly } = editorRoundTrip(SOFT_WRAPPED);
    expect(serverOnly).toBe(SOFT_WRAPPED);
  });
});

describe("editor round-trip: soft wraps (V3)", () => {
  it.fails("a soft-wrapped paragraph survives an edit", () => {
    const { output } = editorRoundTrip(SOFT_WRAPPED);
    expect(output).toBe(SOFT_WRAPPED);
  });

  it("today a soft wrap becomes a hard break, and this is the defect", () => {
    const { output } = editorRoundTrip(SOFT_WRAPPED);
    expect(output).toContain("write into\\\n");
  });

  it("declaring paragraph whitespace:'pre' fixes it", () => {
    const schema = schemaWith({ paragraph: { whitespace: "pre" } });
    // Guard against the silent no-op: a filtered-extension override would
    // match nothing and this test would "pass" against the stock schema.
    expect(schema.nodes.paragraph.spec.whitespace).toBe("pre");

    const { output } = editorRoundTrip(SOFT_WRAPPED, { schema });
    expect(output).toBe(SOFT_WRAPPED);
  });

  it("an explicit hard break still survives whitespace:'pre'", () => {
    const withBreak = "first line\\\nsecond line\n";
    const schema = schemaWith({ paragraph: { whitespace: "pre" } });
    const { output } = editorRoundTrip(withBreak, { schema });
    expect(output).toBe(withBreak);
  });

  it("the doc-spanning re-parse is what damages untouched paragraphs", () => {
    // A childList mutation targeting the doc node re-parses every block in one
    // pass, which is why one edit backslashed every wrapped line of README.md.
    const twoParas = `${SOFT_WRAPPED}\nA second paragraph, also\nwrapped across lines.\n`;
    const { output } = editorRoundTrip(twoParas, { docSpanning: true });
    const damaged = output.split("\n").filter((l) => l.endsWith("\\")).length;
    expect(damaged).toBeGreaterThan(1);
  });
});

describe("editor round-trip: table column alignment (V4)", () => {
  const ALIGNED = "| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |\n";

  it("the Tiptap table node declares no attributes, so align cannot survive", () => {
    // The loss happens at `schema.node()` when the PM doc is built from the
    // Y.Doc — before the DOM is involved at all. This assertion is the root
    // cause; the round-trip below is the symptom.
    expect(Object.keys(productionSchema().nodes.table.spec.attrs ?? {})).not.toContain("align");
  });

  it.fails("an aligned table survives an edit", () => {
    const { output } = editorRoundTrip(ALIGNED);
    expect(output).toContain(":-:");
  });

  it("today alignment is silently dropped, permanently", () => {
    const { output, attached } = editorRoundTrip(ALIGNED);
    expect(attached.child(0).attrs.align).toBeUndefined();
    expect(output).not.toContain(":-:");
  });
});

describe("editor round-trip: multi-line verbatim blocks (V6)", () => {
  const RAW_HTML = '<div class="x">\n  <span>one</span>\n  <span>two</span>\n</div>\n\nAfter.\n';

  it("round-trips cleanly with no editor in the loop", () => {
    const { serverOnly } = editorRoundTrip(RAW_HTML);
    expect(serverOnly).toBe(RAW_HTML);
  });

  it.fails("a multi-line raw HTML block survives an edit", () => {
    const { output } = editorRoundTrip(RAW_HTML);
    expect(output).toBe(RAW_HTML);
  });
});
