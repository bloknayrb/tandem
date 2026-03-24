import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getOrCreateDocument, getDocument, removeDocument } from '../../src/server/yjs/provider.js';

describe('Y.Doc lifecycle (provider)', () => {
  it('getOrCreateDocument creates a new doc if none exists', () => {
    const doc = getOrCreateDocument('test-provider-create');
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(getDocument('test-provider-create')).toBe(doc);
  });

  it('getOrCreateDocument returns existing doc', () => {
    const doc1 = getOrCreateDocument('test-provider-idempotent');
    const doc2 = getOrCreateDocument('test-provider-idempotent');
    expect(doc1).toBe(doc2);
  });

  it('removeDocument clears the map entry', () => {
    getOrCreateDocument('test-provider-remove');
    expect(getDocument('test-provider-remove')).toBeDefined();
    const removed = removeDocument('test-provider-remove');
    expect(removed).toBe(true);
    expect(getDocument('test-provider-remove')).toBeUndefined();
  });

  it('getOrCreateDocument creates fresh doc after removeDocument', () => {
    const doc1 = getOrCreateDocument('test-provider-recycle');
    removeDocument('test-provider-recycle');
    const doc2 = getOrCreateDocument('test-provider-recycle');
    expect(doc2).not.toBe(doc1);
    expect(doc2).toBeInstanceOf(Y.Doc);
  });
});
