import type { AlignType, PhrasingContent, Root, RootContent, Table } from "mdast";
import * as Y from "yjs";
import { serializeMdastBlock, serializeMdastInline } from "./markdown.js";

const MARKDOWN_HTML_ATTR = "markdownHtml";
/**
 * Marks a `paragraph` whose Y.XmlText holds the verbatim markdown source of a
 * construct Tandem has no first-class editor node for (footnote/reference
 * definitions, unknown blocks). Re-emitted as an mdast `html` node on save so
 * it round-trips byte-exact, and surfaced to the editor as `data-markdown-raw`
 * for the show/hide toggle. Sibling to MARKDOWN_HTML_ATTR. See #981 / ADR-042.
 */
const MARKDOWN_RAW_ATTR = "markdownRaw";
/**
 * Delta-attribute key for an inline run holding verbatim markdown source
 * (footnoteReference, linkReference, imageReference, inline image, inline html).
 * MUST byte-match the Tiptap `rawMarkdown` Mark name. Listed in ALL_MARKS so
 * `buildAttrs` emits it; read back in `deltaToPhrasingContent`.
 */
const RAW_MARKDOWN_MARK = "rawMarkdown";

/**
 * Convert an MDAST tree into Y.Doc XmlFragment elements.
 * Block nodes become Y.XmlElements with Tiptap-compatible nodeNames.
 * Inline content becomes formatted Y.XmlText within those elements.
 *
 * Elements are attached to the doc BEFORE text is populated — Yjs
 * requires this for correct insert ordering on Y.XmlText.
 */
export function mdastToYDoc(doc: Y.Doc, tree: Root): void {
  const fragment = doc.getXmlFragment("default");

  // Clear existing content in a single operation
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  // Two-pass: build structure first, then populate text.
  // Pass 1 collects deferred text operations while building the element tree.
  // Yjs requires Y.XmlText to be attached to a doc for correct insert ordering.
  const deferred: Array<{ xmlText: Y.XmlText; nodes?: PhrasingContent[]; plainText?: string }> = [];
  const allElements: Y.XmlElement[] = [];
  for (const node of tree.children) {
    allElements.push(...blockToYxml(node, deferred));
  }

  // Attach all elements to the doc (pass 1 complete)
  if (allElements.length > 0) {
    fragment.insert(0, allElements);
  }

  // Pass 2: populate text now that elements are attached to the Y.Doc
  for (const { xmlText, nodes, plainText } of deferred) {
    if (nodes) {
      processInline(xmlText, nodes, {});
    } else if (plainText != null) {
      xmlText.insert(0, plainText);
    }
  }
}

/** Convert a block-level MDAST node to one or more Y.XmlElements */
function blockToYxml(
  node: RootContent,
  deferred: Array<{ xmlText: Y.XmlText; nodes?: PhrasingContent[]; plainText?: string }>,
): Y.XmlElement[] {
  switch (node.type) {
    case "heading": {
      const el = new Y.XmlElement("heading");
      el.setAttribute("level", node.depth as any);
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, nodes: node.children });
      return [el];
    }

    case "paragraph": {
      // A standalone markdown image (`![alt](url)`) parses as `paragraph > image`
      // (image is phrasing content). Promote any top-level image children to
      // block-level `image` Y.XmlElements (issue #153) so they render via
      // Tiptap's block Image node. Inline text runs around an image stay as
      // their own paragraphs. Block images live as top-level fragment children
      // with empty getElementText(), preserving flat-offset alignment.
      if (node.children.some((c) => c.type === "image")) {
        return splitParagraphImages(node.children, deferred);
      }
      const el = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, nodes: node.children });
      return [el];
    }

    case "blockquote": {
      const el = new Y.XmlElement("blockquote");
      let insertIndex = 0;
      for (const child of node.children) {
        const childEls = blockToYxml(child, deferred);
        for (const c of childEls) {
          el.insert(insertIndex, [c]);
          insertIndex++;
        }
      }
      return [el];
    }

    case "list": {
      const nodeName = node.ordered ? "orderedList" : "bulletList";
      const el = new Y.XmlElement(nodeName);
      if (node.ordered && node.start != null && node.start !== 1) {
        el.setAttribute("start", node.start as any);
      }
      let listIndex = 0;
      for (const item of node.children) {
        const listItem = new Y.XmlElement("listItem");
        let itemIndex = 0;
        for (const child of item.children) {
          const childEls = blockToYxml(child, deferred);
          for (const c of childEls) {
            listItem.insert(itemIndex, [c]);
            itemIndex++;
          }
        }
        el.insert(listIndex, [listItem]);
        listIndex++;
      }
      return [el];
    }

    case "code": {
      const el = new Y.XmlElement("codeBlock");
      if (node.lang) {
        el.setAttribute("language", node.lang);
      }
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, plainText: node.value });
      return [el];
    }

    case "thematicBreak": {
      return [new Y.XmlElement("horizontalRule")];
    }

    case "table": {
      // GFM table: first MDAST tableRow becomes a row of tableHeader cells;
      // subsequent rows become tableCell rows. Column alignment is stored as
      // a JSON-stringified table-level "align" attribute (matches MDAST's
      // table-level storage and avoids per-cell alignment plumbing).
      //
      // Per CLAUDE.md "Y.XmlText must be attached before populating": each
      // cell's paragraph + Y.XmlText is attached to the tree first, and the
      // inline children are pushed to deferred[] for the second pass — same
      // pattern used by paragraph/heading above.
      const tableEl = new Y.XmlElement("table");
      const align: (AlignType | null | undefined)[] = node.align ?? [];
      tableEl.setAttribute("align", JSON.stringify(align) as any);
      node.children.forEach((row, rowIdx) => {
        const rowEl = new Y.XmlElement("tableRow");
        const cellNodeName = rowIdx === 0 ? "tableHeader" : "tableCell";
        for (const cell of row.children) {
          const cellEl = new Y.XmlElement(cellNodeName);
          // Tiptap wraps cell content in a paragraph; mirror that here so the
          // Y.Doc structure matches what the editor would produce.
          const para = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          // Attach in order: row → cell → paragraph → text. Each child is
          // attached to its parent before deferring inline population.
          cellEl.insert(0, [para]);
          para.insert(0, [text]);
          rowEl.insert(rowEl.length, [cellEl]);
          deferred.push({ xmlText: text, nodes: cell.children });
        }
        tableEl.insert(tableEl.length, [rowEl]);
      });
      return [tableEl];
    }

    case "image": {
      return [imageToYxml(node)];
    }

    case "html": {
      const el = new Y.XmlElement("paragraph");
      el.setAttribute(MARKDOWN_HTML_ATTR, true as any);
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, plainText: node.value });
      return [el];
    }

    // Footnote/reference definitions and any other structured block Tandem has
    // no first-class node for: store the verbatim markdown source in a
    // `paragraph[markdownRaw]` and re-emit as an mdast `html` node on save so
    // nothing is silently dropped (the historical bug — these carry no `.value`
    // so the old default returned []). See #981 / ADR-042.
    case "footnoteDefinition":
    case "definition":
      return [rawBlockParagraph(serializeMdastBlock(node), deferred)];

    default: {
      if ("value" in node && typeof node.value === "string") {
        const el = new Y.XmlElement("paragraph");
        const text = new Y.XmlText();
        el.insert(0, [text]);
        deferred.push({ xmlText: text, plainText: node.value });
        return [el];
      }
      // Unknown structured block: preserve verbatim rather than drop it.
      const serialized = serializeMdastBlock(node);
      return serialized.length > 0 ? [rawBlockParagraph(serialized, deferred)] : [];
    }
  }
}

/**
 * Build a `paragraph[markdownRaw]` carrying verbatim markdown source as text.
 * Mirrors the `markdownHtml` block pattern: text is deferred to pass 2 so the
 * Y.XmlText is attached before population (CLAUDE.md two-pass rule).
 */
function rawBlockParagraph(
  source: string,
  deferred: Array<{ xmlText: Y.XmlText; nodes?: PhrasingContent[]; plainText?: string }>,
): Y.XmlElement {
  const el = new Y.XmlElement("paragraph");
  el.setAttribute(MARKDOWN_RAW_ATTR, true as any);
  const text = new Y.XmlText();
  el.insert(0, [text]);
  deferred.push({ xmlText: text, plainText: source });
  return el;
}

/** Build a block-level `image` Y.XmlElement from an MDAST image node. */
function imageToYxml(node: Extract<PhrasingContent, { type: "image" }>): Y.XmlElement {
  const el = new Y.XmlElement("image");
  el.setAttribute("src", node.url);
  if (node.alt) el.setAttribute("alt", node.alt);
  if (node.title) el.setAttribute("title", node.title);
  return el;
}

/**
 * Split a paragraph's phrasing children into block-level `image` elements and
 * paragraphs for the surrounding inline content. Used when a markdown paragraph
 * contains one or more images (issue #153). Each top-level image becomes its own
 * block; runs of non-image phrasing between/around images become paragraphs.
 * Whitespace-only inline runs adjacent to an image are dropped so a lone image
 * doesn't leave an empty paragraph behind; boundary whitespace on real runs is
 * trimmed to avoid serializer escape noise.
 */
function splitParagraphImages(
  children: PhrasingContent[],
  deferred: Array<{ xmlText: Y.XmlText; nodes?: PhrasingContent[]; plainText?: string }>,
): Y.XmlElement[] {
  const result: Y.XmlElement[] = [];
  let inlineRun: PhrasingContent[] = [];

  const flushInline = () => {
    if (inlineRun.length === 0) return;
    const run = inlineRun;
    inlineRun = [];
    // Trim whitespace at the run boundaries (where it abutted an image) so the
    // serializer doesn't emit `&#x20;` escape noise around the split.
    const first = run[0];
    if (first?.type === "text") first.value = first.value.replace(/^\s+/, "");
    const last = run[run.length - 1];
    if (last?.type === "text") last.value = last.value.replace(/\s+$/, "");
    const hasContent = run.some((n) => n.type !== "text" || n.value.length > 0);
    if (hasContent) {
      const el = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, nodes: run });
      result.push(el);
    }
  };

  for (const child of children) {
    if (child.type === "image") {
      flushInline();
      result.push(imageToYxml(child));
    } else {
      inlineRun.push(child);
    }
  }
  flushInline();

  return result;
}

/** All mark names that can appear on inline text */
const ALL_MARKS = ["bold", "italic", "strike", "code", "link", RAW_MARKDOWN_MARK] as const;

/**
 * Build Yjs insert attributes from the current mark stack.
 * Explicitly sets null for inactive marks to prevent Yjs from
 * inheriting formatting from adjacent formatted segments.
 */
function buildAttrs(marks: Record<string, object>): Record<string, object | null> {
  const attrs: Record<string, object | null> = {};
  for (const name of ALL_MARKS) {
    attrs[name] = name in marks ? marks[name] : null;
  }
  return attrs;
}

/**
 * Insert verbatim markdown source as a `rawMarkdown`-marked text run.
 * MUST use insert-with-attributes (never `insertEmbed`, never a fresh
 * Y.XmlText): the source stays as real text so every character counts 1-for-1
 * in `getElementText()`, keeping flat annotation offsets aligned. An embed
 * would collapse the run to flat-length 1 and desync every later anchor (#981).
 */
function insertRaw(xmlText: Y.XmlText, source: string, marks: Record<string, object>): void {
  if (source.length === 0) return;
  xmlText.insert(xmlText.length, source, buildAttrs({ ...marks, [RAW_MARKDOWN_MARK]: {} }));
}

/**
 * Process inline/phrasing MDAST nodes into a single Y.XmlText with marks.
 * Uses insert-with-attributes (not insert + format) because Yjs requires
 * the Y.XmlText to be attached to a doc for format() to preserve order.
 */
function processInline(
  xmlText: Y.XmlText,
  nodes: PhrasingContent[],
  marks: Record<string, object>,
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        xmlText.insert(xmlText.length, node.value, buildAttrs(marks));
        break;
      }

      case "strong":
        processInline(xmlText, node.children, { ...marks, bold: {} });
        break;

      case "emphasis":
        processInline(xmlText, node.children, { ...marks, italic: {} });
        break;

      case "delete":
        processInline(xmlText, node.children, { ...marks, strike: {} });
        break;

      case "inlineCode": {
        xmlText.insert(xmlText.length, node.value, buildAttrs({ ...marks, code: {} }));
        break;
      }

      case "link":
        processInline(xmlText, node.children, {
          ...marks,
          link: { href: node.url, ...(node.title ? { title: node.title } : {}) },
        });
        break;

      case "break": {
        const embed = new Y.XmlElement("hardBreak");
        xmlText.insertEmbed(xmlText.length, embed);
        break;
      }

      case "image": {
        // Truly-inline images (standalone images are promoted to block-level
        // `image` nodes before reaching here, see the paragraph case). Preserve
        // the full `![alt](url "title")` source as a raw run so the URL/title
        // survive the round-trip instead of degrading to alt-text only (#981).
        insertRaw(xmlText, serializeMdastInline(node) || node.alt || node.url, marks);
        break;
      }

      // footnoteReference / linkReference / imageReference carry no `.value`;
      // serialize each to its verbatim markdown source and store as a raw run so
      // the construct round-trips (the historical silent drop). See #981.
      case "footnoteReference":
      case "linkReference":
      case "imageReference":
        insertRaw(xmlText, serializeMdastInline(node), marks);
        break;

      // Inline (phrasing) HTML. mdast emits one `html` node per tag, so paired
      // tags like <span>…</span> arrive as separate nodes around real prose;
      // mark each tag's value as raw — the prose between stays normal text.
      case "html":
        insertRaw(xmlText, node.value, marks);
        break;

      default: {
        // Unreachable for the static PhrasingContent union (all variants are
        // cased above) — kept as a runtime net for any plugin-added node type.
        // `node` is `never` here, so widen through `unknown` before inspecting.
        const widened = node as unknown as PhrasingContent & { value?: string };
        const src = serializeMdastInline(widened);
        if (src.length > 0) {
          insertRaw(xmlText, src, marks);
        } else if (typeof widened.value === "string") {
          xmlText.insert(xmlText.length, widened.value, buildAttrs(marks));
        }
        break;
      }
    }
  }
}

/**
 * Convert a Y.Doc's XmlFragment back to an MDAST Root tree.
 */
export function yDocToMdast(doc: Y.Doc): Root {
  const fragment = doc.getXmlFragment("default");
  const children: RootContent[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const mdastNode = yxmlToMdast(node);
      if (mdastNode) children.push(mdastNode);
    }
  }

  return { type: "root", children };
}

/** Convert a Y.XmlElement back to an MDAST block node */
function yxmlToMdast(el: Y.XmlElement): RootContent | null {
  switch (el.nodeName) {
    case "heading": {
      const depth = Number(el.getAttribute("level") ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: "heading", depth, children: deltaToPhrasingContent(el) };
    }

    case "paragraph":
      // Both markdownRaw (footnote/reference defs, unknown blocks) and
      // markdownHtml (raw HTML blocks) re-emit as an mdast `html` node — its
      // value serializes verbatim, reproducing the original source exactly.
      if (el.getAttribute(MARKDOWN_RAW_ATTR) || el.getAttribute(MARKDOWN_HTML_ATTR)) {
        return { type: "html", value: getElementPlainText(el) } as any;
      }
      return { type: "paragraph", children: deltaToPhrasingContent(el) };

    case "blockquote": {
      const children: RootContent[] = [];
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlElement) {
          const m = yxmlToMdast(child);
          if (m) children.push(m);
        }
      }
      // blockquote.children is BlockContent[] but RootContent covers it
      return { type: "blockquote", children: children as any };
    }

    case "bulletList":
    case "orderedList": {
      const ordered = el.nodeName === "orderedList";
      const start = ordered ? Number(el.getAttribute("start")) || 1 : undefined;
      const listItems: any[] = [];
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlElement && child.nodeName === "listItem") {
          const itemChildren: any[] = [];
          for (let j = 0; j < child.length; j++) {
            const grandchild = child.get(j);
            if (grandchild instanceof Y.XmlElement) {
              const m = yxmlToMdast(grandchild);
              if (m) itemChildren.push(m);
            }
          }
          listItems.push({ type: "listItem", spread: false, children: itemChildren });
        }
      }
      return {
        type: "list",
        ordered,
        spread: false,
        ...(ordered && start !== 1 ? { start } : {}),
        children: listItems,
      } as any;
    }

    case "codeBlock": {
      const lang = el.getAttribute("language") as string | undefined;
      let value = "";
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlText) {
          value += child.toString();
        }
      }
      return { type: "code", lang: lang || null, value } as any;
    }

    case "horizontalRule":
      return { type: "thematicBreak" };

    case "table": {
      // Read column alignment from the table-level "align" attribute (stored
      // as JSON). Default to [] if missing or unparseable — alignment is
      // optional in GFM, body-row alignment attrs are ignored.
      let align: (AlignType | null)[] = [];
      const rawAlign = el.getAttribute("align");
      if (typeof rawAlign === "string" && rawAlign.length > 0) {
        try {
          const parsed = JSON.parse(rawAlign);
          if (Array.isArray(parsed)) align = parsed as (AlignType | null)[];
        } catch {
          // fall through with empty align
        }
      }
      const rows: any[] = [];
      for (let i = 0; i < el.length; i++) {
        const rowChild = el.get(i);
        if (!(rowChild instanceof Y.XmlElement) || rowChild.nodeName !== "tableRow") {
          continue;
        }
        const cells: any[] = [];
        for (let j = 0; j < rowChild.length; j++) {
          const cellChild = rowChild.get(j);
          if (
            cellChild instanceof Y.XmlElement &&
            (cellChild.nodeName === "tableHeader" || cellChild.nodeName === "tableCell")
          ) {
            cells.push({ type: "tableCell", children: cellToPhrasingContent(cellChild) });
          }
        }
        rows.push({ type: "tableRow", children: cells });
      }
      return { type: "table", align, children: rows } as Table;
    }

    case "image": {
      // MDAST `image` is phrasing content, not a valid direct root child.
      // Wrap it in a paragraph so remark-stringify emits proper block
      // separation (a bare root-level image serializes with no surrounding
      // newlines, mangling the document on save). Mirrors how remark-parse
      // produces `paragraph > image` for a standalone `![alt](url)` (#153).
      const image = {
        type: "image",
        url: (el.getAttribute("src") as string) || "",
        alt: (el.getAttribute("alt") as string) || undefined,
        title: (el.getAttribute("title") as string) || null,
      };
      return { type: "paragraph", children: [image] } as any;
    }

    // Unknown node types — try to extract text content as a paragraph
    default: {
      const phrasing = deltaToPhrasingContent(el);
      if (phrasing.length > 0) {
        return { type: "paragraph", children: phrasing };
      }
      return null;
    }
  }
}

/**
 * Strip y-prosemirror hash suffixes from attribute keys.
 * y-prosemirror appends "--<hash>" to mark names in delta attributes.
 */
function stripHashSuffix(key: string): string {
  const dashIdx = key.indexOf("--");
  return dashIdx >= 0 ? key.slice(0, dashIdx) : key;
}

function getElementPlainText(el: Y.XmlElement): string {
  let value = "";
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) value += child.toString();
  }
  return value;
}

/**
 * Convert Y.XmlText delta segments into MDAST phrasing content.
 * Handles marks (bold, italic, strike, code, link) and hardBreak embeds.
 */
function deltaToPhrasingContent(el: Y.XmlElement): PhrasingContent[] {
  const result: PhrasingContent[] = [];

  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);

    if (child instanceof Y.XmlText) {
      const delta = child.toDelta();
      for (const op of delta) {
        // Embedded elements (hardBreak, etc.)
        if (typeof op.insert !== "string") {
          if (op.insert instanceof Y.XmlElement && op.insert.nodeName === "hardBreak") {
            result.push({ type: "break" });
          }
          continue;
        }

        const text = op.insert;
        if (text.length === 0) continue;

        // Collect marks from delta attributes
        const attrs = op.attributes || {};
        const marks = new Map<string, any>();
        for (const [key, value] of Object.entries(attrs)) {
          marks.set(stripHashSuffix(key), value);
        }

        // A `rawMarkdown` run is verbatim markdown source (footnote/reference
        // refs, inline image, inline html). Emit as an inline `html` node — it
        // serializes byte-exact, bypassing the `text` escaper (PhrasingContent
        // includes Html, so the cast is structural only). It then flows through
        // the SAME link/strike/italic/bold wrapping below as ordinary text, so:
        //   (a) an outer mark on the run is preserved (e.g. bold around a
        //       footnote ref), and
        //   (b) crucially, a raw inline IMAGE stays wrapped inside its mark
        //       rather than becoming a bare paragraph-child image — which the
        //       #153 `splitParagraphImages` promotion would otherwise turn into
        //       a block image on reload, collapsing the inline run's flat length
        //       and desyncing every later annotation offset.
        // Two adjacent UNMARKED raw runs (e.g. `[^1][^2]`) stay separate: `html`
        // has no wrapper, so `coalescePhrasing`'s `sameWrapper` never merges them.
        //
        // `code` is a leaf-level mark: the segment is either an inlineCode leaf
        // or a plain-text leaf. link/strike/italic/bold then each wrap whatever
        // `node` is — inlineCode is valid PhrasingContent inside all of them, so
        // a code span keeps its mark even when combined with bold/italic/etc.
        let node: PhrasingContent = marks.has(RAW_MARKDOWN_MARK)
          ? ({ type: "html", value: text } as any)
          : marks.has("code")
            ? { type: "inlineCode", value: text }
            : { type: "text", value: text };

        // Wrap from innermost to outermost: link, then strike, italic, bold.
        if (marks.has("link")) {
          const linkAttrs = marks.get("link") || {};
          node = {
            type: "link",
            url: linkAttrs.href || "",
            ...(linkAttrs.title ? { title: linkAttrs.title } : {}),
            children: [node],
          };
        }
        if (marks.has("strike")) {
          node = { type: "delete", children: [node] } as any;
        }
        if (marks.has("italic")) {
          node = { type: "emphasis", children: [node] };
        }
        if (marks.has("bold")) {
          node = { type: "strong", children: [node] };
        }

        result.push(node);
      }
    } else if (child instanceof Y.XmlElement) {
      // Non-text child elements embedded in a block (shouldn't happen often)
      if (child.nodeName === "hardBreak") {
        result.push({ type: "break" });
      }
    }
  }

  return coalescePhrasing(result);
}

/**
 * Merge adjacent phrasing nodes that share the same wrapper (strong/emphasis/
 * delete, or a link with identical url+title) into one node, recursing into
 * children. Each delta segment is wrapped independently above, so a bold run
 * containing a code span produces a `strong > text` node adjacent to a
 * `strong > inlineCode` node. Left un-merged, remark-stringify pads the two
 * adjacent emphasis runs with `&#x20;` / doubled `**`, corrupting the file on
 * save. Y.js `toDelta()` already collapses runs with identical attributes, so
 * the only adjacent same-wrapper nodes here differ in some inner mark.
 */
function coalescePhrasing(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && sameWrapper(prev, node)) {
      const merged = prev as Extract<PhrasingContent, { children: PhrasingContent[] }>;
      merged.children = coalescePhrasing([...merged.children, ...(node as typeof merged).children]);
    } else {
      out.push(node);
    }
  }
  return out;
}

function sameWrapper(a: PhrasingContent, b: PhrasingContent): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "strong":
    case "emphasis":
    case "delete":
      return true;
    case "link": {
      const al = a as Extract<PhrasingContent, { type: "link" }>;
      const bl = b as Extract<PhrasingContent, { type: "link" }>;
      return al.url === bl.url && al.title === bl.title;
    }
    default:
      return false;
  }
}

function cellToPhrasingContent(cell: Y.XmlElement): PhrasingContent[] {
  const chunks: PhrasingContent[][] = [];

  for (let i = 0; i < cell.length; i++) {
    const child = cell.get(i);
    if (child instanceof Y.XmlElement) {
      const chunk =
        child.nodeName === "paragraph"
          ? deltaToPhrasingContent(child)
          : plainTextToPhrasingContent(plainTextFromElement(child));
      if (isNonEmptyPhrasing(chunk)) chunks.push(chunk);
    } else if (child instanceof Y.XmlText) {
      const direct = deltaToPhrasingContent(cell);
      if (isNonEmptyPhrasing(direct)) chunks.push(direct);
      break;
    }
  }

  const result: PhrasingContent[] = [];
  chunks.forEach((chunk, index) => {
    if (index > 0) result.push({ type: "text", value: " " });
    result.push(...chunk);
  });
  return result;
}

function isNonEmptyPhrasing(nodes: PhrasingContent[]): boolean {
  return nodes.some((node) => phrasingPlainText(node).trim().length > 0);
}

function phrasingPlainText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    case "strong":
    case "emphasis":
    case "delete":
    case "link":
      return node.children.map(phrasingPlainText).join("");
    case "image":
      return node.alt ?? "";
    default:
      return "value" in node && typeof node.value === "string" ? node.value : "";
  }
}

function plainTextToPhrasingContent(text: string): PhrasingContent[] {
  return text.trim().length > 0 ? [{ type: "text", value: text }] : [];
}

function plainTextFromElement(element: Y.XmlElement): string {
  const parts: string[] = [];
  let hasPriorContent = false;

  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      parts.push(xmlTextToPlainText(child));
      hasPriorContent = true;
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === "hardBreak") {
        parts.push("\n");
        hasPriorContent = true;
      } else {
        if (hasPriorContent) parts.push("\n");
        parts.push(plainTextFromElement(child));
        hasPriorContent = true;
      }
    }
  }

  return parts.join("");
}

function xmlTextToPlainText(xmlText: Y.XmlText): string {
  let text = "";
  for (const op of xmlText.toDelta()) {
    text += typeof op.insert === "string" ? op.insert : "\n";
  }
  return text;
}
