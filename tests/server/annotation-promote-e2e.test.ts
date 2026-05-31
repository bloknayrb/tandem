/**
 * AR5 import→promote→visible integration test (the deterministic realization of
 * the v1.0 soak gate: ".docx batch-promote tested end-to-end with reviewer
 * comments"). Exercises the real chain in-process without a binary fixture:
 *
 *   htmlToYDoc (mirrors the production mammoth→HTML docx builder)
 *     → injectCommentsAsAnnotations (real import path, withInternal)
 *     → privacy assertions (private notes, no channel emit)
 *     → promoteNotesToComments (real promote helper, withBrowser)
 *     → visibility assertions (channel emit + outbound comment shape)
 *
 * NOTE on coverage scope: building the doc via `htmlToYDoc` covers offset
 * alignment against the HTML→Y.Doc builder, NOT mammoth's .docx→HTML step —
 * that final hop is what the Playwright `.docx` E2E (AR5-T4) would cover.
 *
 * Anti-tautology: `injectCommentsAsAnnotations` calls `anchoredRange` WITHOUT a
 * textSnapshot, so `validateRange` only rejects from>to — an out-of-range
 * offset clamps silently and still "injects". We therefore (a) derive offsets
 * via indexOf against `extractText` on the same doc and (b) assert each range
 * slices back to its anchor text and its CRDT relRange round-trips.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { promoteNotesToComments } from "../../src/client/panels/annotation-actions.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import {
  type DocxComment,
  injectCommentsAsAnnotations,
} from "../../src/server/file-io/docx-comments.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { relPosToFlatOffset } from "../../src/server/positions.js";
import type { Annotation } from "../../src/shared/types.js";
import { collectEvents } from "../helpers/event-collector.js";
import { getAnnotationsMap } from "../helpers/ydoc-factory.js";

// Plain body anchors (never a heading line, never crossing a `\n`).
const ANCHORS = ["simplify the onboarding flow", "dashboard needs a refresh"] as const;
const HTML =
  "<h2>Project Overview</h2>" +
  "<p>We should simplify the onboarding flow for new users.</p>" +
  "<p>The dashboard needs a refresh before launch.</p>";

function buildComments(flat: string): DocxComment[] {
  return ANCHORS.map((anchor, i) => {
    const from = flat.indexOf(anchor);
    if (from < 0) throw new Error(`anchor not found in flat text: "${anchor}"`);
    return {
      commentId: `c${i + 1}`,
      authorName: `Reviewer ${i + 1}`,
      bodyText: `Please revisit: ${anchor}`,
      from: from as Annotation["range"]["from"],
      to: (from + anchor.length) as Annotation["range"]["to"],
    };
  });
}

function getImports(doc: Y.Doc): Annotation[] {
  return (Array.from(getAnnotationsMap(doc).values()) as Annotation[]).filter(
    (a) => a.author === "import" || a.promotedFrom === "note",
  );
}

describe("AR5 import → promote → Claude-visible (integration)", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    htmlToYDoc(doc, HTML);
    attachObservers("e2e-doc", doc);
  });

  afterEach(() => {
    detachObservers("e2e-doc");
    doc.destroy();
    resetForTesting();
  });

  it("imports as private notes, then promotes to Claude-visible comments", () => {
    const { events, cleanup } = collectEvents();

    // --- Import phase ---
    const flat = extractText(doc); // doc content is unchanged by import (writes go to the annotations map)
    const comments = buildComments(flat);
    const injected = injectCommentsAsAnnotations(doc, comments, "review.docx");
    expect(injected).toBe(comments.length);

    const imports = getImports(doc);
    expect(imports).toHaveLength(comments.length);

    for (const anchor of ANCHORS) {
      const ann = imports.find((a) => a.content.includes(anchor));
      expect(ann, `import for "${anchor}"`).toBeDefined();
      if (!ann) continue;
      // Privacy shape.
      expect(ann.author).toBe("import");
      expect(ann.type).toBe("note");
      expect(ann.audience).toBe("private");
      // Anti-tautology: range slices back to the anchor (offsets were correct).
      expect(flat.slice(ann.range.from, ann.range.to)).toBe(anchor);
      // CRDT anchoring survived (fullyAnchored) and agrees with the flat fallback.
      expect(ann.relRange, `relRange for "${anchor}"`).toBeDefined();
      if (ann.relRange) {
        expect(relPosToFlatOffset(doc, ann.relRange.fromRel)).toBe(ann.range.from);
        expect(relPosToFlatOffset(doc, ann.relRange.toRel)).toBe(ann.range.to);
      }
    }

    // Import path is withInternal → channel-skipped: nothing surfaced to Claude.
    expect(events).toHaveLength(0);

    // --- Promote phase ---
    const ids = imports.map((a) => a.id);
    const promoted = promoteNotesToComments(doc, ids);
    expect(promoted).toBe(ids.length);

    // Channel visibility (gate keys on author/type + note predecessor).
    const created = events.filter((e) => e.type === "annotation:created");
    expect(created).toHaveLength(ids.length);
    expect(created.every((e) => e.payload.annotationType === "comment")).toBe(true);

    // Stored shape: channel surface (author/type) AND MCP-read surface (audience/type≠note).
    const after = Array.from(getAnnotationsMap(doc).values()) as Annotation[];
    for (const ann of after) {
      expect(ann.type).toBe("comment");
      expect(ann.author).toBe("user");
      expect(ann.audience).toBe("outbound");
      expect(ann.promotedFrom).toBe("note");
    }

    cleanup();
  });
});
