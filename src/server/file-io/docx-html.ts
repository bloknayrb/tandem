// HTML → Y.Doc conversion: htmlparser2 DOM traversal → Yjs XmlFragment

import type { ChildNode, Element, Text } from "domhandler";
import * as htmlparser2 from "htmlparser2";
import * as Y from "yjs";
import { DOCX_INLINE_MARKS } from "../../shared/constants.js";
import type { FootnoteBody } from "../../shared/types.js";

/** All marks that can appear on inline text (superset of mdast-ydoc) */
const ALL_MARKS = DOCX_INLINE_MARKS;

/** Map HTML tag names to the mark they apply */
const INLINE_MARK_TAGS: Record<string, (el: Element) => Record<string, object>> = {
  strong: () => ({ bold: {} }),
  b: () => ({ bold: {} }),
  em: () => ({ italic: {} }),
  i: () => ({ italic: {} }),
  u: () => ({ underline: {} }),
  s: () => ({ strike: {} }),
  del: () => ({ strike: {} }),
  sup: () => ({ superscript: {} }),
  sub: () => ({ subscript: {} }),
  a: (el) => {
    const href = el.attribs.href || "";
    const safeHref = /^https?:\/\//i.test(href) || href.startsWith("mailto:") ? href : "";
    return { link: { href: safeHref } };
  },
};

/** Tags that represent block-level elements */
const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "tr",
  "td",
  "th",
  "pre",
  "img",
  "hr",
  "br",
  "div",
]);

type DeferredText = { xmlText: Y.XmlText; children: ChildNode[]; marks: Record<string, object> };

// -- Footnote reconstruction (#1123 Tier-A #3 PR 2) ---------------------------
//
// mammoth renders a Word footnote as an inline
//   <sup><a href="#footnote-N" id="footnote-ref-N">[N]</a></sup>
// plus a trailing
//   <ol><li id="footnote-N"><p>body <a href="#footnote-ref-N">↑</a></p></li></ol>
// (N is the OOXML footnote id, mirrored in the href). Endnotes use the disjoint
// `#endnote-N` / `id="endnote-N"` namespace, so the footnote patterns below never
// match them — endnotes keep degrading to a visible list (CRITICAL-2).

const FOOTNOTE_REF_HREF = /^#footnote-(\d+)$/;
const FOOTNOTE_LI_ID = /^footnote-(\d+)$/;

/** If `<a>` is a footnote inline reference, its id; else null. */
function footnoteRefId(el: Element): string | null {
  const match = (el.attribs.href || "").match(FOOTNOTE_REF_HREF);
  return match ? match[1] : null;
}

/**
 * If `<li>` is a mammoth footnote list item — `id="footnote-N"` AND a back-link
 * `<a href="#footnote-ref-N">` inside — its id; else null. The back-link is
 * required so a coincidental author-authored `id="footnote-5"` is never mistaken
 * for a flattened footnote (false-removal guard).
 */
function footnoteListItemId(li: Element): string | null {
  const match = (li.attribs.id || "").match(FOOTNOTE_LI_ID);
  if (!match) return null;
  const backLink = `#footnote-ref-${match[1]}`;
  const stack: ChildNode[] = [...li.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node && isElement(node)) {
      if (node.tagName.toLowerCase() === "a" && (node.attribs.href || "") === backLink) {
        return match[1];
      }
      stack.push(...node.children);
    }
  }
  return null;
}

/** Collect every footnote ref id (A) and footnote list-item id (B) in the DOM. */
function collectFootnoteSignals(nodes: ChildNode[]): {
  refIds: Set<string>;
  listIds: Set<string>;
} {
  const refIds = new Set<string>();
  const listIds = new Set<string>();
  const walk = (ns: ChildNode[]): void => {
    for (const node of ns) {
      if (!isElement(node)) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === "a") {
        const id = footnoteRefId(node);
        if (id !== null) refIds.add(id);
      } else if (tag === "li") {
        const id = footnoteListItemId(node);
        if (id !== null) listIds.add(id);
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return { refIds, listIds };
}

/**
 * RECONCILIATION INVARIANT (CRITICAL-3): a footnote id is reconstructed only
 * when it has an inline mark target (A) AND a removable trailing `<li>` (B) AND
 * a captured body (C). Any id where these disagree (a mammoth-format drift) is
 * left to degrade to a visible list — no mark, no `<li>` removal, export emits
 * nothing for it — converting a half-state into the lesser evil
 * (degraded-but-present), never silent loss or duplication.
 */
function reconcileFootnotes(
  nodes: ChildNode[],
  footnoteBodies: Record<string, FootnoteBody>,
): Set<string> {
  const { refIds, listIds } = collectFootnoteSignals(nodes);
  const bodyIds = new Set(Object.keys(footnoteBodies));
  const approved = new Set<string>();
  for (const id of new Set([...refIds, ...listIds, ...bodyIds])) {
    if (refIds.has(id) && listIds.has(id) && bodyIds.has(id)) {
      approved.add(id);
    } else {
      console.error(
        `[docx-footnotes] footnote id=${id} failed reconciliation ` +
          `(inline-ref=${refIds.has(id)} list-item=${listIds.has(id)} body=${bodyIds.has(id)}); ` +
          "degrading to a visible list for this id (no reconstruction).",
      );
    }
  }
  return approved;
}

/**
 * Compute which CAPTURED footnote ids will reconstruct vs be dropped, for a
 * given mammoth HTML + captured bodies, WITHOUT mutating a doc or logging. The
 * import honesty line (computed in `parse`, before `apply` runs the transform)
 * calls this so it reflects the SAME reconciliation `htmlToYDoc` performs in
 * `apply` — identical inputs (`loaded.html` + bodies) → identical partition — so
 * a footnote that fails reconciliation (an orphaned definition with no inline
 * ref, or a future mammoth-format drift) is reported as a real loss instead of
 * being silently claimed "preserved". Logging stays in `reconcileFootnotes` (the
 * apply path) so a discrepancy is recorded exactly once.
 */
export function reconcileFootnoteIds(
  html: string,
  footnoteBodies: Record<string, FootnoteBody>,
): { reconstructed: string[]; dropped: string[] } {
  const bodyIds = Object.keys(footnoteBodies);
  if (bodyIds.length === 0) return { reconstructed: [], dropped: [] };
  if (!html.trim()) return { reconstructed: [], dropped: bodyIds };
  const { refIds, listIds } = collectFootnoteSignals(htmlparser2.parseDocument(html).children);
  const reconstructed: string[] = [];
  const dropped: string[] = [];
  for (const id of bodyIds) {
    (refIds.has(id) && listIds.has(id) ? reconstructed : dropped).push(id);
  }
  return { reconstructed, dropped };
}

/**
 * Detector B: remove approved footnotes' trailing `<li>`s so the reconstructed
 * body doesn't ALSO survive as a visible list. Operates at `<li>` granularity
 * (leaves endnote / non-approved items in place) and drops an enclosing `<ol>`
 * only when no `<li>` survives. Returns the rewritten children array.
 */
function pruneFootnoteListItems(nodes: ChildNode[], approved: Set<string>): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of nodes) {
    if (isElement(node)) {
      if (node.tagName.toLowerCase() === "ol") {
        const kept = node.children.filter((child) => {
          if (isElement(child) && child.tagName.toLowerCase() === "li") {
            const id = footnoteListItemId(child);
            if (id !== null && approved.has(id)) return false;
          }
          return true;
        });
        const survivingLi = kept.some(
          (child) => isElement(child) && child.tagName.toLowerCase() === "li",
        );
        if (!survivingLi) continue; // list emptied by removal → drop it entirely
        node.children = pruneFootnoteListItems(kept, approved);
        out.push(node);
        continue;
      }
      node.children = pruneFootnoteListItems(node.children, approved);
    }
    out.push(node);
  }
  return out;
}

/**
 * Build Yjs insert attributes from the current mark stack.
 * Explicitly sets null for inactive marks to prevent Yjs mark inheritance.
 */
function buildAttrs(marks: Record<string, object>): Record<string, object | null> {
  const attrs: Record<string, object | null> = {};
  for (const name of ALL_MARKS) {
    attrs[name] = name in marks ? marks[name] : null;
  }
  return attrs;
}

function isElement(node: ChildNode): node is Element {
  return node.type === "tag";
}

function isText(node: ChildNode): node is Text {
  return node.type === "text";
}

/**
 * Convert parsed HTML into Y.Doc XmlFragment elements.
 * Two-pass pattern per ADR-009: build element tree first, then populate text.
 *
 * `footnoteBodies` (#1123 Tier-A #3 PR 2) are the footnote bodies captured from
 * `word/footnotes.xml`, keyed by OOXML id. When provided, footnotes that pass
 * reconciliation get a `footnote-ref` mark on their inline `[N]` text and have
 * their trailing `<li>` pruned. Returns the RECONCILED subset (only ids that
 * actually reconstructed) — the caller persists exactly these to
 * Y_MAP_FOOTNOTE_BODIES so a stale id from a prior reload can't linger.
 */
export function htmlToYDoc(
  doc: Y.Doc,
  html: string,
  footnoteBodies: Record<string, FootnoteBody> = {},
): Record<string, FootnoteBody> {
  const fragment = doc.getXmlFragment("default");

  // Clear existing content
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  if (!html.trim()) return {};

  const parsed = htmlparser2.parseDocument(html);

  // Footnote reconciliation: which ids have a mark target (A), a removable
  // trailing <li> (B), AND a captured body (C). Then prune the approved <li>s
  // from the DOM BEFORE the transform so the body doesn't double as a list.
  const approvedFootnotes = reconcileFootnotes(parsed.children, footnoteBodies);
  parsed.children = pruneFootnoteListItems(parsed.children, approvedFootnotes);

  const deferred: DeferredText[] = [];
  const allElements: Y.XmlElement[] = [];

  // Pass 1: build element tree, collect deferred text ops
  for (const child of parsed.children) {
    allElements.push(...domNodeToYxml(child, deferred));
  }

  // Attach all elements to the doc
  if (allElements.length > 0) {
    fragment.insert(0, allElements);
  }

  // Pass 2: populate text now that elements are attached to Y.Doc (Detector A
  // attaches footnote-ref marks for approved ids).
  for (const { xmlText, children, marks } of deferred) {
    processInlineNodes(xmlText, children, marks, approvedFootnotes);
  }

  const reconciled: Record<string, FootnoteBody> = {};
  for (const id of approvedFootnotes) reconciled[id] = footnoteBodies[id];
  return reconciled;
}

/** Convert a DOM node to Y.XmlElement(s). Inline-only containers become paragraphs. */
function domNodeToYxml(node: ChildNode, deferred: DeferredText[]): Y.XmlElement[] {
  if (isText(node)) {
    // Top-level text node — wrap in paragraph
    const text = node.data;
    if (!text.trim()) return [];
    const el = new Y.XmlElement("paragraph");
    const xmlText = new Y.XmlText();
    el.insert(0, [xmlText]);
    deferred.push({ xmlText, children: [node], marks: {} });
    return [el];
  }

  if (!isElement(node)) return [];

  const tag = node.tagName.toLowerCase();

  // Heading
  const headingMatch = tag.match(/^h([1-6])$/);
  if (headingMatch) {
    const el = new Y.XmlElement("heading");
    el.setAttribute("level", parseInt(headingMatch[1]) as any);
    const xmlText = new Y.XmlText();
    el.insert(0, [xmlText]);
    deferred.push({ xmlText, children: node.children, marks: {} });
    return [el];
  }

  switch (tag) {
    case "p": {
      const el = new Y.XmlElement("paragraph");
      const xmlText = new Y.XmlText();
      el.insert(0, [xmlText]);
      deferred.push({ xmlText, children: node.children, marks: {} });
      return [el];
    }

    case "blockquote": {
      const el = new Y.XmlElement("blockquote");
      const blockChildren = collectBlockChildren(node.children, deferred);
      for (const child of blockChildren) {
        el.insert(el.length, [child]);
      }
      return [el];
    }

    case "ul": {
      const el = new Y.XmlElement("bulletList");
      for (const child of node.children) {
        if (isElement(child) && child.tagName.toLowerCase() === "li") {
          el.insert(el.length, [buildListItem(child, deferred)]);
        }
      }
      return [el];
    }

    case "ol": {
      const el = new Y.XmlElement("orderedList");
      const start = parseInt(node.attribs.start || "1");
      if (start !== 1) {
        el.setAttribute("start", start as any);
      }
      for (const child of node.children) {
        if (isElement(child) && child.tagName.toLowerCase() === "li") {
          el.insert(el.length, [buildListItem(child, deferred)]);
        }
      }
      return [el];
    }

    case "table": {
      const el = new Y.XmlElement("table");
      // Walk tbody/thead/tfoot or direct tr children
      const rows = collectTableRows(node);
      for (const row of rows) {
        el.insert(el.length, [buildTableRow(row, deferred)]);
      }
      return [el];
    }

    case "pre": {
      const el = new Y.XmlElement("codeBlock");
      const xmlText = new Y.XmlText();
      el.insert(0, [xmlText]);
      // Collect all text content from pre (which may contain a <code> child)
      deferred.push({ xmlText, children: node.children, marks: {} });
      return [el];
    }

    case "img": {
      const el = new Y.XmlElement("image");
      el.setAttribute("src", node.attribs.src || "");
      if (node.attribs.alt) el.setAttribute("alt", node.attribs.alt);
      if (node.attribs.title) el.setAttribute("title", node.attribs.title);
      return [el];
    }

    case "hr": {
      return [new Y.XmlElement("horizontalRule")];
    }

    case "br": {
      // Top-level <br> — produce an empty paragraph
      const el = new Y.XmlElement("paragraph");
      el.insert(0, [new Y.XmlText("")]);
      return [el];
    }

    case "div": {
      // Recurse into div, treating it as a transparent container
      const results: Y.XmlElement[] = [];
      for (const child of node.children) {
        results.push(...domNodeToYxml(child, deferred));
      }
      return results;
    }

    default: {
      // Unknown block tag or inline-as-block: wrap in paragraph
      if (hasBlockChildren(node)) {
        // Contains blocks — recurse
        const results: Y.XmlElement[] = [];
        for (const child of node.children) {
          results.push(...domNodeToYxml(child, deferred));
        }
        return results;
      }
      // Pure inline content — wrap in paragraph
      const el = new Y.XmlElement("paragraph");
      const xmlText = new Y.XmlText();
      el.insert(0, [xmlText]);
      deferred.push({ xmlText, children: node.children, marks: {} });
      return [el];
    }
  }
}

/** Check if a node has any block-level element children */
function hasBlockChildren(node: Element): boolean {
  return node.children.some(
    (child) => isElement(child) && BLOCK_TAGS.has(child.tagName.toLowerCase()),
  );
}

/** Collect block children from a list of DOM nodes, wrapping stray text in paragraphs */
function collectBlockChildren(children: ChildNode[], deferred: DeferredText[]): Y.XmlElement[] {
  const result: Y.XmlElement[] = [];
  let inlineBuffer: ChildNode[] = [];

  const flushInline = () => {
    if (inlineBuffer.length === 0) return;
    // Only flush if there's non-whitespace content
    const hasContent = inlineBuffer.some((n) => (isText(n) ? n.data.trim().length > 0 : true));
    if (hasContent) {
      const el = new Y.XmlElement("paragraph");
      const xmlText = new Y.XmlText();
      el.insert(0, [xmlText]);
      deferred.push({ xmlText, children: inlineBuffer, marks: {} });
      result.push(el);
    }
    inlineBuffer = [];
  };

  for (const child of children) {
    if (isElement(child) && BLOCK_TAGS.has(child.tagName.toLowerCase())) {
      flushInline();
      result.push(...domNodeToYxml(child, deferred));
    } else {
      inlineBuffer.push(child);
    }
  }
  flushInline();

  // Ensure at least one paragraph (Tiptap requires content in block containers)
  if (result.length === 0) {
    const el = new Y.XmlElement("paragraph");
    el.insert(0, [new Y.XmlText("")]);
    result.push(el);
  }

  return result;
}

/** Build a listItem Y.XmlElement from an <li> DOM node */
function buildListItem(li: Element, deferred: DeferredText[]): Y.XmlElement {
  const listItem = new Y.XmlElement("listItem");
  const blockChildren = collectBlockChildren(li.children, deferred);
  for (const child of blockChildren) {
    listItem.insert(listItem.length, [child]);
  }
  return listItem;
}

/** Collect all <tr> elements from a <table>, walking through tbody/thead/tfoot */
function collectTableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of table.children) {
    if (!isElement(child)) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === "tr") {
      rows.push(child);
    } else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const grandchild of child.children) {
        if (isElement(grandchild) && grandchild.tagName.toLowerCase() === "tr") {
          rows.push(grandchild);
        }
      }
    }
  }
  return rows;
}

/** Build a tableRow Y.XmlElement from a <tr> */
function buildTableRow(tr: Element, deferred: DeferredText[]): Y.XmlElement {
  const row = new Y.XmlElement("tableRow");
  for (const child of tr.children) {
    if (!isElement(child)) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === "td" || tag === "th") {
      const nodeName = tag === "th" ? "tableHeader" : "tableCell";
      const cell = new Y.XmlElement(nodeName);

      // Copy colspan/rowspan
      if (child.attribs.colspan && child.attribs.colspan !== "1") {
        cell.setAttribute("colspan", parseInt(child.attribs.colspan) as any);
      }
      if (child.attribs.rowspan && child.attribs.rowspan !== "1") {
        cell.setAttribute("rowspan", parseInt(child.attribs.rowspan) as any);
      }

      // Tiptap requires cells to contain block elements (content: 'block+')
      const cellBlocks = collectBlockChildren(child.children, deferred);
      for (const block of cellBlocks) {
        cell.insert(cell.length, [block]);
      }

      row.insert(row.length, [cell]);
    }
  }
  return row;
}

/**
 * Process inline DOM nodes into a Y.XmlText with marks.
 * Uses insert-with-attributes per ADR-009.
 */
function processInlineNodes(
  xmlText: Y.XmlText,
  nodes: ChildNode[],
  marks: Record<string, object>,
  approvedFootnotes: Set<string>,
): void {
  for (const node of nodes) {
    if (isText(node)) {
      const text = node.data;
      if (text.length > 0) {
        xmlText.insert(xmlText.length, text, buildAttrs(marks));
      }
      continue;
    }

    if (!isElement(node)) continue;

    const tag = node.tagName.toLowerCase();

    // Hard break
    if (tag === "br") {
      const embed = new Y.XmlElement("hardBreak");
      xmlText.insertEmbed(xmlText.length, embed);
      continue;
    }

    // Detector A: a reconstructed footnote's inline reference. Attach the
    // `footnote-ref` mark ONLY — DROP the inherited superscript (export's
    // FootnoteReferenceRun renders superscript natively) and the now-empty link,
    // so gen1/gen2 mark-key sets match. Read the id from the RAW href before the
    // `a` mark factory below sanitizes "#footnote-N" to "".
    if (tag === "a") {
      const fnId = footnoteRefId(node);
      if (fnId !== null && approvedFootnotes.has(fnId)) {
        processInlineNodes(
          xmlText,
          node.children,
          { "footnote-ref": { id: fnId, kind: "footnote" } },
          approvedFootnotes,
        );
        continue;
      }
    }

    // Inline mark tag?
    const markFactory = INLINE_MARK_TAGS[tag];
    if (markFactory) {
      const newMarks = { ...marks, ...markFactory(node) };
      processInlineNodes(xmlText, node.children, newMarks, approvedFootnotes);
      continue;
    }

    // Code element inside pre — just extract text
    if (tag === "code") {
      processInlineNodes(xmlText, node.children, marks, approvedFootnotes);
      continue;
    }

    // Unknown inline element — recurse (best effort)
    processInlineNodes(xmlText, node.children, marks, approvedFootnotes);
  }
}
