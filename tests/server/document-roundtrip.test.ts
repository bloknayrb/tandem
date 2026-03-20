import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import {
  populateYDoc,
  extractText,
  getElementText,
  getHeadingPrefixLength,
} from '../../src/server/mcp/document.js';
import { makeDoc, makeEmptyDoc, getFragment } from '../helpers/ydoc-factory.js';

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe('populateYDoc', () => {
  it('creates paragraph elements for plain text lines', () => {
    doc = makeDoc('hello\nworld');
    const frag = getFragment(doc);
    expect(frag.length).toBe(2);
    const first = frag.get(0) as Y.XmlElement;
    const second = frag.get(1) as Y.XmlElement;
    expect(first.nodeName).toBe('paragraph');
    expect(getElementText(first)).toBe('hello');
    expect(second.nodeName).toBe('paragraph');
    expect(getElementText(second)).toBe('world');
  });

  it.each([
    ['# ', 1],
    ['## ', 2],
    ['### ', 3],
  ])('creates heading for %s prefix with correct level attribute', (prefix, level) => {
    doc = makeDoc(`${prefix}Title`);
    const frag = getFragment(doc);
    expect(frag.length).toBe(1);
    const el = frag.get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('heading');
    expect(el.getAttribute('level')).toBe(level);
    expect(getElementText(el)).toBe('Title');
  });

  it('preserves blank lines: "a\\n\\nb" produces three elements', () => {
    doc = makeDoc('a\n\nb');
    const frag = getFragment(doc);
    expect(frag.length).toBe(3);
    expect(getElementText(frag.get(1) as Y.XmlElement)).toBe('');
    expect(extractText(doc)).toBe('a\n\nb');
  });

  it('string of only blank lines produces empty paragraph elements', () => {
    doc = makeDoc('\n\n\n');
    const frag = getFragment(doc);
    // '\n\n\n'.split('\n') = ['', '', '', ''] → 4 empty paragraphs
    expect(frag.length).toBe(4);
    for (let i = 0; i < frag.length; i++) {
      expect(getElementText(frag.get(i) as Y.XmlElement)).toBe('');
    }
  });

  it('treats "#" without space as a paragraph', () => {
    doc = makeDoc('#NotAHeading');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('paragraph');
    expect(getElementText(el)).toBe('#NotAHeading');
  });

  it('treats "##Heading" (no space) as a paragraph', () => {
    doc = makeDoc('##NoSpace');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(el.nodeName).toBe('paragraph');
    expect(getElementText(el)).toBe('##NoSpace');
  });

  it('calling twice replaces content, does not append', () => {
    doc = new Y.Doc();
    populateYDoc(doc, 'first content');
    expect(getFragment(doc).length).toBe(1);
    populateYDoc(doc, 'second\nthird');
    const frag = getFragment(doc);
    expect(frag.length).toBe(2);
    expect(getElementText(frag.get(0) as Y.XmlElement)).toBe('second');
    expect(getElementText(frag.get(1) as Y.XmlElement)).toBe('third');
  });

  it('empty string produces empty fragment', () => {
    doc = makeDoc('');
    expect(getFragment(doc).length).toBe(0);
  });
});

describe('extractText', () => {
  it('returns empty string for a never-populated doc', () => {
    doc = makeEmptyDoc();
    expect(extractText(doc)).toBe('');
  });

  it('returns empty string for a doc populated with empty string', () => {
    doc = makeDoc('');
    expect(extractText(doc)).toBe('');
  });

  it('returns text for a single paragraph', () => {
    doc = makeDoc('just a paragraph');
    expect(extractText(doc)).toBe('just a paragraph');
  });

  it('returns markdown heading format for a single heading', () => {
    doc = makeDoc('## Section');
    expect(extractText(doc)).toBe('## Section');
  });

  it('joins multiple elements with newline', () => {
    doc = makeDoc('# Title\nParagraph one\nParagraph two');
    expect(extractText(doc)).toBe('# Title\nParagraph one\nParagraph two');
  });
});

describe('round-trip: populateYDoc -> extractText', () => {
  it('plain paragraphs', () => {
    const input = 'first line\nsecond line\nthird line';
    doc = makeDoc(input);
    expect(extractText(doc)).toBe(input);
  });

  it.each([
    ['# Heading One'],
    ['## Heading Two'],
    ['### Heading Three'],
  ])('heading round-trip: %s', (input) => {
    doc = makeDoc(input);
    expect(extractText(doc)).toBe(input);
  });

  it('mixed headings and paragraphs', () => {
    const input = '# Title\n## Section\nParagraph text\n### Sub\nMore text';
    doc = makeDoc(input);
    expect(extractText(doc)).toBe(input);
  });

  it('unicode: emoji and CJK characters', () => {
    const input = 'Hello 🎉\n你好世界\n## 标题';
    doc = makeDoc(input);
    expect(extractText(doc)).toBe(input);
  });

  it('very long line (1000+ chars)', () => {
    const longLine = 'x'.repeat(1200);
    doc = makeDoc(longLine);
    expect(extractText(doc)).toBe(longLine);
  });

  it('document with only headings', () => {
    const input = '# H1\n## H2\n### H3';
    doc = makeDoc(input);
    expect(extractText(doc)).toBe(input);
  });

  it('preserves leading/trailing whitespace within lines', () => {
    const input = '  indented paragraph\ntrailing spaces   \n## Heading with space ';
    doc = makeDoc(input);
    expect(extractText(doc)).toBe(input);
  });
});

describe('getHeadingPrefixLength', () => {
  it.each([
    ['# ', 1, 2],
    ['## ', 2, 3],
    ['### ', 3, 4],
  ])('level %i heading (prefix "%s") returns %i', (_prefix, level, expected) => {
    // Y.XmlElement attributes only work inside a Y.Doc
    const testDoc = new Y.Doc();
    const frag = testDoc.getXmlFragment('default');
    const el = new Y.XmlElement('heading');
    el.setAttribute('level', level);
    frag.insert(0, [el]);
    expect(getHeadingPrefixLength(el)).toBe(expected);
    testDoc.destroy();
  });

  it('paragraph element returns 0', () => {
    // Use a doc-attached element
    doc = makeDoc('just text');
    const el = getFragment(doc).get(0) as Y.XmlElement;
    expect(getHeadingPrefixLength(el)).toBe(0);
  });
});
