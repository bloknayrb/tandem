// .docx review-only mode: mammoth.js → HTML → Y.Doc
// Editing disabled; annotations persist via session system

import mammoth from 'mammoth';
import * as htmlparser2 from 'htmlparser2';
import type { Document, Element, Text, ChildNode } from 'domhandler';
import * as Y from 'yjs';
import type { Annotation } from '../../shared/types.js';
import { getElementText } from '../mcp/document.js';

/**
 * Convert a .docx file to HTML via mammoth.js.
 * Warnings logged to stderr (stdout reserved for MCP).
 */
export async function loadDocx(filePath: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: filePath });

  for (const msg of result.messages) {
    console.error(`[mammoth] ${msg.type}: ${msg.message}`);
  }

  return result.value;
}

// -- HTML → Y.Doc conversion --

/** All marks that can appear on inline text (superset of mdast-ydoc) */
const ALL_MARKS = ['bold', 'italic', 'strike', 'code', 'link', 'underline', 'superscript', 'subscript'] as const;

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
  a: (el) => ({
    link: { href: el.attribs.href || '' },
  }),
};

/** Tags that represent block-level elements */
const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'blockquote',
  'table', 'tr', 'td', 'th',
  'pre', 'img', 'hr', 'br', 'div',
]);

type DeferredText = { xmlText: Y.XmlText; children: ChildNode[]; marks: Record<string, object> };

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
  return node.type === 'tag';
}

function isText(node: ChildNode): node is Text {
  return node.type === 'text';
}

/**
 * Convert parsed HTML into Y.Doc XmlFragment elements.
 * Two-pass pattern per ADR-009: build element tree first, then populate text.
 */
export function htmlToYDoc(doc: Y.Doc, html: string): void {
  const fragment = doc.getXmlFragment('default');

  // Clear existing content
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  if (!html.trim()) return;

  const parsed = htmlparser2.parseDocument(html);
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

  // Pass 2: populate text now that elements are attached to Y.Doc
  for (const { xmlText, children, marks } of deferred) {
    processInlineNodes(xmlText, children, marks);
  }
}

/** Convert a DOM node to Y.XmlElement(s). Inline-only containers become paragraphs. */
function domNodeToYxml(node: ChildNode, deferred: DeferredText[]): Y.XmlElement[] {
  if (isText(node)) {
    // Top-level text node — wrap in paragraph
    const text = node.data;
    if (!text.trim()) return [];
    const el = new Y.XmlElement('paragraph');
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
    const el = new Y.XmlElement('heading');
    el.setAttribute('level', parseInt(headingMatch[1]) as any);
    const xmlText = new Y.XmlText();
    el.insert(0, [xmlText]);
    deferred.push({ xmlText, children: node.children, marks: {} });
    return [el];
  }

  switch (tag) {
    case 'p': {
      const el = new Y.XmlElement('paragraph');
      const xmlText = new Y.XmlText();
      el.insert(0, [xmlText]);
      deferred.push({ xmlText, children: node.children, marks: {} });
      return [el];
    }

    case 'blockquote': {
      const el = new Y.XmlElement('blockquote');
      const blockChildren = collectBlockChildren(node.children, deferred);
      for (const child of blockChildren) {
        el.insert(el.length, [child]);
      }
      return [el];
    }

    case 'ul': {
      const el = new Y.XmlElement('bulletList');
      for (const child of node.children) {
        if (isElement(child) && child.tagName.toLowerCase() === 'li') {
          el.insert(el.length, [buildListItem(child, deferred)]);
        }
      }
      return [el];
    }

    case 'ol': {
      const el = new Y.XmlElement('orderedList');
      const start = parseInt(node.attribs.start || '1');
      if (start !== 1) {
        el.setAttribute('start', start as any);
      }
      for (const child of node.children) {
        if (isElement(child) && child.tagName.toLowerCase() === 'li') {
          el.insert(el.length, [buildListItem(child, deferred)]);
        }
      }
      return [el];
    }

    case 'table': {
      const el = new Y.XmlElement('table');
      // Walk tbody/thead/tfoot or direct tr children
      const rows = collectTableRows(node);
      for (const row of rows) {
        el.insert(el.length, [buildTableRow(row, deferred)]);
      }
      return [el];
    }

    case 'pre': {
      const el = new Y.XmlElement('codeBlock');
      const xmlText = new Y.XmlText();
      el.insert(0, [xmlText]);
      // Collect all text content from pre (which may contain a <code> child)
      deferred.push({ xmlText, children: node.children, marks: {} });
      return [el];
    }

    case 'img': {
      const el = new Y.XmlElement('image');
      el.setAttribute('src', node.attribs.src || '');
      if (node.attribs.alt) el.setAttribute('alt', node.attribs.alt);
      if (node.attribs.title) el.setAttribute('title', node.attribs.title);
      return [el];
    }

    case 'hr': {
      return [new Y.XmlElement('horizontalRule')];
    }

    case 'br': {
      // Top-level <br> — produce an empty paragraph
      const el = new Y.XmlElement('paragraph');
      el.insert(0, [new Y.XmlText('')]);
      return [el];
    }

    case 'div': {
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
      const el = new Y.XmlElement('paragraph');
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
    const hasContent = inlineBuffer.some(n =>
      isText(n) ? n.data.trim().length > 0 : true,
    );
    if (hasContent) {
      const el = new Y.XmlElement('paragraph');
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
    const el = new Y.XmlElement('paragraph');
    el.insert(0, [new Y.XmlText('')]);
    result.push(el);
  }

  return result;
}

/** Build a listItem Y.XmlElement from an <li> DOM node */
function buildListItem(li: Element, deferred: DeferredText[]): Y.XmlElement {
  const listItem = new Y.XmlElement('listItem');
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
    if (tag === 'tr') {
      rows.push(child);
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const grandchild of child.children) {
        if (isElement(grandchild) && grandchild.tagName.toLowerCase() === 'tr') {
          rows.push(grandchild);
        }
      }
    }
  }
  return rows;
}

/** Build a tableRow Y.XmlElement from a <tr> */
function buildTableRow(tr: Element, deferred: DeferredText[]): Y.XmlElement {
  const row = new Y.XmlElement('tableRow');
  for (const child of tr.children) {
    if (!isElement(child)) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'td' || tag === 'th') {
      const nodeName = tag === 'th' ? 'tableHeader' : 'tableCell';
      const cell = new Y.XmlElement(nodeName);

      // Copy colspan/rowspan
      if (child.attribs.colspan && child.attribs.colspan !== '1') {
        cell.setAttribute('colspan', parseInt(child.attribs.colspan) as any);
      }
      if (child.attribs.rowspan && child.attribs.rowspan !== '1') {
        cell.setAttribute('rowspan', parseInt(child.attribs.rowspan) as any);
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
    if (tag === 'br') {
      const embed = new Y.XmlElement('hardBreak');
      xmlText.insertEmbed(xmlText.length, embed);
      continue;
    }

    // Inline mark tag?
    const markFactory = INLINE_MARK_TAGS[tag];
    if (markFactory) {
      const newMarks = { ...marks, ...markFactory(node) };
      processInlineNodes(xmlText, node.children, newMarks);
      continue;
    }

    // Code element inside pre — just extract text
    if (tag === 'code') {
      processInlineNodes(xmlText, node.children, marks);
      continue;
    }

    // Unknown inline element — recurse (best effort)
    processInlineNodes(xmlText, node.children, marks);
  }
}

// -- Annotation export --

/**
 * Generate a Markdown summary of all annotations, grouped by type.
 * Includes a text snippet from the document for context.
 */
export function exportAnnotations(doc: Y.Doc, annotations: Annotation[]): string {
  if (annotations.length === 0) {
    return '# Document Review\n\nNo annotations found.';
  }

  const fragment = doc.getXmlFragment('default');
  const fullText = extractFullText(fragment);

  const groups: Record<string, Annotation[]> = {};
  for (const ann of annotations) {
    const key = ann.type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(ann);
  }

  const lines: string[] = ['# Document Review', ''];

  const typeLabels: Record<string, string> = {
    highlight: 'Highlights',
    comment: 'Comments',
    suggestion: 'Suggestions',
    overlay: 'Overlays',
  };

  for (const [type, anns] of Object.entries(groups)) {
    lines.push(`## ${typeLabels[type] || type}`, '');

    for (const ann of anns) {
      const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
      const truncated = snippet.length > 80 ? snippet.slice(0, 77) + '...' : snippet;

      lines.push(`- **"${truncated}"** (${ann.author})`);

      if (ann.type === 'suggestion') {
        try {
          const { newText, reason } = JSON.parse(ann.content);
          lines.push(`  - Replace with: "${newText}"`);
          if (reason) lines.push(`  - Reason: ${reason}`);
        } catch {
          lines.push(`  - ${ann.content}`);
        }
      } else if (ann.content) {
        lines.push(`  - ${ann.content}`);
      }

      if (ann.color) {
        lines.push(`  - Color: ${ann.color}`);
      }

      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

/** Extract full flat text from a Y.Doc fragment (simplified — no heading prefixes) */
function extractFullText(fragment: Y.XmlFragment): string {
  const parts: string[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      parts.push(getElementText(node));
    }
  }
  return parts.join('\n');
}

/** Safe string slice that handles out-of-bounds gracefully */
function safeSlice(text: string, from: number, to: number): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  return text.slice(start, end);
}
