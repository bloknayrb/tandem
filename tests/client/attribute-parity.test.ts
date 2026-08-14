/**
 * Server-written Y attributes must be declared on the client node (#1448).
 *
 * The server sets attributes on Y.XmlElements (`mdast-ydoc.ts`); the client
 * turns those elements into ProseMirror nodes via `schema.node()`, which drops
 * any attribute the node spec does not declare; y-prosemirror then prunes the
 * dropped key back out of the Y.Doc ("remove all keys that are no longer in
 * pAttrs"). So an attribute the client forgot to declare is not merely ignored
 * — it is deleted from the document, permanently, on the first edit.
 *
 * That is how `table.align` was lost: `|:--|:-:|--:|` came back `|---|---|---|`
 * with nothing in any log. Nothing else in the suite can see this class, and it
 * is silent by construction, so the check has to be structural.
 *
 * The server side is derived from real documents rather than a hand-kept list,
 * because a hand-kept list is exactly what would drift.
 */

import { describe, expect, it } from "vitest";
import { productionSchema, yAttributes } from "./editor-roundtrip-harness.js";

/**
 * One document per attribute-bearing construct. Deliberately inline rather than
 * read from `tests/fixtures/`: this test's job is to notice when the server
 * starts writing an attribute the client does not declare, and a shared fixture
 * someone else edits for an unrelated reason is a weak place to anchor that.
 */
const SOURCES = [
  "# H1\n\n### H3\n",
  "| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |\n",
  "3. three\n4. four\n",
  "```ts\nconst x = 1;\n```\n",
  "- [ ] todo\n- [x] done\n",
  "![alt](img.png 'title')\n",
  '<div class="raw">block</div>\n',
  "[ref]: https://example.com\n\nSee [ref].\n",
  "Text[^1]\n\n[^1]: A footnote.\n",
];

/** Every (nodeName, attribute) pair the server actually writes. */
function serverWrittenAttributes(): Map<string, Set<string>> {
  const written = new Map<string, Set<string>>();
  for (const source of SOURCES) {
    for (const [nodeName, attrs] of yAttributes(source)) {
      const set = written.get(nodeName) ?? new Set<string>();
      for (const key of Object.keys(attrs)) set.add(key);
      written.set(nodeName, set);
    }
  }
  return written;
}

describe("Y attribute parity between server and client schema", () => {
  it("every attribute the server writes is declared on the client node", () => {
    const schema = productionSchema();
    const dropped: string[] = [];

    for (const [nodeName, attrs] of serverWrittenAttributes()) {
      const type = schema.nodes[nodeName];
      if (!type) {
        dropped.push(`${nodeName}: node is absent from the client schema entirely`);
        continue;
      }
      const declared = new Set(Object.keys(type.spec.attrs ?? {}));
      for (const attr of attrs) {
        if (!declared.has(attr)) dropped.push(`${nodeName}.${attr}`);
      }
    }

    // V4 is open: `table.align` is the one casualty today. When PR 3 declares
    // it, this list empties and the assertion below becomes the permanent gate.
    expect(dropped).toEqual(["table.align"]);
  });

  it.fails("no server-written attribute is discarded by the client schema", () => {
    const schema = productionSchema();
    const dropped: string[] = [];
    for (const [nodeName, attrs] of serverWrittenAttributes()) {
      const declared = new Set(Object.keys(schema.nodes[nodeName]?.spec.attrs ?? {}));
      for (const attr of attrs) if (!declared.has(attr)) dropped.push(`${nodeName}.${attr}`);
    }
    expect(dropped).toEqual([]);
  });

  it("the attributes that do survive are still surviving", () => {
    // A regression guard with teeth: these are the nine that work today, so a
    // change that breaks one fails here rather than silently eating data.
    const schema = productionSchema();
    const expected: Record<string, string[]> = {
      heading: ["level"],
      orderedList: ["start"],
      listItem: ["checked"],
      codeBlock: ["language"],
      paragraph: ["markdownHtml", "markdownRaw"],
      image: ["src", "alt", "title"],
    };
    for (const [nodeName, attrs] of Object.entries(expected)) {
      const declared = Object.keys(schema.nodes[nodeName]?.spec.attrs ?? {});
      for (const attr of attrs) {
        expect(declared, `${nodeName}.${attr} must stay declared`).toContain(attr);
      }
    }
  });
});
