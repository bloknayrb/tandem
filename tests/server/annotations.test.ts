import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  collectAnnotations,
  createAnnotation,
  refreshRange,
  sanitizeAnnotation,
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
    const id = createAnnotation(map, doc, "highlight", rangeOf(0, 4), "", { color: "yellow" });

    const stored = map.get(id) as Annotation;
    expect(stored.color).toBe("yellow");
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
    createAnnotation(map, doc, "flag", rangeOf(0, 2), "f");

    const types = collectAnnotations(map).map((a) => a.type);
    expect(types).toContain("comment");
    expect(types).toContain("highlight");
    expect(types).toContain("flag");
  });
});

describe("filter logic", () => {
  function setupAnnotations() {
    doc = makeDoc("test content here");
    const map = getAnnotationsMap(doc);
    createAnnotation(map, doc, "comment", rangeOf(0, 4), "a comment");
    createAnnotation(map, doc, "highlight", rangeOf(0, 4), "", { color: "yellow" });
    createAnnotation(map, doc, "comment", rangeOf(5, 12), "clarity", {
      suggestedText: "stuff",
    });
    return map;
  }

  it("filters by type", () => {
    const map = setupAnnotations();
    const comments = collectAnnotations(map).filter((a) => a.type === "comment");
    expect(comments).toHaveLength(2); // plain comment + suggestion-style comment
    expect(comments.find((a) => a.content === "a comment")).toBeTruthy();
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

  it("compound filter: author + suggestedText", () => {
    const map = setupAnnotations();
    const result = collectAnnotations(map)
      .filter((a) => a.author === "claude")
      .filter((a) => a.suggestedText !== undefined);
    expect(result).toHaveLength(1);
  });
});

describe("suggestion fields on comment type", () => {
  it("comment with suggestedText stores replacement and reason separately", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 4), "better wording", {
      suggestedText: "replacement",
    });

    const stored = map.get(id) as Annotation;
    expect(stored.type).toBe("comment");
    expect(stored.suggestedText).toBe("replacement");
    expect(stored.content).toBe("better wording");
  });

  it("comment with suggestedText and empty reason", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 4), "", {
      suggestedText: "x",
    });

    const stored = map.get(id) as Annotation;
    expect(stored.suggestedText).toBe("x");
    expect(stored.content).toBe("");
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

describe("sanitizeAnnotation", () => {
  const base = {
    id: "ann_test_1",
    author: "claude" as const,
    range: { from: 0, to: 5 },
    content: "test",
    status: "pending" as const,
    timestamp: 1000,
  };

  it("converts legacy suggestion with valid JSON to comment + suggestedText", () => {
    const legacy = {
      ...base,
      type: "suggestion",
      content: JSON.stringify({ newText: "Hi", reason: "brevity" }),
    };
    const result = sanitizeAnnotation(legacy as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.suggestedText).toBe("Hi");
    expect(result.content).toBe("brevity");
  });

  it("converts legacy suggestion with malformed JSON to plain comment", () => {
    const legacy = { ...base, type: "suggestion", content: "not-json" };
    const result = sanitizeAnnotation(legacy as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.suggestedText).toBeUndefined();
    expect(result.content).toBe("not-json");
  });

  it("converts legacy suggestion with partial JSON (missing reason)", () => {
    const legacy = {
      ...base,
      type: "suggestion",
      content: JSON.stringify({ newText: "Hi" }),
    };
    const result = sanitizeAnnotation(legacy as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.suggestedText).toBe("Hi");
    expect(result.content).toBe("");
  });

  it("converts legacy question to comment with directedAt", () => {
    const legacy = { ...base, type: "question" };
    const result = sanitizeAnnotation(legacy as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.directedAt).toBe("claude");
  });

  it("strips stray color from non-highlight entries", () => {
    const withStrayColor = { ...base, type: "comment", color: "yellow" };
    const result = sanitizeAnnotation(withStrayColor as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.color).toBeUndefined();
  });

  it("preserves color on highlight entries", () => {
    const highlight = { ...base, type: "highlight", color: "yellow" };
    const result = sanitizeAnnotation(highlight as unknown as Annotation);
    expect(result.type).toBe("highlight");
    expect(result.color).toBe("yellow");
  });

  it("passes through valid comment with suggestedText unchanged", () => {
    const comment = { ...base, type: "comment", suggestedText: "replacement" };
    const result = sanitizeAnnotation(comment as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.suggestedText).toBe("replacement");
    expect(result.content).toBe("test");
  });

  it("passes through valid comment with directedAt unchanged", () => {
    const comment = { ...base, type: "comment", directedAt: "claude" as const };
    const result = sanitizeAnnotation(comment as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(result.directedAt).toBe("claude");
  });

  it("passes through valid flag unchanged", () => {
    const flag = { ...base, type: "flag" };
    const result = sanitizeAnnotation(flag as unknown as Annotation);
    expect(result.type).toBe("flag");
  });

  it("preserves optional fields (relRange, textSnapshot, editedAt)", () => {
    const legacy = {
      ...base,
      type: "suggestion",
      content: JSON.stringify({ newText: "x", reason: "y" }),
      textSnapshot: "original",
      editedAt: 2000,
    };
    const result = sanitizeAnnotation(legacy as unknown as Annotation);
    expect(result.textSnapshot).toBe("original");
    expect(result.editedAt).toBe(2000);
  });

  it("warns and coerces truly unknown types to comment", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = { ...base, type: "note" };
    const result = sanitizeAnnotation(unknown as unknown as Annotation);
    expect(result.type).toBe("comment");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown type "note"'));
    warnSpy.mockRestore();
  });

  it("does not warn for valid comment type", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const comment = { ...base, type: "comment" };
    sanitizeAnnotation(comment as unknown as Annotation);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("preserves textSnapshot: '' (empty string)", () => {
    const ann = { ...base, type: "comment", textSnapshot: "" };
    const result = sanitizeAnnotation(ann as unknown as Annotation);
    expect(result.textSnapshot).toBe("");
  });

  it("preserves editedAt: 0", () => {
    const ann = { ...base, type: "comment", editedAt: 0 };
    const result = sanitizeAnnotation(ann as unknown as Annotation);
    expect(result.editedAt).toBe(0);
  });

  it("collectAnnotations sanitizes legacy shapes from Y.Map", () => {
    doc = makeDoc("test");
    const map = getAnnotationsMap(doc);

    // Manually insert a legacy suggestion into the Y.Map
    map.set("legacy-1", {
      id: "legacy-1",
      author: "claude",
      type: "suggestion",
      range: { from: 0, to: 4 },
      content: JSON.stringify({ newText: "Hello", reason: "greeting" }),
      status: "pending",
      timestamp: 1000,
    });

    const annotations = collectAnnotations(map);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].type).toBe("comment");
    expect(annotations[0].suggestedText).toBe("Hello");
    expect(annotations[0].content).toBe("greeting");
  });
});
