import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { exportAnnotations } from "../../src/server/file-io/docx.js";
import {
  collectAnnotations,
  createAnnotation,
  refreshRange,
} from "../../src/server/mcp/annotations.js";
import { extractText, verifyAndResolveRange } from "../../src/server/mcp/document.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
});

describe("tandem_highlight tool logic", () => {
  it("creates highlight annotation with color", () => {
    const ydoc = setupDoc("hl-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "", {
      color: "yellow",
    });

    const stored = map.get(id) as Annotation;
    expect(stored.type).toBe("highlight");
    expect(stored.color).toBe("yellow");
    expect(stored.range).toEqual({ from: 0, to: 5 });
    expect(stored.relRange).toBeDefined();
  });

  it("supports all highlight colors", () => {
    const ydoc = setupDoc("hl-2", "Hello world test content here");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    for (const color of ["yellow", "red", "green", "blue", "purple"] as const) {
      const id = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "", { color });
      const stored = map.get(id) as Annotation;
      expect(stored.color).toBe(color);
    }
  });
});

describe("tandem_comment tool logic", () => {
  it("creates comment with text content", () => {
    const ydoc = setupDoc("cm-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "This needs revision");

    const stored = map.get(id) as Annotation;
    expect(stored.type).toBe("comment");
    expect(stored.content).toBe("This needs revision");
  });
});

describe("tandem_suggest tool logic (comment with suggestedText)", () => {
  it("creates comment with suggestedText", () => {
    const ydoc = setupDoc("sg-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "more concise", {
      suggestedText: "Hi",
    });

    const stored = map.get(id) as Annotation;
    expect(stored.type).toBe("comment");
    expect(stored.suggestedText).toBe("Hi");
    expect(stored.content).toBe("more concise");
  });

  it("handles empty reason", () => {
    const ydoc = setupDoc("sg-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "", {
      suggestedText: "Hi",
    });

    const stored = map.get(id) as Annotation;
    expect(stored.suggestedText).toBe("Hi");
    expect(stored.content).toBe("");
  });
});

describe("tandem_flag tool logic", () => {
  it("creates flag annotation", () => {
    const ydoc = setupDoc("fl-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "flag", rangeOf(0, 5, ydoc), "Needs review");

    const stored = map.get(id) as Annotation;
    expect(stored.type).toBe("flag");
    expect(stored.content).toBe("Needs review");
  });

  it("flag with no note has empty content", () => {
    const ydoc = setupDoc("fl-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "flag", rangeOf(0, 5, ydoc), "");

    const stored = map.get(id) as Annotation;
    expect(stored.content).toBe("");
  });
});

describe("tandem_getAnnotations tool logic", () => {
  function populateAnnotations(ydoc: Y.Doc) {
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment 1", { author: "claude" });
    createAnnotation(map, ydoc, "highlight", rangeOf(0, 5), "", {
      author: "user",
      color: "yellow",
    });
    createAnnotation(map, ydoc, "comment", rangeOf(6, 11, ydoc), "", {
      author: "claude",
      suggestedText: "x",
    });
    // One accepted
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "old comment", {
      author: "claude",
    });
    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" });
    return map;
  }

  it("returns all annotations unfiltered", () => {
    const ydoc = setupDoc("ga-1", "Hello world test");
    const map = populateAnnotations(ydoc);
    const all = collectAnnotations(map);
    expect(all).toHaveLength(4);
  });

  it("filters by author", () => {
    const ydoc = setupDoc("ga-2", "Hello world test");
    const map = populateAnnotations(ydoc);
    const claude = collectAnnotations(map).filter((a) => a.author === "claude");
    expect(claude).toHaveLength(3);
    const user = collectAnnotations(map).filter((a) => a.author === "user");
    expect(user).toHaveLength(1);
  });

  it("filters by type", () => {
    const ydoc = setupDoc("ga-3", "Hello world test");
    const map = populateAnnotations(ydoc);
    const comments = collectAnnotations(map).filter((a) => a.type === "comment");
    expect(comments).toHaveLength(3); // 2 plain comments + 1 with suggestedText
    const withSuggestion = collectAnnotations(map).filter((a) => a.suggestedText !== undefined);
    expect(withSuggestion).toHaveLength(1);
  });

  it("filters by status", () => {
    const ydoc = setupDoc("ga-4", "Hello world test");
    const map = populateAnnotations(ydoc);
    const pending = collectAnnotations(map).filter((a) => a.status === "pending");
    expect(pending).toHaveLength(3);
    const accepted = collectAnnotations(map).filter((a) => a.status === "accepted");
    expect(accepted).toHaveLength(1);
  });

  it("compound filter: author + status", () => {
    const ydoc = setupDoc("ga-5", "Hello world test");
    const map = populateAnnotations(ydoc);
    const result = collectAnnotations(map)
      .filter((a) => a.author === "claude")
      .filter((a) => a.status === "pending");
    expect(result).toHaveLength(2);
  });
});

describe("tandem_resolveAnnotation tool logic", () => {
  it("accepts an annotation", () => {
    const ydoc = setupDoc("ra-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "review me");

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" as const });

    const updated = map.get(id) as Annotation;
    expect(updated.status).toBe("accepted");
  });

  it("dismisses an annotation", () => {
    const ydoc = setupDoc("ra-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "review me");

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "dismissed" as const });

    const updated = map.get(id) as Annotation;
    expect(updated.status).toBe("dismissed");
  });

  it("returns error for non-existent annotation ID", () => {
    const ydoc = setupDoc("ra-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = map.get("fake_id") as Annotation | undefined;
    expect(ann).toBeUndefined();
  });
});

describe("tandem_removeAnnotation tool logic", () => {
  it("removes annotation from map", () => {
    const ydoc = setupDoc("rm-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "to remove");

    expect(map.has(id)).toBe(true);
    map.delete(id);
    expect(map.has(id)).toBe(false);
  });

  it("returns false for non-existent annotation", () => {
    const ydoc = setupDoc("rm-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    expect(map.has("nonexistent")).toBe(false);
  });
});

describe("tandem_exportAnnotations tool logic", () => {
  it("exports markdown summary", () => {
    const ydoc = setupDoc("ex-1", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Nice intro");
    createAnnotation(map, ydoc, "highlight", rangeOf(6, 11, ydoc), "", { color: "yellow" });
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "simpler", {
      suggestedText: "Hi",
    });

    const annotations = collectAnnotations(map);
    const md = exportAnnotations(ydoc, annotations);

    expect(md).toContain("Comments");
    expect(md).toContain("Nice intro");
    expect(md).toContain("Highlights");
    expect(md).toContain("Suggestions");
  });

  it("returns no annotations message for empty list", () => {
    const ydoc = setupDoc("ex-2", "Hello world");
    const md = exportAnnotations(ydoc, []);
    expect(md.toLowerCase()).toContain("no annotation");
  });

  it("exports JSON format with text snippets", () => {
    const ydoc = setupDoc("ex-3", "Hello world test content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Note");

    const annotations = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const enriched = annotations.map((ann) => ({
      ...ann,
      textSnippet: fullText.slice(
        Math.max(0, ann.range.from),
        Math.min(fullText.length, ann.range.to),
      ),
    }));

    expect(enriched).toHaveLength(1);
    expect(enriched[0].textSnippet).toBe("Hello");
  });
});

describe("annotation stale range detection", () => {
  it("detects stale range via textSnapshot", () => {
    const ydoc = setupDoc("stale-ann", "Hello world");

    // Edit the doc
    const fragment = ydoc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = el.get(0) as Y.XmlText;
    xmlText.insert(0, "XXX");

    const result = verifyAndResolveRange(ydoc, 0, 5, "Hello");
    expect(result.valid).toBe(false);
  });

  it("relocates text when it has moved", () => {
    const ydoc = setupDoc("relocate-ann", "Hello world");

    // Insert text before "Hello"
    const fragment = ydoc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = el.get(0) as Y.XmlText;
    xmlText.insert(0, "XXX");

    const result = verifyAndResolveRange(ydoc, 0, 5, "Hello");
    expect(result.valid).toBe(false);
    if (!result.gone) {
      expect(result.resolvedFrom).toBe(3);
      expect(result.resolvedTo).toBe(8);
    }
  });
});

describe("annotation CRDT-anchored positions", () => {
  it("annotations with relRange survive edits", () => {
    const ydoc = setupDoc("crdt-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(6, 11, ydoc), "note on world");

    const ann = map.get(id) as Annotation;
    expect(ann.relRange).toBeDefined();

    // Insert text before the annotation
    const fragment = ydoc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = el.get(0) as Y.XmlText;
    xmlText.insert(0, "XXX");

    // Refresh should update flat offsets
    const refreshed = refreshRange(ann, ydoc, map);
    expect(refreshed.range.from).toBe(9);
    expect(refreshed.range.to).toBe(14);
  });

  it("annotations without relRange get it lazily attached", () => {
    const ydoc = setupDoc("crdt-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "note"); // no ydoc in rangeOf

    const ann = map.get(id) as Annotation;
    expect(ann.relRange).toBeUndefined();

    const refreshed = refreshRange(ann, ydoc, map);
    expect(refreshed.relRange).toBeDefined();
  });
});

describe("annotation on multi-document", () => {
  it("annotations are per-document", () => {
    const ydoc1 = setupDoc("md-1", "Doc one");
    const ydoc2 = setupDoc("md-2", "Doc two");

    const map1 = ydoc1.getMap(Y_MAP_ANNOTATIONS);
    const map2 = ydoc2.getMap(Y_MAP_ANNOTATIONS);

    createAnnotation(map1, ydoc1, "comment", rangeOf(0, 3), "on doc 1");
    createAnnotation(map2, ydoc2, "highlight", rangeOf(0, 3), "", { color: "red" });

    expect(collectAnnotations(map1)).toHaveLength(1);
    expect(collectAnnotations(map2)).toHaveLength(1);
    expect(collectAnnotations(map1)[0].type).toBe("comment");
    expect(collectAnnotations(map2)[0].type).toBe("highlight");
  });
});
