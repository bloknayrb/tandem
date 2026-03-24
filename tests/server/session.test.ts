import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import fs from 'fs/promises';
import path from 'path';
import {
  saveSession, loadSession, restoreYDoc, sourceFileChanged,
  sessionKey, deleteSession,
} from '../../src/server/session/manager';

// Use a temp directory for test sessions
const _TEST_SESSION_DIR = path.join('.tandem', 'test-sessions');

describe('Session persistence', () => {
  // Create a Y.Doc with some content and annotations
  function createTestDoc(): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Hello world')]);
    fragment.insert(0, [p]);

    // Add an annotation
    const annotations = doc.getMap('annotations');
    annotations.set('ann_test_1', {
      id: 'ann_test_1',
      author: 'claude',
      type: 'highlight',
      range: { from: 0, to: 5 },
      content: 'test note',
      status: 'pending',
      timestamp: Date.now(),
      color: 'yellow',
    });

    return doc;
  }

  describe('sessionKey', () => {
    it('encodes file paths consistently', () => {
      const key = sessionKey('C:\\Users\\test\\doc.md');
      expect(key).toBe(encodeURIComponent('C:/Users/test/doc.md'));
    });

    it('normalizes backslashes to forward slashes', () => {
      const key1 = sessionKey('C:\\Users\\test\\doc.md');
      const key2 = sessionKey('C:/Users/test/doc.md');
      expect(key1).toBe(key2);
    });
  });

  describe('save and restore round-trip', () => {
    const testFilePath = path.resolve('tests/fixtures/session-test.md');

    beforeEach(async () => {
      // Create a temp fixture file
      await fs.mkdir(path.dirname(testFilePath), { recursive: true });
      await fs.writeFile(testFilePath, '# Test\nHello world\n', 'utf-8');
    });

    afterEach(async () => {
      await deleteSession(testFilePath);
      try { await fs.unlink(testFilePath); } catch {}
    });

    it('saves and loads session data', async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, 'md', doc);

      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();
      expect(session!.filePath).toBe(testFilePath);
      expect(session!.format).toBe('md');
      expect(session!.ydocState).toBeTruthy();
      expect(session!.lastAccessed).toBeGreaterThan(0);
    });

    it('restores Y.Doc content from session', async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, 'md', doc);

      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();

      // Restore into a fresh Y.Doc
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // Check document content
      const fragment = restored.getXmlFragment('default');
      expect(fragment.length).toBeGreaterThan(0);
    });

    it('restores annotations from session', async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, 'md', doc);

      const session = await loadSession(testFilePath);
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // Check annotations survived
      const annotations = restored.getMap('annotations');
      const ann = annotations.get('ann_test_1') as any;
      expect(ann).toBeTruthy();
      expect(ann.id).toBe('ann_test_1');
      expect(ann.content).toBe('test note');
      expect(ann.color).toBe('yellow');
    });

    it('detects unchanged source file', async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, 'md', doc);

      const session = await loadSession(testFilePath);
      const changed = await sourceFileChanged(session!);
      expect(changed).toBe(false);
    });

    it('detects changed source file', async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, 'md', doc);

      // Modify the source file
      await new Promise(r => setTimeout(r, 50)); // Ensure mtime differs
      await fs.writeFile(testFilePath, '# Modified\nDifferent content\n', 'utf-8');

      const session = await loadSession(testFilePath);
      const changed = await sourceFileChanged(session!);
      expect(changed).toBe(true);
    });

    it('returns null for non-existent session', async () => {
      const session = await loadSession('/nonexistent/path.md');
      expect(session).toBeNull();
    });
  });
});
