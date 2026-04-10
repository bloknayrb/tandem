import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  collectAnnotations,
  createAnnotation,
  refreshRange,
} from "../../src/server/mcp/annotations.js";
import { extractText, getOrCreateXmlText } from "../../src/server/mcp/document.js";
import type { Annotation } from "../../src/shared/types.js";
import { generateAnnotationId } from "../../src/shared/utils.js";
import { getAnnotationsMap, getFragment, makeDoc, rangeOf } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("generateAnnotationId", () => {
  it("matches expected format", () => {
    const id = generateAnnotationId();
    expect(id).toMatch(/^ann_\d+_[a-z0-9]+$/);
  });

  it("successive calls produce different IDs", () => {
    const id1 = generateAnnotationId();
    const id2 = generateAnnotationId();
    expect(id1).not.toBe(id2);
  });
});

describe("createAnnotation", () => {
  it("stores annotation with correct default fields", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 4), "nice text");

    const stored = map.get(id) as Annotation;
    expect(stored.id).toBe(id);
    expect(stored.author).toBe("claude");
    expect(stored.type).toBe("comment");
    expect(stored.range).toEqual({ from: 0, to: 4 });
    expect(stored.content).toBe("nice text");
    expect(stored.status).toBe("pending");
    expect(stored.timestamp).toBeTypeOf("number");
  });

  it("extras override defaults", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "highlight", rangeOf(0, 4), "", { color: "red" });

    const stored = map.get(id) as Annotation;
    expect(stored.color).toBe("red");
  });
});

describe("collectAnnotations", () => {
  it("returns empty array for empty map", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    expect(collectAnnotations(map)).toEqual([]);
  });

  it("returns all stored annotations", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    createAnnotation(map, doc, "comment", rangeOf(0, 2), "first");
    createAnnotation(map, doc, "highlight", rangeOf(2, 4), "second");

    const all = collectAnnotations(map);
    expect(all).toHaveLength(2);
  });

  it("returns annotations of different types", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    createAnnotation(map, doc, "comment", rangeOf(0, 2), "c");
    createAnnotation(map, doc, "highlight", rangeOf(0, 2), "h");
    createAnnotation(map, doc, "suggestion", rangeOf(0, 2), "{}");

    const types = collectAnnotations(map).map((a) => a.type);
    expect(types).toContain("comment");
    expect(types).toContain("highlight");
    expect(types).toContain("suggestion");
  });
});

describe("filter logic", () => {
  function setupAnnotations() {
    doc = makeDoc("test content here");
    const map = getAnnotationsMap(doc);
    createAnnotation(map, doc, "comment", rangeOf(0, 4), "a comment");
    createAnnotation(map, doc, "highlight", rangeOf(0, 4), "", { color: "yellow" });
    createAnnotation(
      map,
      doc,
      "suggestion",
      rangeOf(5, 12),
      JSON.stringify({ newText: "stuff", reason: "clarity" }),
    );
    return map;
  }

  it("filters by type", () => {
    const map = setupAnnotations();
    const comments = collectAnnotations(map).filter((a) => a.type === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe("a comment");
  });

  it("filters by status", () => {
    const map = setupAnnotations();
    const pending = collectAnnotations(map).filter((a) => a.status === "pending");
    expect(pending).toHaveLength(3);
  });

  it("filters by author", () => {
    const map = setupAnnotations();
    const claude = collectAnnotations(map).filter((a) => a.author === "claude");
    expect(claude).toHaveLength(3);
    const user = collectAnnotations(map).filter((a) => a.author === "user");
    expect(user).toHaveLength(0);
  });

  it("compound filter: author + type", () => {
    const map = setupAnnotations();
    const result = collectAnnotations(map)
      .filter((a) => a.author === "claude")
      .filter((a) => a.type === "suggestion");
    expect(result).toHaveLength(1);
  });
});

describe("suggestion JSON contract", () => {
  it("suggestion content is parseable JSON with newText and reason", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(
      map,
      doc,
      "suggestion",
      rangeOf(0, 4),
      JSON.stringify({ newText: "replacement", reason: "better wording" }),
    );

    const stored = map.get(id) as Annotation;
    const parsed = JSON.parse(stored.content);
    expect(parsed.newText).toBe("replacement");
    expect(parsed.reason).toBe("better wording");
  });

  it("suggestion with empty reason", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(
      map,
      doc,
      "suggestion",
      rangeOf(0, 4),
      JSON.stringify({ newText: "x", reason: "" }),
    );

    const stored = map.get(id) as Annotation;
    const parsed = JSON.parse(stored.content);
    expect(parsed.reason).toBe("");
  });
});

describe("resolve and remove", () => {
  it("resolve changes status to accepted", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 4), "text");

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" as const });

    const updated = map.get(id) as Annotation;
    expect(updated.status).toBe("accepted");
  });

  it("resolve changes status to dismissed", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 4), "text");

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "dismissed" as const });

    const updated = map.get(id) as Annotation;
    expect(updated.status).toBe("dismissed");
  });

  it("remove deletes from map", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 4), "text");
    expect(map.has(id)).toBe(true);

    map.delete(id);
    expect(map.has(id)).toBe(false);
  });

  it("get nonexistent ID returns undefined", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    expect(map.get("ann_fake_id")).toBeUndefined();
  });
});

describe("createAnnotation with ydoc (relRange)", () => {
  it("stores relRange when ydoc is provided", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "note");

    const stored = map.get(id) as Annotation;
    expect(stored.relRange).toBeDefined();
    expect(stored.relRange!.fromRel).not.toBeNull();
    expect(stored.relRange!.toRel).not.toBeNull();
  });

  it("omits relRange when ydoc is not provided", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5), "note");

    const stored = map.get(id) as Annotation;
    expect(stored.relRange).toBeUndefined();
  });

  it("omits relRange when offset is in heading prefix", () => {
    doc = makeDoc("## Title");
    const map = getAnnotationsMap(doc);
    // from=0 is inside "## " prefix → anchoredRange still succeeds but relRange is undefined
    const id = createAnnotation(map, doc, "highlight", rangeOf(0, 3, doc), "");

    const stored = map.get(id) as Annotation;
    expect(stored.relRange).toBeUndefined();
  });
});

describe("refreshRange", () => {
  it("lazily attaches relRange to annotations missing it", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5), "note"); // no ydoc → no relRange

    const ann = map.get(id) as Annotation;
    expect(ann.relRange).toBeUndefined();

    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.relRange).toBeDefined();
    expect(refreshed.relRange!.fromRel).not.toBeNull();
    expect(refreshed.relRange!.toRel).not.toBeNull();

    // Verify persisted to map
    const stored = map.get(id) as Annotation;
    expect(stored.relRange).toBeDefined();
  });

  it("updates stale flat offsets from relRange", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(6, 11, doc), "note");

    // Verify initial range
    const ann = map.get(id) as Annotation;
    expect(ann.range).toEqual({ from: 6, to: 11 });
    expect(ann.relRange).toBeDefined();

    // Insert text before the annotation → flat offsets go stale
    const fragment = getFragment(doc);
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = getOrCreateXmlText(el);
    xmlText.insert(0, "XXX");

    expect(extractText(doc)).toBe("XXXhello world");

    // refreshRange should correct the flat offsets
    const refreshed = refreshRange(ann, doc, map);
    expect(refreshed.range).toEqual({ from: 9, to: 14 }); // shifted by 3

    // Verify persisted
    const stored = map.get(id) as Annotation;
    expect(stored.range).toEqual({ from: 9, to: 14 });
  });

  it("returns original annotation when offsets are unchanged", () => {
    doc = makeDoc("hello world");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "note");

    const ann = map.get(id) as Annotation;
    const refreshed = refreshRange(ann, doc);
    // Same object since no update needed (no map write)
    expect(refreshed.range).toEqual(ann.range);
  });

  it("returns original when relRange resolves to null (deleted content)", () => {
    doc = makeDoc("first\nsecond");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(6, 12, doc), "note");

    const ann = map.get(id) as Annotation;
    expect(ann.relRange).toBeDefined();

    // Delete the second element
    const fragment = getFragment(doc);
    fragment.delete(1, 1);

    const refreshed = refreshRange(ann, doc);
    // Falls back to original range since relRange can't resolve
    expect(refreshed.range).toEqual({ from: 6, to: 12 });
  });
});
