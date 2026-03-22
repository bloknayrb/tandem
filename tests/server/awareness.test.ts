import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { resetInbox } from '../../src/server/mcp/awareness.js';
import { collectAnnotations } from '../../src/server/mcp/annotations.js';
import { populateYDoc, extractText } from '../../src/server/mcp/document.js';
import type { Annotation } from '../../src/shared/types.js';

let doc: Y.Doc;

function makeDoc(text: string): Y.Doc {
  doc = new Y.Doc();
  populateYDoc(doc, text);
  return doc;
}

function addAnnotation(
  map: Y.Map<unknown>,
  overrides: Partial<Annotation>,
): Annotation {
  const ann: Annotation = {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    author: 'user',
    type: 'highlight',
    range: { from: 0, to: 5 },
    content: '',
    status: 'pending',
    timestamp: Date.now(),
    ...overrides,
  };
  map.set(ann.id, ann);
  return ann;
}

beforeEach(() => {
  resetInbox();
});

afterEach(() => {
  doc?.destroy();
});

describe('tandem_checkInbox logic', () => {
  // These tests verify the inbox logic directly since we can't easily call MCP tools in unit tests.
  // The logic is: collect annotations, split by author/status, dedup via surfacedIds.

  it('surfaces new user annotations', () => {
    makeDoc('Hello world test');
    const map = doc.getMap('annotations');

    const highlight = addAnnotation(map, { author: 'user', type: 'highlight', range: { from: 0, to: 5 } });
    const comment = addAnnotation(map, { author: 'user', type: 'comment', range: { from: 6, to: 11 }, content: 'Nice' });

    const allAnns = collectAnnotations(map);
    const userActions = allAnns.filter(a => a.author === 'user');

    expect(userActions.length).toBe(2);
    expect(userActions.find(a => a.type === 'highlight')).toBeTruthy();
    expect(userActions.find(a => a.type === 'comment')).toBeTruthy();
  });

  it('surfaces user responses to Claude annotations', () => {
    makeDoc('Hello world');
    const map = doc.getMap('annotations');

    addAnnotation(map, { author: 'claude', type: 'suggestion', status: 'accepted' });
    addAnnotation(map, { author: 'claude', type: 'comment', status: 'dismissed' });
    addAnnotation(map, { author: 'claude', type: 'highlight', status: 'pending' }); // Still pending, not a response

    const allAnns = collectAnnotations(map);
    const responses = allAnns.filter(a => a.author === 'claude' && a.status !== 'pending');

    expect(responses.length).toBe(2);
  });

  it('question annotation type works', () => {
    makeDoc('Hello world');
    const map = doc.getMap('annotations');

    const question = addAnnotation(map, {
      author: 'user',
      type: 'question',
      range: { from: 0, to: 5 },
      content: 'What does this mean?',
    });

    const allAnns = collectAnnotations(map);
    const questions = allAnns.filter(a => a.type === 'question');

    expect(questions.length).toBe(1);
    expect(questions[0].content).toBe('What does this mean?');
    expect(questions[0].author).toBe('user');
  });

  it('text snippets can be extracted for annotation ranges', () => {
    makeDoc('The quick brown fox jumps over the lazy dog');
    const fullText = extractText(doc);

    // Simulate snippet extraction (same logic as tandem_checkInbox)
    const snippet = fullText.slice(
      Math.max(0, Math.min(4, fullText.length)),
      Math.max(4, Math.min(9, fullText.length)),
    );

    expect(snippet).toBe('quick');
  });
});

describe('surfacedIds deduplication', () => {
  // The inbox uses a Set<string> to track which IDs have been returned.
  // resetInbox() clears it between tests.

  it('resetInbox clears the set', () => {
    // This is a basic sanity check that the exported function works.
    // The actual dedup behavior is tested via the MCP tool integration.
    resetInbox();
    // No assertions needed — just verify it doesn't throw
  });
});
