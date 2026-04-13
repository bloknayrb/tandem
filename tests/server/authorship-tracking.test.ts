import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants.js";
import type { AuthorshipRange } from "../../src/shared/types.js";

/**
 * Verifies authorship tracking via Y.Map overlay:
 * - Claude edits produce entries in Y.Map('authorship')
 * - Entries have correct author, range, and structure
 * - Multiple edits produce multiple entries
 */

/** Minimal Y.Doc with a paragraph containing the given text. */
function createDocWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const para = new Y.XmlElement("paragraph");
  fragment.insert(0, [para]);
  const textNode = new Y.XmlText();
  para.insert(0, [textNode]);
  textNode.insert(0, text);
  return doc;
}

describe("Authorship tracking — Y.Map overlay", () => {
  it("records an authorship entry in the Y.Map", () => {
    const doc = createDocWithText("Hello world");
    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);

    // Simulate what tandem_edit does after a successful edit
    const rangeId = "claude-test-1";
    const entry: AuthorshipRange = {
      id: rangeId,
      author: "claude",
      range: { from: 0 as any, to: 5 as any },
      timestamp: Date.now(),
    };
    doc.transact(() => {
      authorshipMap.set(rangeId, entry);
    }, "mcp");

    expect(authorshipMap.size).toBe(1);
    const stored = authorshipMap.get(rangeId) as AuthorshipRange;
    expect(stored.author).toBe("claude");
    expect(stored.range.from).toBe(0);
    expect(stored.range.to).toBe(5);
  });

  it("records user authorship entries", () => {
    const doc = createDocWithText("Hello world");
    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);

    const rangeId = "user-test-1";
    const entry: AuthorshipRange = {
      id: rangeId,
      author: "user",
      range: { from: 6 as any, to: 11 as any },
      timestamp: Date.now(),
    };
    authorshipMap.set(rangeId, entry);

    const stored = authorshipMap.get(rangeId) as AuthorshipRange;
    expect(stored.author).toBe("user");
  });

  it("supports multiple authorship entries", () => {
    const doc = createDocWithText("Hello world test");
    const authorshipMap = doc.getMap(Y_MAP_AUTHORSHIP);

    const entries: AuthorshipRange[] = [
      { id: "claude-1", author: "claude", range: { from: 0 as any, to: 5 as any }, timestamp: 1 },
      { id: "user-1", author: "user", range: { from: 6 as any, to: 11 as any }, timestamp: 2 },
      {
        id: "claude-2",
        author: "claude",
        range: { from: 12 as any, to: 16 as any },
        timestamp: 3,
      },
    ];

    for (const entry of entries) {
      authorshipMap.set(entry.id, entry);
    }

    expect(authorshipMap.size).toBe(3);

    const claudeEntries: AuthorshipRange[] = [];
    const userEntries: AuthorshipRange[] = [];
    authorshipMap.forEach((value) => {
      const e = value as AuthorshipRange;
      if (e.author === "claude") claudeEntries.push(e);
      else userEntries.push(e);
    });

    expect(claudeEntries).toHaveLength(2);
    expect(userEntries).toHaveLength(1);
  });

  it("survives Y.Doc state sync (entries persist)", () => {
    const doc1 = new Y.Doc();
    const fragment = doc1.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    fragment.insert(0, [para]);
    const textNode = new Y.XmlText();
    para.insert(0, [textNode]);
    textNode.insert(0, "Hello world");

    const authorshipMap = doc1.getMap(Y_MAP_AUTHORSHIP);
    authorshipMap.set("claude-1", {
      id: "claude-1",
      author: "claude",
      range: { from: 0, to: 5 },
      timestamp: Date.now(),
    });

    // Sync to a second doc
    const doc2 = new Y.Doc();
    const update = Y.encodeStateAsUpdate(doc1);
    Y.applyUpdate(doc2, update);

    const map2 = doc2.getMap(Y_MAP_AUTHORSHIP);
    expect(map2.size).toBe(1);
    const entry = map2.get("claude-1") as AuthorshipRange;
    expect(entry.author).toBe("claude");
    expect(entry.range.from).toBe(0);
    expect(entry.range.to).toBe(5);
  });

  it("overlay overhead scales with entry count, not document size", () => {
    // With a 100KB doc and 20 edits (realistic session), overhead is small
    const baseline = new Y.Doc();
    const frag1 = baseline.getXmlFragment("default");
    const p1 = new Y.XmlElement("paragraph");
    frag1.insert(0, [p1]);
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    t1.insert(0, "x".repeat(100_000));
    const baselineSize = Y.encodeStateAsUpdate(baseline).byteLength;

    const withAuthorship = new Y.Doc();
    const frag2 = withAuthorship.getXmlFragment("default");
    const p2 = new Y.XmlElement("paragraph");
    frag2.insert(0, [p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, "x".repeat(100_000));

    // 20 authorship entries — a typical editing session
    const map = withAuthorship.getMap(Y_MAP_AUTHORSHIP);
    for (let i = 0; i < 20; i++) {
      map.set(`entry-${i}`, {
        id: `entry-${i}`,
        author: i % 2 === 0 ? "claude" : "user",
        range: { from: i * 500, to: i * 500 + 200 },
        timestamp: Date.now(),
      });
    }

    const withSize = Y.encodeStateAsUpdate(withAuthorship).byteLength;
    const overhead = ((withSize - baselineSize) / baselineSize) * 100;

    console.log(
      `[overlay overhead] 100KB + 20 entries: baseline=${baselineSize}B, withAuthorship=${withSize}B, overhead=${overhead.toFixed(2)}%`,
    );

    // 20 range entries on a 100KB doc should be under 10% overhead
    // (each entry is ~80 bytes, so ~1.6KB total vs 100KB baseline)
    expect(overhead).toBeLessThan(10);
  });
});
