import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { generateId, createAnnotation, collectAnnotations } from '../../src/server/mcp/annotations.js';
import { makeDoc, getAnnotationsMap } from '../helpers/ydoc-factory.js';
import type { Annotation } from '../../src/shared/types.js';

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe('generateId', () => {
  it('matches expected format', () => {
    const id = generateId();
    expect(id).toMatch(/^ann_\d+_[a-z0-9]+$/);
  });

  it('successive calls produce different IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
  });
});

describe('createAnnotation', () => {
  it('stores annotation with correct default fields', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'comment', 0, 4, 'nice text');

    const stored = map.get(id) as Annotation;
    expect(stored.id).toBe(id);
    expect(stored.author).toBe('claude');
    expect(stored.type).toBe('comment');
    expect(stored.range).toEqual({ from: 0, to: 4 });
    expect(stored.content).toBe('nice text');
    expect(stored.status).toBe('pending');
    expect(stored.timestamp).toBeTypeOf('number');
  });

  it('extras override defaults', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'highlight', 0, 4, '', { color: 'red' });

    const stored = map.get(id) as Annotation;
    expect(stored.color).toBe('red');
  });
});

describe('collectAnnotations', () => {
  it('returns empty array for empty map', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    expect(collectAnnotations(map)).toEqual([]);
  });

  it('returns all stored annotations', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    createAnnotation(map, 'comment', 0, 2, 'first');
    createAnnotation(map, 'highlight', 2, 4, 'second');

    const all = collectAnnotations(map);
    expect(all).toHaveLength(2);
  });

  it('returns annotations of different types', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    createAnnotation(map, 'comment', 0, 2, 'c');
    createAnnotation(map, 'highlight', 0, 2, 'h');
    createAnnotation(map, 'suggestion', 0, 2, '{}');

    const types = collectAnnotations(map).map(a => a.type);
    expect(types).toContain('comment');
    expect(types).toContain('highlight');
    expect(types).toContain('suggestion');
  });
});

describe('filter logic', () => {
  function setupAnnotations() {
    doc = makeDoc('test content here');
    const map = getAnnotationsMap(doc);
    createAnnotation(map, 'comment', 0, 4, 'a comment');
    createAnnotation(map, 'highlight', 0, 4, '', { color: 'yellow' });
    createAnnotation(map, 'suggestion', 5, 12, JSON.stringify({ newText: 'stuff', reason: 'clarity' }));
    return map;
  }

  it('filters by type', () => {
    const map = setupAnnotations();
    const comments = collectAnnotations(map).filter(a => a.type === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('a comment');
  });

  it('filters by status', () => {
    const map = setupAnnotations();
    const pending = collectAnnotations(map).filter(a => a.status === 'pending');
    expect(pending).toHaveLength(3);
  });

  it('filters by author', () => {
    const map = setupAnnotations();
    const claude = collectAnnotations(map).filter(a => a.author === 'claude');
    expect(claude).toHaveLength(3);
    const user = collectAnnotations(map).filter(a => a.author === 'user');
    expect(user).toHaveLength(0);
  });

  it('compound filter: author + type', () => {
    const map = setupAnnotations();
    const result = collectAnnotations(map)
      .filter(a => a.author === 'claude')
      .filter(a => a.type === 'suggestion');
    expect(result).toHaveLength(1);
  });
});

describe('suggestion JSON contract', () => {
  it('suggestion content is parseable JSON with newText and reason', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'suggestion', 0, 4,
      JSON.stringify({ newText: 'replacement', reason: 'better wording' }));

    const stored = map.get(id) as Annotation;
    const parsed = JSON.parse(stored.content);
    expect(parsed.newText).toBe('replacement');
    expect(parsed.reason).toBe('better wording');
  });

  it('suggestion with empty reason', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'suggestion', 0, 4,
      JSON.stringify({ newText: 'x', reason: '' }));

    const stored = map.get(id) as Annotation;
    const parsed = JSON.parse(stored.content);
    expect(parsed.reason).toBe('');
  });
});

describe('resolve and remove', () => {
  it('resolve changes status to accepted', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'comment', 0, 4, 'text');

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: 'accepted' as const });

    const updated = map.get(id) as Annotation;
    expect(updated.status).toBe('accepted');
  });

  it('resolve changes status to dismissed', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'comment', 0, 4, 'text');

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: 'dismissed' as const });

    const updated = map.get(id) as Annotation;
    expect(updated.status).toBe('dismissed');
  });

  it('remove deletes from map', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, 'comment', 0, 4, 'text');
    expect(map.has(id)).toBe(true);

    map.delete(id);
    expect(map.has(id)).toBe(false);
  });

  it('get nonexistent ID returns undefined', () => {
    doc = makeDoc('test');
    const map = getAnnotationsMap(doc);
    expect(map.get('ann_fake_id')).toBeUndefined();
  });
});
