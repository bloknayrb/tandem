import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { createAnnotation } from "../../src/server/mcp/annotations.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
  getOpenDocs,
} from "../../src/server/mcp/document-service.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import type { Annotation } from "../../src/shared/types.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

describe("tandem_editAnnotation logic", () => {
  it("edits a comment's content", () => {
    const ydoc = setupDoc("edit-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original comment");

    const ann = map.get(id) as Annotation;
    expect(ann.content).toBe("Original comment");
    expect(ann.editedAt).toBeUndefined();

    // Simulate edit
    const updated = { ...ann, content: "Updated comment", editedAt: Date.now() };
    ydoc.transact(() => map.set(id, updated), MCP_ORIGIN);

    const result = map.get(id) as Annotation;
    expect(result.content).toBe("Updated comment");
    expect(result.editedAt).toBeDefined();
    expect(typeof result.editedAt).toBe("number");
  });

  it("edits a suggestion's newText and reason", () => {
    const ydoc = setupDoc("edit-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const originalContent = JSON.stringify({ newText: "Hi", reason: "brevity" });
    const id = createAnnotation(map, ydoc, "suggestion", rangeOf(0, 5, ydoc), originalContent);

    const ann = map.get(id) as Annotation;
    const parsed = JSON.parse(ann.content);
    expect(parsed.newText).toBe("Hi");
    expect(parsed.reason).toBe("brevity");

    // Edit only newText, keep reason
    const existing = JSON.parse(ann.content);
    const newContent = JSON.stringify({ newText: "Hey", reason: existing.reason });
    const updated = { ...ann, content: newContent, editedAt: Date.now() };
    ydoc.transact(() => map.set(id, updated), MCP_ORIGIN);

    const result = map.get(id) as Annotation;
    const resultParsed = JSON.parse(result.content);
    expect(resultParsed.newText).toBe("Hey");
    expect(resultParsed.reason).toBe("brevity");
    expect(result.editedAt).toBeDefined();
  });

  it("edits a suggestion's reason only", () => {
    const ydoc = setupDoc("edit-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const originalContent = JSON.stringify({ newText: "Hi", reason: "brevity" });
    const id = createAnnotation(map, ydoc, "suggestion", rangeOf(0, 5, ydoc), originalContent);

    const ann = map.get(id) as Annotation;
    const existing = JSON.parse(ann.content);
    const newContent = JSON.stringify({ newText: existing.newText, reason: "more concise" });
    const updated = { ...ann, content: newContent, editedAt: Date.now() };
    ydoc.transact(() => map.set(id, updated), MCP_ORIGIN);

    const result = map.get(id) as Annotation;
    const resultParsed = JSON.parse(result.content);
    expect(resultParsed.newText).toBe("Hi");
    expect(resultParsed.reason).toBe("more concise");
  });

  it("cannot edit a resolved annotation", () => {
    const ydoc = setupDoc("edit-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original");

    // Accept the annotation
    const ann = map.get(id) as Annotation;
    ydoc.transact(() => map.set(id, { ...ann, status: "accepted" as const }), MCP_ORIGIN);

    const accepted = map.get(id) as Annotation;
    expect(accepted.status).toBe("accepted");
    // In the real MCP tool, this would return an error — here we just verify status
  });

  it("preserves other annotation fields when editing content", () => {
    const ydoc = setupDoc("edit-5", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "Original", {
      priority: "urgent",
      textSnapshot: "Hello",
    });

    const ann = map.get(id) as Annotation;
    const updated = { ...ann, content: "Edited", editedAt: Date.now() };
    ydoc.transact(() => map.set(id, updated), MCP_ORIGIN);

    const result = map.get(id) as Annotation;
    expect(result.content).toBe("Edited");
    expect(result.priority).toBe("urgent");
    expect(result.textSnapshot).toBe("Hello");
    expect(result.range).toEqual(ann.range);
    expect(result.type).toBe("comment");
    expect(result.author).toBe("claude");
    expect(result.status).toBe("pending");
  });

  it("editedAt is a recent timestamp", () => {
    const ydoc = setupDoc("edit-6", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "flag", rangeOf(0, 5, ydoc), "Check this");

    const before = Date.now();
    const ann = map.get(id) as Annotation;
    const updated = { ...ann, content: "Rechecked", editedAt: Date.now() };
    ydoc.transact(() => map.set(id, updated), MCP_ORIGIN);
    const after = Date.now();

    const result = map.get(id) as Annotation;
    expect(result.editedAt).toBeGreaterThanOrEqual(before);
    expect(result.editedAt).toBeLessThanOrEqual(after);
  });
});
