/**
 * Editor round-trip harness (#1448).
 *
 * Every markdown suite we had asserted *idempotency* (`pass2 === pass1`), which
 * a first-pass mutation trivially satisfies — and all of them run server-side,
 * where `loadMarkdown → saveMarkdown` is already clean. That combination is why
 * the soft-wrap → hard-break defect shipped: the damage is done by the editor,
 * on the way back out of the DOM, and no test could see it.
 *
 * This drives the path those suites cannot:
 *
 *   markdown → Y.Doc → ProseMirror → DOM → re-parse → Y.Doc → markdown
 *
 * and asserts byte-identity on the FIRST pass.
 *
 * ## Why this reproduces production rather than approximating it
 *
 * The re-parse is what `prosemirror-view`'s `readDOMChange` → `parseBetween`
 * does after the browser reports a DOM mutation. Two details there are
 * load-bearing, and getting either wrong makes the harness pass while the
 * product is broken:
 *
 * 1. **The whitespace mode.** `parseBetween` passes
 *    `preserveWhitespace: $from.parent.type.whitespace == "pre" ? "full" : true`
 *    (`prosemirror-view/dist/index.js:4974`). Plain `true` — not `"full"` — is
 *    the mode that reaches `prosemirror-model`'s `linebreakReplacement` branch,
 *    which splits text on `/\r?\n|\r/` and inserts a `hardBreak` between the
 *    pieces. `"full"` keeps the newline as text; `false` collapses it to a space.
 *
 * 2. **`ruleFromNode`.** For any DOM node backed by a node view desc,
 *    `NodeViewDesc.parseRule` supplies `{ node, attrs }` and adds
 *    `preserveWhitespace: "full"` *only* when that node type's whitespace is
 *    `"pre"` (`prosemirror-view/dist/index.js:1336-1338`). We emulate it rather
 *    than omitting it, because it decides two separate questions: whether a
 *    block escapes the newline split, and whether its attributes survive a
 *    re-read even when the node spec's `parseHTML` would discard them.
 *
 * `docSpanning: true` models the case that actually damaged `README.md` — a
 * childList mutation whose target is the doc node, which re-parses every block
 * in one pass with `$from.parent` being the doc (whitespace `"normal"`), so no
 * block gets `"full"` from `parseBetween` itself.
 */

import { getSchema } from "@tiptap/core";
import {
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProsemirrorJSON,
} from "@tiptap/y-tiptap";
import {
  DOMSerializer,
  DOMParser as PMDOMParser,
  Node as PMNode,
  type Schema,
} from "prosemirror-model";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions.js";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";

/** The production editor schema, built from the same extension list the app uses. */
export function productionSchema(): Schema {
  return getSchema(buildSchemaExtensions());
}

/**
 * Build the schema with `overrides` applied to named node specs.
 *
 * Exists because the obvious way to override a StarterKit-provided node is a
 * silent no-op: `paragraph` has no entry of its own in `buildSchemaExtensions()`
 * (it comes from `starterKit`), so filtering the extension list by
 * `e.name === "paragraph"` matches nothing and the "modified" schema is
 * byte-identical to the stock one. Patching the assembled spec cannot miss.
 */
export function schemaWith(overrides: Record<string, Record<string, unknown>>): Schema {
  const base = productionSchema();
  let nodes = base.spec.nodes;
  for (const [name, patch] of Object.entries(overrides)) {
    const spec = nodes.get(name);
    if (!spec) throw new Error(`schemaWith: no such node in the production schema: ${name}`);
    nodes = nodes.update(name, { ...spec, ...patch });
  }
  return new (base.constructor as typeof import("prosemirror-model").Schema)({
    nodes,
    marks: base.spec.marks,
  });
}

/** Y.Doc → ProseMirror, the way y-prosemirror's sync plugin builds the initial doc. */
export function yDocToPmNode(doc: Y.Doc, schema: Schema): PMNode {
  return PMNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("default")));
}

/**
 * Serialize a PM node to DOM and read it back the way `readDOMChange` does.
 *
 * `docSpanning` selects which node `$from.parent` resolves to: the doc node (a
 * mutation targeting the whole document) or the single block being edited.
 */
export function reparseThroughDom(node: PMNode, schema: Schema, docSpanning: boolean): PMNode {
  const serializer = DOMSerializer.fromSchema(schema);
  const holder = document.createElement("div");

  // Serialize block by block so each top-level element can be mapped back to the
  // exact node that produced it. That mapping is what a node view desc gives
  // prosemirror-view for free; reconstructing it by tag name would guess.
  const nodeForElement = new Map<Node, PMNode>();
  node.forEach((child) => {
    const dom = serializer.serializeNode(child, { document });
    nodeForElement.set(dom, child);
    holder.appendChild(dom);
  });

  // Emulate prosemirror-view's `ruleFromNode`: a desc-backed element re-parses
  // through its own node's rule, carrying current attrs and — only for a "pre"
  // node type — `preserveWhitespace: "full"`.
  const ruleFromNode = (dom: Node) => {
    const child = nodeForElement.get(dom);
    if (!child) return null;
    const rule: Record<string, unknown> = { node: child.type.name, attrs: child.attrs };
    if (child.type.whitespace === "pre") rule.preserveWhitespace = "full";
    return rule;
  };

  const parentWhitespace = docSpanning
    ? schema.nodes.doc.whitespace
    : node.child(0).type.whitespace;
  return PMDOMParser.fromSchema(schema).parse(holder, {
    preserveWhitespace: parentWhitespace === "pre" ? "full" : true,
    // `ruleFromNode` is an undocumented prosemirror-view internal option not
    // declared on `ParseOptions` — the object as a whole needs the escape
    // hatch, not just this value.
    ruleFromNode,
  } as unknown as Parameters<ReturnType<typeof PMDOMParser.fromSchema>["parse"]>[1]);
}

export interface RoundTripResult {
  /** Markdown after a full load → attach → DOM re-read → save cycle. */
  output: string;
  /** Markdown after load → save with no editor involvement (the server-only path). */
  serverOnly: string;
  /** The PM doc as the editor first sees it, before any DOM round trip. */
  attached: PMNode;
  /** The PM doc after the DOM re-read — the shape that gets written back to Y. */
  reparsed: PMNode;
}

/**
 * Run markdown through the full editor cycle.
 *
 * Set `edit: false` to model open-and-close: the editor attaches, nothing is
 * mutated, and nothing should be written back. That is the negative control —
 * it must stay byte-clean even while the edit path is broken, and if it ever
 * fails the defect is somewhere other than the DOM re-read.
 */
export function editorRoundTrip(
  markdown: string,
  opts: { schema?: Schema; docSpanning?: boolean; edit?: boolean } = {},
): RoundTripResult {
  const schema = opts.schema ?? productionSchema();
  const docSpanning = opts.docSpanning ?? true;
  const edit = opts.edit ?? true;

  const serverDoc = new Y.Doc();
  loadMarkdown(serverDoc, markdown);
  const serverOnly = saveMarkdown(serverDoc);
  serverDoc.destroy();

  const doc = new Y.Doc();
  loadMarkdown(doc, markdown);
  const fragment = doc.getXmlFragment("default");
  const attached = yDocToPmNode(doc, schema);

  let reparsed = attached;
  if (edit) {
    reparsed = reparseThroughDom(attached, schema, docSpanning);
    // BindingMetadata requires both maps: `mapping` for node identity reuse and `isOMark`
    // for overlapping-mark hashing. y-prosemirror's marksToAttributes() calls
    // map.setIfUndefined(meta.isOMark, ...) unconditionally for any marked text run, so an
    // omitted isOMark throws the moment a fixture contains an inline mark (bold/italic/code/link).
    updateYFragment(doc, fragment, reparsed, { mapping: new Map(), isOMark: new Map() } as never);
  }

  const output = saveMarkdown(doc);
  doc.destroy();
  return { output, serverOnly, attached, reparsed };
}

/** Collect every attribute present on the Y.Doc's block elements, keyed by node name. */
export function yAttributes(markdown: string): Map<string, Record<string, unknown>> {
  const doc = new Y.Doc();
  loadMarkdown(doc, markdown);
  const found = new Map<string, Record<string, unknown>>();
  const visit = (el: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
    if (!(el instanceof Y.XmlElement)) return;
    const attrs = el.getAttributes() as Record<string, unknown>;
    if (Object.keys(attrs).length > 0 && !found.has(el.nodeName)) found.set(el.nodeName, attrs);
    el.toArray().forEach(visit);
  };
  doc.getXmlFragment("default").toArray().forEach(visit);
  doc.destroy();
  return found;
}

export { prosemirrorToYXmlFragment };
