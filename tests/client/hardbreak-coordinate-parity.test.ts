/**
 * hardBreak coordinate parity — #1459 / #1450.
 *
 * `findXmlTextInParallel` (src/client/positions.ts) walks a textblock's Y children
 * accumulating a flat offset. It used to advance that accumulator for `Y.XmlText`
 * children ONLY, so a sibling `Y.XmlElement("hardBreak")` contributed 0 — while
 * `findXmlTextAtOffset` (src/server/mcp/document-model.ts), the function that MINTS
 * the very `relRange` this reader reads back, charges it 1. The reader was asymmetric
 * with its own writer, so a CRDT-resolved range landed short by exactly the number of
 * preceding breaks: an annotation drifted (#1459) and accepting a suggestion left an
 * N-character tail behind, corrupting the document (#1450).
 *
 * ## Why these tests are shaped this way
 *
 * 1. **The fixture MUST come from `loadMarkdown`, not `makeDoc`.** `makeDoc` →
 *    `populateYDoc` splits on "\n" into separate paragraphs and can never produce a
 *    hardBreak, so a test written with the obvious helper passes vacuously both before
 *    and after the fix. `normalizeHardBreaks` (mdast-ydoc.ts) is what yields the
 *    sibling-element shape this bug lives in.
 * 2. **The PM node MUST be real.** tests/client/coordinate-conversion.test.ts mocks the
 *    PM node with a hard-coded `childCount: 1` and a single text child — it structurally
 *    cannot represent a hardBreak, which is precisely why this shipped.
 * 3. **The assertion is exhaustive, not spot-checked.** For every offset we pin the
 *    client reader against the SERVER reader, which is the actual invariant. Spot-checks
 *    miss the leading-break shape, where every offset in the paragraph is skewed.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { pmPosToFlatOffset, relRangeToPmPositions } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { getElementText } from "../../src/server/mcp/document-model.js";
import { flatOffsetToRelPos, relPosToFlatOffset } from "../../src/server/positions";
import { productionSchema, yDocToPmNode } from "./editor-roundtrip-harness.js";

/** Build a Y.Doc from markdown (the only path that produces sibling hardBreaks). */
function fixture(md: string) {
  const doc = new Y.Doc();
  loadMarkdown(doc, md);
  const schema = productionSchema();
  return { doc, pm: yDocToPmNode(doc, schema) };
}

/** Count sibling hardBreak elements across the whole fragment. */
function countHardBreaks(doc: Y.Doc): number {
  let n = 0;
  const walk = (el: Y.XmlElement | Y.XmlFragment) => {
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i);
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === "hardBreak") n += 1;
        else walk(child);
      }
    }
  };
  walk(doc.getXmlFragment("default"));
  return n;
}

/**
 * The invariant: resolving a relRange through the CLIENT reader and converting back to a
 * flat offset must equal what the SERVER reader says that same RelativePosition means.
 *
 * Offsets that land ON a break are excluded: `findXmlTextAtOffset` deliberately returns
 * null there (an inline-leaf break is unaddressable, like a separator), so no relRange
 * can be minted for them in the first place.
 */
function assertReaderParity(md: string, label: string) {
  const { doc, pm } = fixture(md);
  const flatText = getElementText(doc.getXmlFragment("default") as unknown as Y.XmlElement);

  const mismatches: string[] = [];
  let probed = 0;
  for (let off = 0; off <= flatText.length; off++) {
    const rel = flatOffsetToRelPos(doc, off, 0);
    if (!rel) continue; // unaddressable (lands on a break/separator)
    const serverFlat = relPosToFlatOffset(doc, rel);
    if (serverFlat === null) continue;
    const resolved = relRangeToPmPositions(doc, pm, { fromRel: rel, toRel: rel });
    if (!resolved) {
      mismatches.push(`off=${off}: client resolved to null`);
      continue;
    }
    probed += 1;
    const clientFlat = pmPosToFlatOffset(pm, resolved.from);
    if (clientFlat !== serverFlat) {
      mismatches.push(`off=${off}: client=${clientFlat} server=${serverFlat}`);
    }
  }

  expect(probed).toBeGreaterThan(0);
  expect(mismatches, `${label} — client/server reader disagreement`).toEqual([]);
}

describe("hardBreak coordinate parity (#1459, #1450)", () => {
  it("fixture actually contains sibling hardBreaks (guards against a vacuous suite)", () => {
    // If this fails, loadMarkdown stopped producing the shape under test and every
    // assertion below would pass for the wrong reason.
    const { doc } = fixture("alpha\\\nbravo\n");
    expect(countHardBreaks(doc)).toBe(1);
  });

  it("one break", () => {
    assertReaderParity("alpha\\\nbravo\n", "one break");
  });

  it("two breaks", () => {
    assertReaderParity("alpha\\\nbravo\\\ncharlie\n", "two breaks");
  });

  it("five breaks", () => {
    assertReaderParity("a\\\nb\\\nc\\\nd\\\ne\\\nf\n", "five breaks");
  });

  it("paragraph-leading break (empty leading Y.XmlText is preserved)", () => {
    // splitDeltaOnHardBreak deliberately keeps the empty leading XmlText here. Pre-fix
    // EVERY offset in this paragraph was skewed, starting at 0.
    assertReaderParity("\\\nbravo\n", "leading break");
  });

  it("break inside a list item (recursive path)", () => {
    assertReaderParity("- alpha\\\n  bravo\n", "listItem");
  });

  it("break inside a blockquote (recursive path)", () => {
    assertReaderParity("> alpha\\\n> bravo\n", "blockquote");
  });

  it("breaks alongside sibling paragraphs", () => {
    assertReaderParity("intro\n\nalpha\\\nbravo\n\noutro\n", "mixed blocks");
  });

  it("resolves a range spanning a break to the full span", () => {
    // The #1450 signature: the end of the range came back short, so the accept left a
    // tail behind. Assert the resolved span covers the whole paragraph text.
    const { doc, pm } = fixture("alpha\\\nbravo\n");
    const flatText = getElementText(doc.getXmlFragment("default") as unknown as Y.XmlElement);
    const fromRel = flatOffsetToRelPos(doc, 0, 0);
    const toRel = flatOffsetToRelPos(doc, flatText.length, -1);
    expect(fromRel).not.toBeNull();
    expect(toRel).not.toBeNull();

    const resolved = relRangeToPmPositions(doc, pm, { fromRel: fromRel!, toRel: toRel! });
    expect(resolved).not.toBeNull();
    expect(pmPosToFlatOffset(pm, resolved!.from)).toBe(0);
    expect(pmPosToFlatOffset(pm, resolved!.to)).toBe(flatText.length);
  });
});
