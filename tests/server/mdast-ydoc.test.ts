import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { mdastToYDoc, yDocToMdast } from '../../src/server/file-io/mdast-ydoc.js';
import { getElementText } from '../../src/server/mcp/document.js';
import { getFragment } from '../helpers/ydoc-factory.js';
import type { Root } from 'mdast';

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

function makeMdast(children: any[]): Root {
  return { type: 'root', children };
}

function loadTree(tree: Root): Y.Doc {
  doc = new Y.Doc();
  mdastToYDoc(doc, tree);
  return doc;
}

describe('mdastToYDoc — block nodes', () => {
  it.each([1, 2, 3, 4, 5, 6])('heading depth %i', (depth) => {
    loadTree(makeMdast([{
      type: 'heading', depth, children: [{ type: 'text', value: 'Title' }],
    }]));
    const frag = getFragment(doc);
    expect(frag.length).toBe(1);
    const el = frag.get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('heading');
    expect(el.getAttribute('level')).toBe(depth);
    expect(getElementText(el)).toBe('Title');
  });

  it('paragraph', () => {
    loadTree(makeMdast([{
      type: 'paragraph', children: [{ type: 'text', value: 'Hello world' }],
    }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('paragraph');
    expect(getElementText(el)).toBe('Hello world');
  });

  it('blockquote with nested paragraph', () => {
    loadTree(makeMdast([{
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }],
    }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('blockquote');
    expect(el.length).toBe(1);
    const inner = el.get(0) as Y.XmlElement;
    expect(inner.nodeName).toBe('paragraph');
    expect(getElementText(inner)).toBe('quoted');
  });

  it('unordered list', () => {
    loadTree(makeMdast([{
      type: 'list', ordered: false,
      children: [
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'one' }] }] },
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'two' }] }] },
      ],
    }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('bulletList');
    expect(el.length).toBe(2);
    const item1 = el.get(0) as Y.XmlElement;
    expect(item1.nodeName).toBe('listItem');
    expect(getElementText(item1)).toBe('one');
  });

  it('ordered list with start', () => {
    loadTree(makeMdast([{
      type: 'list', ordered: true, start: 5,
      children: [
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'five' }] }] },
      ],
    }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('orderedList');
    expect(el.getAttribute('start')).toBe(5);
  });

  it('code block with language', () => {
    loadTree(makeMdast([{
      type: 'code', lang: 'javascript', value: 'const x = 1;\nconsole.log(x);',
    }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('codeBlock');
    expect(el.getAttribute('language')).toBe('javascript');
    expect(getElementText(el)).toBe('const x = 1;\nconsole.log(x);');
  });

  it('empty code block', () => {
    loadTree(makeMdast([{ type: 'code', lang: null, value: '' }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('codeBlock');
    expect(getElementText(el)).toBe('');
  });

  it('thematic break', () => {
    loadTree(makeMdast([{ type: 'thematicBreak' }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('horizontalRule');
  });

  it('image', () => {
    loadTree(makeMdast([{
      type: 'image', url: 'https://example.com/img.png', alt: 'photo', title: 'My photo',
    }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('image');
    expect(el.getAttribute('src')).toBe('https://example.com/img.png');
    expect(el.getAttribute('alt')).toBe('photo');
    expect(el.getAttribute('title')).toBe('My photo');
  });

  it('nested list (2 levels)', () => {
    loadTree(makeMdast([{
      type: 'list', ordered: false,
      children: [{
        type: 'listItem',
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: 'outer' }] },
          {
            type: 'list', ordered: false,
            children: [{
              type: 'listItem',
              children: [{ type: 'paragraph', children: [{ type: 'text', value: 'inner' }] }],
            }],
          },
        ],
      }],
    }]));
    const list = getFragment(doc).get(0) as Y.XmlElement;
    expect(list.nodeName).toBe('bulletList');
    const item = list.get(0) as Y.XmlElement;
    expect(item.nodeName).toBe('listItem');
    expect(item.length).toBe(2); // paragraph + nested bulletList
    const nested = item.get(1) as Y.XmlElement;
    expect(nested.nodeName).toBe('bulletList');
  });
});

describe('mdastToYDoc — inline marks', () => {
  function loadParagraphWithInline(children: any[]): Y.XmlText {
    loadTree(makeMdast([{ type: 'paragraph', children }]));
    const el = getFragment(doc).get(0) as Y.XmlElement;
    return el.get(0) as Y.XmlText;
  }

  it('bold text', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
    ]);
    const delta = xmlText.toDelta();
    expect(delta).toHaveLength(1);
    expect(delta[0].insert).toBe('bold');
    expect(delta[0].attributes?.bold).toEqual({});
  });

  it('italic text', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
    ]);
    const delta = xmlText.toDelta();
    expect(delta[0].attributes?.italic).toEqual({});
  });

  it('strikethrough text', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'delete', children: [{ type: 'text', value: 'deleted' }] },
    ]);
    const delta = xmlText.toDelta();
    expect(delta[0].attributes?.strike).toEqual({});
  });

  it('inline code', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'inlineCode', value: 'console.log' },
    ]);
    const delta = xmlText.toDelta();
    expect(delta[0].insert).toBe('console.log');
    expect(delta[0].attributes?.code).toEqual({});
  });

  it('link', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'link', url: 'https://example.com', title: 'Example', children: [{ type: 'text', value: 'click' }] },
    ]);
    const delta = xmlText.toDelta();
    expect(delta[0].insert).toBe('click');
    expect(delta[0].attributes?.link).toEqual({ href: 'https://example.com', title: 'Example' });
  });

  it('overlapping marks: bold-italic', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'strong', children: [
        { type: 'text', value: 'bold ' },
        { type: 'emphasis', children: [{ type: 'text', value: 'bold-italic' }] },
        { type: 'text', value: ' bold' },
      ] },
    ]);
    const delta = xmlText.toDelta();
    expect(delta).toHaveLength(3);

    // All three segments should have bold
    for (const op of delta) {
      expect(op.attributes?.bold).toEqual({});
    }

    // Verify all characters are present (Y.js may reorder segments internally)
    const fullText = delta.map((op: any) => op.insert).join('');
    expect(fullText.split('').sort().join('')).toBe('bold bold-italic bold'.split('').sort().join(''));

    // The bold-italic segment should have both marks
    const boldItalic = delta.find((op: any) => op.insert === 'bold-italic');
    expect(boldItalic?.attributes?.italic).toEqual({});

    // The bold-only segments should NOT have italic
    const boldOnly = delta.filter((op: any) => op.insert !== 'bold-italic');
    for (const op of boldOnly) {
      expect(op.attributes?.italic).toBeUndefined();
    }
  });

  it('hardBreak via insertEmbed', () => {
    const xmlText = loadParagraphWithInline([
      { type: 'text', value: 'before' },
      { type: 'break' },
      { type: 'text', value: 'after' },
    ]);
    const delta = xmlText.toDelta();
    // Should have 3 segments: two text and one embed
    expect(delta.length).toBe(3);

    const textSegments = delta.filter((op: any) => typeof op.insert === 'string');
    const embedSegments = delta.filter((op: any) => typeof op.insert !== 'string');

    expect(textSegments.map((op: any) => op.insert).sort()).toEqual(['after', 'before']);
    expect(embedSegments).toHaveLength(1);
    expect(embedSegments[0].insert).toBeInstanceOf(Y.XmlElement);
    expect((embedSegments[0].insert as Y.XmlElement).nodeName).toBe('hardBreak');
  });
});

describe('yDocToMdast — reverse conversion', () => {
  it('heading', () => {
    loadTree(makeMdast([{
      type: 'heading', depth: 2, children: [{ type: 'text', value: 'Title' }],
    }]));
    const tree = yDocToMdast(doc);
    expect(tree.children).toHaveLength(1);
    const h = tree.children[0] as any;
    expect(h.type).toBe('heading');
    expect(h.depth).toBe(2);
    expect(h.children[0].value).toBe('Title');
  });

  it('paragraph with bold', () => {
    loadTree(makeMdast([{
      type: 'paragraph',
      children: [
        { type: 'text', value: 'plain ' },
        { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      ],
    }]));
    const tree = yDocToMdast(doc);
    const p = tree.children[0] as any;
    expect(p.type).toBe('paragraph');
    // Should have plain text and bold text
    const texts = p.children;
    expect(texts.some((t: any) => t.type === 'text' && t.value === 'plain ')).toBe(true);
    expect(texts.some((t: any) => t.type === 'strong')).toBe(true);
  });

  it('code block', () => {
    loadTree(makeMdast([{
      type: 'code', lang: 'js', value: 'let x = 1;',
    }]));
    const tree = yDocToMdast(doc);
    const code = tree.children[0] as any;
    expect(code.type).toBe('code');
    expect(code.lang).toBe('js');
    expect(code.value).toBe('let x = 1;');
  });

  it('bulletList', () => {
    loadTree(makeMdast([{
      type: 'list', ordered: false,
      children: [
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a' }] }] },
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'b' }] }] },
      ],
    }]));
    const tree = yDocToMdast(doc);
    const list = tree.children[0] as any;
    expect(list.type).toBe('list');
    expect(list.ordered).toBe(false);
    expect(list.children).toHaveLength(2);
    expect(list.children[0].type).toBe('listItem');
  });

  it('orderedList with start', () => {
    loadTree(makeMdast([{
      type: 'list', ordered: true, start: 3,
      children: [
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'c' }] }] },
      ],
    }]));
    const tree = yDocToMdast(doc);
    const list = tree.children[0] as any;
    expect(list.type).toBe('list');
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
  });

  it('thematic break', () => {
    loadTree(makeMdast([{ type: 'thematicBreak' }]));
    const tree = yDocToMdast(doc);
    expect(tree.children[0].type).toBe('thematicBreak');
  });

  it('blockquote', () => {
    loadTree(makeMdast([{
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }],
    }]));
    const tree = yDocToMdast(doc);
    const bq = tree.children[0] as any;
    expect(bq.type).toBe('blockquote');
    expect(bq.children[0].type).toBe('paragraph');
  });

  it('empty document', () => {
    doc = new Y.Doc();
    const tree = yDocToMdast(doc);
    expect(tree.children).toHaveLength(0);
  });

  it('delta attribute hash suffix stripping', () => {
    // Manually create a Y.Doc with hash-suffixed attributes (as y-prosemirror does)
    doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const el = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    el.insert(0, [text]);
    text.insert(0, 'hashed');
    text.format(0, 6, { 'bold--abc123': {} });
    frag.insert(0, [el]);

    const tree = yDocToMdast(doc);
    const p = tree.children[0] as any;
    // Should recognize as bold despite the hash suffix
    expect(p.children.some((c: any) => c.type === 'strong')).toBe(true);
  });
});
