import * as Y from 'yjs';
import type { Root, RootContent, PhrasingContent } from 'mdast';

/**
 * Convert an MDAST tree into Y.Doc XmlFragment elements.
 * Block nodes become Y.XmlElements with Tiptap-compatible nodeNames.
 * Inline content becomes formatted Y.XmlText within those elements.
 */
export function mdastToYDoc(doc: Y.Doc, tree: Root): void {
  const fragment = doc.getXmlFragment('default');

  // Clear existing content in a single operation
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  const allElements: Y.XmlElement[] = [];
  for (const node of tree.children) {
    allElements.push(...blockToYxml(node));
  }
  if (allElements.length > 0) {
    fragment.insert(0, allElements);
  }
}

/** Convert a block-level MDAST node to one or more Y.XmlElements */
function blockToYxml(node: RootContent): Y.XmlElement[] {
  switch (node.type) {
    case 'heading': {
      const el = new Y.XmlElement('heading');
      el.setAttribute('level', node.depth as any);
      const text = new Y.XmlText();
      el.insert(0, [text]);
      processInline(text, node.children, {});
      return [el];
    }

    case 'paragraph': {
      const el = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      el.insert(0, [text]);
      processInline(text, node.children, {});
      return [el];
    }

    case 'blockquote': {
      const el = new Y.XmlElement('blockquote');
      for (const child of node.children) {
        const childEls = blockToYxml(child);
        for (const c of childEls) {
          el.insert(el.length, [c]);
        }
      }
      return [el];
    }

    case 'list': {
      const nodeName = node.ordered ? 'orderedList' : 'bulletList';
      const el = new Y.XmlElement(nodeName);
      if (node.ordered && node.start != null && node.start !== 1) {
        el.setAttribute('start', node.start as any);
      }
      for (const item of node.children) {
        const listItem = new Y.XmlElement('listItem');
        for (const child of item.children) {
          const childEls = blockToYxml(child);
          for (const c of childEls) {
            listItem.insert(listItem.length, [c]);
          }
        }
        el.insert(el.length, [listItem]);
      }
      return [el];
    }

    case 'code': {
      const el = new Y.XmlElement('codeBlock');
      if (node.lang) {
        el.setAttribute('language', node.lang);
      }
      const text = new Y.XmlText(node.value);
      el.insert(0, [text]);
      return [el];
    }

    case 'thematicBreak': {
      return [new Y.XmlElement('horizontalRule')];
    }

    case 'image': {
      const el = new Y.XmlElement('image');
      el.setAttribute('src', node.url);
      if (node.alt) el.setAttribute('alt', node.alt);
      if (node.title) el.setAttribute('title', node.title);
      return [el];
    }

    // html blocks, definitions, etc. — wrap as paragraphs to avoid data loss
    default: {
      if ('value' in node && typeof node.value === 'string') {
        const el = new Y.XmlElement('paragraph');
        const text = new Y.XmlText(node.value);
        el.insert(0, [text]);
        return [el];
      }
      return [];
    }
  }
}

/**
 * Process inline/phrasing MDAST nodes into a single Y.XmlText with marks.
 * Tracks a mark stack during recursion so nested marks compose correctly.
 */
function processInline(
  xmlText: Y.XmlText,
  nodes: PhrasingContent[],
  marks: Record<string, object>,
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const offset = xmlText.length;
        xmlText.insert(offset, node.value);
        for (const [name, attrs] of Object.entries(marks)) {
          xmlText.format(offset, node.value.length, { [name]: attrs });
        }
        break;
      }

      case 'strong':
        processInline(xmlText, node.children, { ...marks, bold: {} });
        break;

      case 'emphasis':
        processInline(xmlText, node.children, { ...marks, italic: {} });
        break;

      case 'delete':
        processInline(xmlText, node.children, { ...marks, strike: {} });
        break;

      case 'inlineCode': {
        const offset = xmlText.length;
        xmlText.insert(offset, node.value);
        for (const [name, attrs] of Object.entries({ ...marks, code: {} })) {
          xmlText.format(offset, node.value.length, { [name]: attrs });
        }
        break;
      }

      case 'link':
        processInline(xmlText, node.children, {
          ...marks,
          link: { href: node.url, ...(node.title ? { title: node.title } : {}) },
        });
        break;

      case 'break': {
        const embed = new Y.XmlElement('hardBreak');
        xmlText.insertEmbed(xmlText.length, embed);
        break;
      }

      case 'image': {
        // Inline images: insert alt text with a mark (best-effort)
        const offset = xmlText.length;
        const alt = node.alt || node.url;
        xmlText.insert(offset, alt);
        break;
      }

      // html inline, footnoteReference, etc. — insert raw value if available
      default:
        if ('value' in node && typeof node.value === 'string') {
          const offset = xmlText.length;
          xmlText.insert(offset, node.value);
          for (const [name, attrs] of Object.entries(marks)) {
            xmlText.format(offset, node.value.length, { [name]: attrs });
          }
        }
        break;
    }
  }
}

/**
 * Convert a Y.Doc's XmlFragment back to an MDAST Root tree.
 */
export function yDocToMdast(doc: Y.Doc): Root {
  const fragment = doc.getXmlFragment('default');
  const children: RootContent[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const mdastNode = yxmlToMdast(node);
      if (mdastNode) children.push(mdastNode);
    }
  }

  return { type: 'root', children };
}

/** Convert a Y.XmlElement back to an MDAST block node */
function yxmlToMdast(el: Y.XmlElement): RootContent | null {
  switch (el.nodeName) {
    case 'heading': {
      const depth = (Number(el.getAttribute('level') ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: 'heading', depth, children: deltaToPhrasingContent(el) };
    }

    case 'paragraph':
      return { type: 'paragraph', children: deltaToPhrasingContent(el) };

    case 'blockquote': {
      const children: RootContent[] = [];
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlElement) {
          const m = yxmlToMdast(child);
          if (m) children.push(m);
        }
      }
      // blockquote.children is BlockContent[] but RootContent covers it
      return { type: 'blockquote', children: children as any };
    }

    case 'bulletList':
    case 'orderedList': {
      const ordered = el.nodeName === 'orderedList';
      const start = ordered ? (Number(el.getAttribute('start')) || 1) : undefined;
      const listItems: any[] = [];
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlElement && child.nodeName === 'listItem') {
          const itemChildren: any[] = [];
          for (let j = 0; j < child.length; j++) {
            const grandchild = child.get(j);
            if (grandchild instanceof Y.XmlElement) {
              const m = yxmlToMdast(grandchild);
              if (m) itemChildren.push(m);
            }
          }
          listItems.push({ type: 'listItem', children: itemChildren });
        }
      }
      return {
        type: 'list',
        ordered,
        ...(ordered && start !== 1 ? { start } : {}),
        children: listItems,
      } as any;
    }

    case 'codeBlock': {
      const lang = el.getAttribute('language') as string | undefined;
      let value = '';
      for (let i = 0; i < el.length; i++) {
        const child = el.get(i);
        if (child instanceof Y.XmlText) {
          value += child.toString();
        }
      }
      return { type: 'code', lang: lang || null, value } as any;
    }

    case 'horizontalRule':
      return { type: 'thematicBreak' };

    case 'image': {
      return {
        type: 'image',
        url: (el.getAttribute('src') as string) || '',
        alt: (el.getAttribute('alt') as string) || undefined,
        title: (el.getAttribute('title') as string) || null,
      } as any;
    }

    // Unknown node types — try to extract text content as a paragraph
    default: {
      const phrasing = deltaToPhrasingContent(el);
      if (phrasing.length > 0) {
        return { type: 'paragraph', children: phrasing };
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
  const dashIdx = key.indexOf('--');
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
        if (typeof op.insert !== 'string') {
          if (op.insert instanceof Y.XmlElement && op.insert.nodeName === 'hardBreak') {
            result.push({ type: 'break' });
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
        let node: PhrasingContent = { type: 'text', value: text };

        // link wraps first (innermost), then code, then strike, then italic, then bold
        if (marks.has('link')) {
          const linkAttrs = marks.get('link') || {};
          node = {
            type: 'link',
            url: linkAttrs.href || '',
            ...(linkAttrs.title ? { title: linkAttrs.title } : {}),
            children: [node],
          };
        }
        if (marks.has('code')) {
          // Code is a leaf node — extract text value
          node = { type: 'inlineCode', value: text };
        }
        if (marks.has('strike')) {
          if (node.type === 'inlineCode') {
            // Can't nest inlineCode inside delete — best effort
            node = { type: 'delete', children: [{ type: 'text', value: text }] } as any;
          } else {
            node = { type: 'delete', children: [node] } as any;
          }
        }
        if (marks.has('italic')) {
          if (node.type === 'inlineCode') {
            node = { type: 'emphasis', children: [{ type: 'text', value: text }] };
          } else {
            node = { type: 'emphasis', children: [node] };
          }
        }
        if (marks.has('bold')) {
          if (node.type === 'inlineCode') {
            node = { type: 'strong', children: [{ type: 'text', value: text }] };
          } else {
            node = { type: 'strong', children: [node] };
          }
        }

        result.push(node);
      }
    } else if (child instanceof Y.XmlElement) {
      // Non-text child elements embedded in a block (shouldn't happen often)
      if (child.nodeName === 'hardBreak') {
        result.push({ type: 'break' });
      }
    }
  }

  return result;
}
