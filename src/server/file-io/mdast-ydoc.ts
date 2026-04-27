import type { PhrasingContent, Root, RootContent } from "mdast";
import * as Y from "yjs";
import { NODE_NAMES } from "../mcp/document-model.js";

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
      const el = new Y.XmlElement(NODE_NAMES.HEADING);
      el.setAttribute("level", node.depth as any);
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, nodes: node.children });
      return [el];
    }

    case "paragraph": {
      const el = new Y.XmlElement(NODE_NAMES.PARAGRAPH);
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, nodes: node.children });
      return [el];
    }

    case "blockquote": {
      const el = new Y.XmlElement(NODE_NAMES.BLOCKQUOTE);
      for (const child of node.children) {
        const childEls = blockToYxml(child, deferred);
        for (const c of childEls) {
          el.insert(el.length, [c]);
        }
      }
      return [el];
    }

    case "list": {
      const nodeName = node.ordered ? NODE_NAMES.ORDERED_LIST : NODE_NAMES.BULLET_LIST;
      const el = new Y.XmlElement(nodeName);
      if (node.ordered && node.start != null && node.start !== 1) {
        el.setAttribute("start", node.start as any);
      }
      for (const item of node.children) {
        const listItem = new Y.XmlElement(NODE_NAMES.LIST_ITEM);
        for (const child of item.children) {
          const childEls = blockToYxml(child, deferred);
          for (const c of childEls) {
            listItem.insert(listItem.length, [c]);
          }
        }
        el.insert(el.length, [listItem]);
      }
      return [el];
    }

    case "code": {
      const el = new Y.XmlElement(NODE_NAMES.CODE_BLOCK);
      if (node.lang) {
        el.setAttribute("language", node.lang);
      }
      const text = new Y.XmlText();
      el.insert(0, [text]);
      deferred.push({ xmlText: text, plainText: node.value });
      return [el];
    }

    case "thematicBreak": {
      return [new Y.XmlElement(NODE_NAMES.HORIZONTAL_RULE)];
    }

    case "image": {
      const el = new Y.XmlElement(NODE_NAMES.IMAGE);
      el.setAttribute("src", node.url);
      if (node.alt) el.setAttribute("alt", node.alt);
      if (node.title) el.setAttribute("title", node.title);
      return [el];
    }

    // html blocks, definitions, etc. — wrap as paragraphs to avoid data loss
    default: {
      if ("value" in node && typeof node.value === "string") {
        const el = new Y.XmlElement(NODE_NAMES.PARAGRAPH);
        const text = new Y.XmlText();
        el.insert(0, [text]);
        deferred.push({ xmlText: text, plainText: node.value });
        return [el];
      }
      return [];
    }
  }
}

/** All mark names that can appear on inline text */
const ALL_MARKS = ["bold", "italic", "strike", "code", "link"] as const;

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
        const embed = new Y.XmlElement(NODE_NAMES.HARD_BREAK);
        xmlText.insertEmbed(xmlText.length, embed);
        break;
      }

      case "image": {
        // Inline images: insert alt text (best-effort)
        xmlText.insert(xmlText.length, node.alt || node.url, buildAttrs(marks));
        break;
      }

      // html inline, footnoteReference, etc. — insert raw value if available
      default:
        if ("value" in node && typeof node.value === "string") {
          xmlText.insert(xmlText.length, node.value, buildAttrs(marks));
        }
        break;
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
    case NODE_NAMES.HEADING: {
      const depth = Number(el.getAttribute("level") ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: "heading", depth, children: deltaToPhrasingContent(el) };
    }

    case NODE_NAMES.PARAGRAPH:
      return { type: "paragraph", children: deltaToPhrasingContent(el) };

    case NODE_NAMES.BLOCKQUOTE: {
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

    case NODE_NAMES.BULLET_LIST:
    case NODE_NAMES.ORDERED_LIST: {
      const ordered = el.nodeName === NODE_NAMES.ORDERED_LIST;
      const start = ordered ? Number(el.getAttribute("start")) || 1 : undefined;
      const listItems: any[] = [];
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlElement && child.nodeName === NODE_NAMES.LIST_ITEM) {
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

    case NODE_NAMES.CODE_BLOCK: {
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

    case NODE_NAMES.HORIZONTAL_RULE:
      return { type: "thematicBreak" };

    case NODE_NAMES.IMAGE: {
      return {
        type: "image",
        url: (el.getAttribute("src") as string) || "",
        alt: (el.getAttribute("alt") as string) || undefined,
        title: (el.getAttribute("title") as string) || null,
      } as any;
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
          if (op.insert instanceof Y.XmlElement && op.insert.nodeName === NODE_NAMES.HARD_BREAK) {
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

        // Build phrasing node, wrapping with marks from inside out
        let node: PhrasingContent = { type: "text", value: text };

        // link wraps first (innermost), then code, then strike, then italic, then bold
        if (marks.has("link")) {
          const linkAttrs = marks.get("link") || {};
          node = {
            type: "link",
            url: linkAttrs.href || "",
            ...(linkAttrs.title ? { title: linkAttrs.title } : {}),
            children: [node],
          };
        }
        if (marks.has("code")) {
          // Code is a leaf node — extract text value
          node = { type: "inlineCode", value: text };
        }
        if (marks.has("strike")) {
          if (node.type === "inlineCode") {
            // Can't nest inlineCode inside delete — best effort
            node = { type: "delete", children: [{ type: "text", value: text }] } as any;
          } else {
            node = { type: "delete", children: [node] } as any;
          }
        }
        if (marks.has("italic")) {
          if (node.type === "inlineCode") {
            node = { type: "emphasis", children: [{ type: "text", value: text }] };
          } else {
            node = { type: "emphasis", children: [node] };
          }
        }
        if (marks.has("bold")) {
          if (node.type === "inlineCode") {
            node = { type: "strong", children: [{ type: "text", value: text }] };
          } else {
            node = { type: "strong", children: [node] };
          }
        }

        result.push(node);
      }
    } else if (child instanceof Y.XmlElement) {
      // Non-text child elements embedded in a block (shouldn't happen often)
      if (child.nodeName === NODE_NAMES.HARD_BREAK) {
        result.push({ type: "break" });
      }
    }
  }

  return result;
}
