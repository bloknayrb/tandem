import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { collectAnnotations } from "../../src/server/mcp/annotations.js";
import { processInboxAnnotations, resetInbox } from "../../src/server/mcp/awareness.js";
import { extractText, populateYDoc } from "../../src/server/mcp/document.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { range } from "../helpers/positions.js";

let doc: Y.Doc;
const DOC_HASH = "sha256:awareness-test";

function makeDoc(text: string): Y.Doc {
  doc = new Y.Doc();
  populateYDoc(doc, text);
  return doc;
}

function addAnnotation(map: Y.Map<unknown>, overrides: Partial<Annotation>): Annotation {
  // `Partial<Annotation>` distributes over the discriminated union, so the
  // spread's inferred type is a combinatorial mix of the three members'
  // optional fields rather than one coherent member — the cast reflects that
  // callers only ever pass a coherent override set for whatever `type` they choose.
  const ann = {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    author: "user",
    type: "highlight",
    range: range(0, 5),
    content: "",
    status: "pending",
    timestamp: Date.now(),
    ...overrides,
  } as Annotation;
  map.set(ann.id, ann);
  return ann;
}

beforeEach(() => {
  resetInbox();
});

afterEach(() => {
  doc?.destroy();
});

describe("tandem_checkInbox logic", () => {
  // These tests verify the inbox logic directly since we can't easily call MCP tools in unit tests.
  // The logic is: collect annotations, split by author/status, dedup via surfacedIds.

  it("surfaces new user annotations", () => {
    makeDoc("Hello world test");
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    addAnnotation(map, {
      author: "user",
      type: "highlight",
      range: range(0, 5),
    });
    addAnnotation(map, {
      author: "user",
      type: "comment",
      range: range(6, 11),
      content: "Nice",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const userActions = allAnns.filter((a) => a.author === "user");

    expect(userActions.length).toBe(2);
    expect(userActions.find((a) => a.type === "highlight")).toBeTruthy();
    expect(userActions.find((a) => a.type === "comment")).toBeTruthy();
  });

  it("surfaces user responses to Claude annotations", () => {
    makeDoc("Hello world");
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    addAnnotation(map, {
      author: "claude",
      type: "comment",
      status: "accepted",
      suggestedText: "replacement",
    });
    addAnnotation(map, { author: "claude", type: "comment", status: "dismissed" });
    addAnnotation(map, { author: "claude", type: "highlight", status: "pending" }); // Still pending, not a response

    const allAnns = collectAnnotations(map, DOC_HASH);
    const responses = allAnns.filter((a) => a.author === "claude" && a.status !== "pending");

    expect(responses.length).toBe(2);
  });

  it("comment annotation surfaces in userActions", () => {
    makeDoc("Hello world");
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    addAnnotation(map, {
      author: "user",
      type: "comment",
      range: range(0, 5),
      content: "What does this mean?",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const userComments = allAnns.filter((a) => a.author === "user" && a.type === "comment");

    expect(userComments.length).toBe(1);
    expect(userComments[0].content).toBe("What does this mean?");
    expect(userComments[0].author).toBe("user");
  });

  it("text snippets can be extracted for annotation ranges", () => {
    makeDoc("The quick brown fox jumps over the lazy dog");
    const fullText = extractText(doc);

    // Simulate snippet extraction (same logic as tandem_checkInbox)
    const snippet = fullText.slice(
      Math.max(0, Math.min(4, fullText.length)),
      Math.max(4, Math.min(9, fullText.length)),
    );

    expect(snippet).toBe("quick");
  });
});

describe("surfacedIds deduplication", () => {
  // The inbox uses a ledger keyed by document + annotation id to track which
  // records have been returned.

  it("a surfaced comment does not come back until the ledger is cleared", () => {
    // The module-private ledger `resetInbox()` clears is unreachable from here,
    // so this asserts the dedup property the describe claims through the
    // exported `processInboxAnnotations` with a caller-owned Map instead.
    //
    // `type: "comment"` matters: the fixture default is `highlight`, and the
    // userActions bucket is gated on `author === "user" && type === "comment"`.
    // `modeState` must be `"tandem"` — `"indeterminate"` is not fail-closed and
    // `"solo"` hides the record for an unrelated reason.
    const map = makeDoc("Hello world test").getMap(Y_MAP_ANNOTATIONS);
    const ann = addAnnotation(map, {
      author: "user",
      type: "comment",
      range: range(0, 5),
      content: "Why this word?",
    });
    const text = extractText(doc);
    const ledger = new Map<string, number>();
    const run = () =>
      processInboxAnnotations(
        [ann],
        text,
        ledger,
        (anns) => anns,
        "doc1",
        "tandem",
        () => false,
      );

    expect(run().userActions.map((a) => a.id)).toEqual([ann.id]);
    expect(run().userActions).toEqual([]);
    ledger.clear();
    expect(run().userActions.map((a) => a.id)).toEqual([ann.id]);
  });
});
