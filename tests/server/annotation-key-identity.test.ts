/**
 * An annotation's identity is its Y.Map key, never the stored `value.id`.
 *
 * Every minting path stores a record under its own id, but a browser CRDT
 * update, a session blob or the `.docx` drift path can leave a record under
 * key K whose stored `id` is X. Readers then took `value.id` as identity, and
 * writers keyed by it — so a refresh of K's record was written OVER the record
 * really stored at X.
 *
 * REGRESSION tests in this file use only APIs that exist on master
 * (`collectAnnotations`, `refreshAllRanges`), so they fail on the bug itself.
 */

import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { collectAnnotations } from "../../src/server/mcp/annotations.js";
import { getOrCreateXmlText } from "../../src/server/mcp/document-model.js";
import { refreshAllRanges } from "../../src/server/positions.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { makeDoc, rangeOf } from "../helpers/ydoc-factory.js";

const TEXT = "Hello world and the rest of it";
const DOC_HASH = "sha256:key-identity";

function paragraphText(ydoc: Y.Doc): Y.XmlText {
  return getOrCreateXmlText(ydoc.getXmlFragment("default").get(0) as Y.XmlElement);
}

/** A raw record anchored at [from, to), stored under `key` with `id`. */
function seed(
  ydoc: Y.Doc,
  key: string,
  id: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
): void {
  const anchored = rangeOf(from, to, ydoc);
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(key, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: anchored.range,
      relRange: anchored.relRange,
      textSnapshot: TEXT.slice(from, to),
      content: `content of ${key}`,
      status: "pending",
      timestamp: 1_700_000_000_000,
      rev: 1,
      ...extra,
    }),
  );
}

describe("refreshAllRanges(collectAnnotations(...)) never writes one record over another", () => {
  it("REGRESSION: a refresh of K's record lands on K, and the record stored at X is untouched", () => {
    const ydoc = makeDoc(TEXT);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // X: a comment on "Hello" (0-5), BEFORE the edit, so its refresh is `ok`
    // and writes nothing.
    seed(ydoc, "X", "X", 0, 5, { content: "the real comment at X" });
    // K: a private note on "world" (6-11), stored under key K with id X.
    seed(ydoc, "K", "X", 6, 11, {
      type: "note",
      audience: "private",
      content: "a private note",
    });
    const storedX = map.get("X");

    // An edit between the two shifts K's anchors but not X's.
    withInternal(ydoc, () => paragraphText(ydoc).insert(5, "!!"));

    const results = refreshAllRanges(collectAnnotations(map, DOC_HASH), ydoc, map);

    // The record at X is the very object stored before: nothing wrote it.
    expect(map.get("X")).toBe(storedX);
    expect((map.get("X") as { content: string }).content).toBe("the real comment at X");
    // K's refresh landed on K, with its moved range, and carries its own key.
    const k = map.get("K") as { id: string; type: string; range: { from: number; to: number } };
    expect(k.type).toBe("note");
    expect(k.range).toEqual({ from: 8, to: 13 });
    expect(k.id).toBe("K");
    // Reads report two distinct identities.
    expect(results.map((r) => r.annotation.id).sort()).toEqual(["K", "X"]);
  });

  it("REGRESSION: the lazy-attach arm (no relRange) writes K's anchor to K, not to X", () => {
    const ydoc = makeDoc(TEXT);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    seed(ydoc, "X", "X", 0, 5, { content: "the real comment at X" });
    seed(ydoc, "K", "X", 6, 11, { type: "note", audience: "private" });
    // Strip K's relRange so the lazy-attach arm mints and writes.
    const raw = { ...(map.get("K") as Record<string, unknown>) };
    delete raw.relRange;
    withInternal(ydoc, () => map.set("K", raw));
    const storedX = map.get("X");

    refreshAllRanges(collectAnnotations(map, DOC_HASH), ydoc, map);

    expect(map.get("X")).toBe(storedX);
    const k = map.get("K") as { id: string; relRange?: unknown };
    expect(k.relRange).toBeDefined();
    expect(k.id).toBe("K");
  });

  it("REGRESSION: collectAnnotations reports two records sharing a stored id as two identities", () => {
    const ydoc = makeDoc(TEXT);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    seed(ydoc, "X", "X", 0, 5);
    seed(ydoc, "K", "X", 6, 11);

    const ids = collectAnnotations(map, DOC_HASH)
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(["K", "X"]);
  });
});
