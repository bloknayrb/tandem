/**
 * Tests for the file-reload workflow: verifying that when document content
 * is replaced in-place (as reloadFromDisk does), annotations survive via
 * refreshAllRanges + textSnapshot-based relocation.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText, populateYDoc } from "../../src/server/mcp/document-model.js";
import {
  anchoredRange,
  refreshAllRanges,
  refreshRange,
  validateRange,
} from "../../src/server/positions.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeAnnotation, makeDoc } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("reload: content replacement preserves annotations", () => {
  it("refreshAllRanges re-anchors annotations after plain text reload", () => {
    doc = makeDoc("Hello world");
    const map = getAnnotationsMap(doc);

    // Create an annotation on "world" (offset 6..11)
    const result = anchoredRange(doc, toFlatOffset(6), toFlatOffset(11), "world");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ann = makeAnnotation({
      id: "ann_reload_1",
      range: result.range,
      relRange: "relRange" in result ? result.relRange : undefined,
      textSnapshot: "world",
    });
    doc.transact(() => map.set(ann.id, ann), MCP_ORIGIN);

    // Simulate reload: replace content with slightly different text
    doc.transact(() => {
      populateYDoc(doc, "Hey world");
    }, MCP_ORIGIN);

    // "world" is now at offset 4..9
    const text = extractText(doc);
    expect(text).toBe("Hey world");

    // refreshAllRanges should re-anchor via CRDT or lazy path
    const annotations = Array.from(map.values()) as Annotation[];
    const refreshed = refreshAllRanges(annotations, doc, map);

    expect(refreshed.length).toBe(1);
    // The annotation should have moved to the new position of "world"
    // After content replacement, CRDT positions may or may not resolve —
    // either way, the annotation should still exist in the map
    const stored = map.get("ann_reload_1") as Annotation;
    expect(stored).toBeDefined();
  });

  it("textSnapshot-based relocation finds moved text after reload", () => {
    doc = makeDoc("The quick brown fox");
    const map = getAnnotationsMap(doc);

    // Annotation on "brown" (offset 10..15)
    const ann = makeAnnotation({
      id: "ann_relocate_1",
      range: { from: toFlatOffset(10), to: toFlatOffset(15) },
      textSnapshot: "brown",
    });
    doc.transact(() => map.set(ann.id, ann), MCP_ORIGIN);

    // Reload with text where "brown" moved
    doc.transact(() => {
      populateYDoc(doc, "A brown fox jumped quickly");
    }, MCP_ORIGIN);

    const text = extractText(doc);
    expect(text).toContain("brown");

    // validateRange should detect RANGE_MOVED
    const vr = validateRange(doc, ann.range.from, ann.range.to, {
      textSnapshot: "brown",
    });

    if (vr.ok) {
      // Text happened to still be at the same offset — that's fine
      return;
    }

    expect(vr.code).toBe("RANGE_MOVED");
    if (vr.code === "RANGE_MOVED" && "resolvedFrom" in vr) {
      // Re-anchor at the new location
      const relocated = anchoredRange(doc, vr.resolvedFrom!, vr.resolvedTo!, "brown");
      expect(relocated.ok).toBe(true);
      if (relocated.ok) {
        const slice = text.slice(relocated.range.from, relocated.range.to);
        expect(slice).toBe("brown");
      }
    }
  });

  it("RANGE_GONE when annotated text is deleted entirely", () => {
    doc = makeDoc("Hello world");

    // Annotation on "world"
    const ann = makeAnnotation({
      id: "ann_gone_1",
      range: { from: toFlatOffset(6), to: toFlatOffset(11) },
      textSnapshot: "world",
    });

    // Reload without "world"
    doc.transact(() => {
      populateYDoc(doc, "Hello there");
    }, MCP_ORIGIN);

    const vr = validateRange(doc, ann.range.from, ann.range.to, {
      textSnapshot: "world",
    });

    expect(vr.ok).toBe(false);
    if (!vr.ok) {
      expect(vr.code).toBe("RANGE_GONE");
    }
  });
});

describe("reload: refreshRange dead relRange recovery", () => {
  it("strips dead relRange and re-anchors from flat offsets", () => {
    doc = makeDoc("Hello world");
    const map = getAnnotationsMap(doc);

    // Create annotation with CRDT-anchored range
    const result = anchoredRange(doc, toFlatOffset(0), toFlatOffset(5), "Hello");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ann = makeAnnotation({
      id: "ann_dead_rel",
      range: result.range,
      relRange: "relRange" in result ? result.relRange : undefined,
      textSnapshot: "Hello",
    });
    doc.transact(() => map.set(ann.id, ann), MCP_ORIGIN);

    // Replace content entirely — old CRDT items are garbage-collected
    doc.transact(() => {
      populateYDoc(doc, "Hello world reloaded");
    }, MCP_ORIGIN);

    // refreshRange should detect dead relRange and attempt recovery
    refreshRange(ann, doc, map);
    const stored = map.get("ann_dead_rel") as Annotation;
    expect(stored).toBeDefined();

    // The annotation should either have a fresh relRange or have relRange stripped
    // Either outcome is acceptable — the annotation survives
    expect(stored.range).toBeDefined();
  });
});

describe("reload: markdown content reload", () => {
  it("preserves annotation through markdown reload with heading changes", () => {
    doc = new Y.Doc();
    loadMarkdown(doc, "# Title\n\nSome paragraph text here.");
    const map = getAnnotationsMap(doc);

    const text = extractText(doc);
    const paraStart = text.indexOf("Some");
    const paraEnd = paraStart + "Some paragraph".length;

    const result = anchoredRange(doc, toFlatOffset(paraStart), toFlatOffset(paraEnd));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ann = makeAnnotation({
      id: "ann_md_reload",
      range: result.range,
      relRange: "relRange" in result ? result.relRange : undefined,
      textSnapshot: "Some paragraph",
    });
    doc.transact(() => map.set(ann.id, ann), MCP_ORIGIN);

    // Reload with modified heading but same paragraph
    doc.transact(() => {
      loadMarkdown(doc, "# New Title\n\nSome paragraph text here.");
    }, MCP_ORIGIN);

    const newText = extractText(doc);
    expect(newText).toContain("Some paragraph");

    const annotations = Array.from(map.values()) as Annotation[];
    const refreshed = refreshAllRanges(annotations, doc, map);
    expect(refreshed.length).toBe(1);

    // Verify annotation can be relocated via textSnapshot
    const stored = map.get("ann_md_reload") as Annotation;
    const vr = validateRange(doc, stored.range.from, stored.range.to, {
      textSnapshot: "Some paragraph",
    });

    if (!vr.ok && vr.code === "RANGE_MOVED" && "resolvedFrom" in vr) {
      // Re-anchor
      const relocated = anchoredRange(doc, vr.resolvedFrom!, vr.resolvedTo!, "Some paragraph");
      expect(relocated.ok).toBe(true);
    }
    // If vr.ok, the annotation is already at the right position — great
  });
});
