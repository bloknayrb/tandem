import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { acceptPending, dismissPending } from "../../src/server/annotations/lifecycle.js";
import { exportAnnotations } from "../../src/server/file-io/docx.js";
import {
  collectAnnotations,
  refreshRange,
  registerAnnotationTools,
} from "../../src/server/mcp/annotations.js";
import { extractText, verifyAndResolveRange } from "../../src/server/mcp/document.js";
import { hideFromAI, readModeState } from "../../src/server/mode.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATIONS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { unanchored } from "../helpers/positions.js";
import { createAnnotation, noRelay, rangeOf } from "../helpers/ydoc-factory.js";

const DOC_HASH = "sha256:annotation-tools";

beforeEach(() => {
  clearOpenDocs();
});

describe("createAnnotation supports highlight type for editor-created highlights", () => {
  it("createAnnotation still supports highlight type for user-created highlights", () => {
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

    for (const color of ["yellow", "green", "blue", "pink"] as const) {
      const id = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "", {
        color,
      });
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

describe("tandem_comment with suggestedText", () => {
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

describe("tandem_note tool logic (via createAnnotation)", () => {
  it("creates note annotation", () => {
    const ydoc = setupDoc("nt-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "Needs review");

    const stored = map.get(id) as Annotation;
    expect(stored.type).toBe("note");
    expect(stored.content).toBe("Needs review");
  });

  it("note with no content has empty content", () => {
    const ydoc = setupDoc("nt-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "");

    const stored = map.get(id) as Annotation;
    expect(stored.content).toBe("");
  });
});

/**
 * #2048 — these rows used to call `collectAnnotations` and then `.filter()` in
 * the test, asserting the test's own model of the filter and never calling a
 * registered handler. They now drive `tandem_getAnnotations` through the
 * in-memory harness.
 *
 * **Four rows changed meaning, and that is the point rather than a regression.**
 * The hand-rolled version filtered the RAW collection, so it counted a record
 * the tool has never returned: the user highlight. `mintAnnotation` hardcodes
 * `audience: "outbound"` and `audience` is a lifecycle-owned field, so a fixture
 * cannot set it — the highlight is stored outbound and demoted to `private` by
 * `sanitizeAnnotation` on read, and `isClaudeFacing` then excludes it. So
 * unfiltered is 3 and not 4, `author: "user"` is 0 and not 1, `status:
 * "pending"` is 2 and not 3, and `type: "highlight"` returns nothing for this
 * fixture's user-authored highlight. Those are the ADR-027 / #1619 / #1710
 * rules this describe appeared to cover and did not.
 */
describe("tandem_getAnnotations tool logic", () => {
  let client: Client;
  let close: (() => Promise<void>) | undefined;

  function populateAnnotations(ydoc: Y.Doc) {
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment 1", {
      author: "claude",
    });
    createAnnotation(map, ydoc, "highlight", unanchored(0, 5), "", {
      author: "user",
      color: "yellow",
    });
    createAnnotation(map, ydoc, "comment", rangeOf(6, 11, ydoc), "", {
      author: "claude",
      suggestedText: "x",
    });
    // One accepted. Written through `withInternal` rather than a bare
    // `map.set`: the sibling resolve describe records its hand-written
    // `map.set` calls as untagged raw writes removed for Critical Rule 2, and
    // the real `acceptPending` cannot stand in here — since #1770 it refuses to
    // accept a CLAUDE-authored record, which is exactly what this fixture needs.
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "old comment", {
      author: "claude",
    });
    const ann = map.get(id) as Annotation;
    withInternal(ydoc, () => map.set(id, { ...ann, status: "accepted" }));
    return map;
  }

  /** The tool's payload, unwrapped from the `{ ok, data }` text envelope. */
  async function getAnnotations(args: Record<string, unknown> = {}) {
    const envelope = parseResult(
      await client.callTool({ name: "tandem_getAnnotations", arguments: args }),
    );
    return envelope.data;
  }

  beforeEach(async () => {
    // The Solo hold is one of this tool's filters. Say which mode we are in
    // rather than relying on `indeterminate` happening to let these through.
    setCtrlMode("tandem");
    ({ client, close } = await setupMcpServer([registerAnnotationTools]));
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    setCtrlMode(null);
  });

  it("returns every Claude-facing annotation and discloses the private one", async () => {
    const ydoc = setupDoc("ga-1", "Hello world test");
    populateAnnotations(ydoc);

    const res = await getAnnotations();

    expect(res.annotations).toHaveLength(3);
    expect(res.count).toBe(3);
    // The user highlight — disclosed, not silently dropped (#1619/#1710).
    expect(res.privateExcluded).toBe(1);
    // No notes in this fixture, and the counter is omitted when zero.
    expect(res.notesExcluded).toBeUndefined();
  });

  it("filters by author, and a user filter returns only Claude-facing records", async () => {
    const ydoc = setupDoc("ga-2", "Hello world test");
    populateAnnotations(ydoc);

    expect((await getAnnotations({ author: "claude" })).count).toBe(3);

    // The fixture's only user-authored record is a highlight, which is private
    // by construction — so this is 0, where the hand-rolled version said 1.
    const user = await getAnnotations({ author: "user" });
    expect(user.count).toBe(0);
    expect(user.privateExcluded).toBe(1);
  });

  it("filters by type, and a highlight filter returns nothing", async () => {
    const ydoc = setupDoc("ga-3", "Hello world test");
    populateAnnotations(ydoc);

    expect((await getAnnotations({ type: "comment" })).count).toBe(3);

    // 0 because this fixture's only highlight is USER-authored, hence private.
    // The tool's description puts it more strongly — `type: "highlight"`
    // "always returns nothing" — but the code is narrower than its own prose:
    // `isClaudeFacing` admits a CLAUDE-authored outbound highlight, and
    // `read-audience-filter.test.ts` pins one being returned (#1710 row 2, the
    // shape of the tutorial's first card). This row asserts the fixture's case,
    // not the description's absolute.
    const highlights = await getAnnotations({ type: "highlight" });
    expect(highlights.count).toBe(0);
    expect(highlights.privateExcluded).toBe(1);
  });

  it("surfaces suggestedText on the record that carries it", async () => {
    const ydoc = setupDoc("ga-4", "Hello world test");
    populateAnnotations(ydoc);

    // Deliberately a property of the RESPONSE, not a filter: there is no
    // `suggestedText` tool parameter, so the hand-rolled row that filtered on it
    // was testing nothing the tool does.
    const res = await getAnnotations();
    const withSuggestion = res.annotations.filter((a: Annotation) => a.suggestedText !== undefined);
    expect(withSuggestion).toHaveLength(1);
    expect(withSuggestion[0].suggestedText).toBe("x");
  });

  it("filters by status", async () => {
    const ydoc = setupDoc("ga-5", "Hello world test");
    populateAnnotations(ydoc);

    // 2, not 3: the third pending record is the private highlight.
    expect((await getAnnotations({ status: "pending" })).count).toBe(2);
    expect((await getAnnotations({ status: "accepted" })).count).toBe(1);
  });

  it("compound filter: author + status", async () => {
    const ydoc = setupDoc("ga-6", "Hello world test");
    populateAnnotations(ydoc);

    expect((await getAnnotations({ author: "claude", status: "pending" })).count).toBe(2);
  });
});

describe("tandem_resolveAnnotation tool logic", () => {
  // **These two hand-wrote `map.set({...ann, status})` and then asserted their
  // own write**, so deleting `transitionPending` outright left them green under
  // exactly the title someone searching for resolve coverage would find. They
  // now drive the real functions. (The hand `map.set` calls were also untagged
  // raw writes — Critical Rule 2 hygiene, gone with them.)
  it.each([
    ["accepts", acceptPending, "accepted"],
    ["dismisses", dismissPending, "dismissed"],
  ])("%s an annotation", (_label, op, want) => {
    const ydoc = setupDoc(`ra-${want}`, "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // USER-authored since #1770: accept is the user's decision, so
    // `transitionPending` refuses an accept of a CLAUDE-authored record.
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "review me", {
      author: "user",
    });

    const result = op(id, ydoc, map, noRelay);

    expect(result.kind).toBe("ok");
    expect((map.get(id) as Annotation).status).toBe(want);
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
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "to remove");

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

    const annotations = collectAnnotations(map, DOC_HASH);
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

    const annotations = collectAnnotations(map, DOC_HASH);
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
    if (!result.valid && !result.gone) {
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
    expect(refreshed.annotation.range.from).toBe(9);
    expect(refreshed.annotation.range.to).toBe(14);
  });

  it("annotations without relRange get it lazily attached", () => {
    const ydoc = setupDoc("crdt-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "note"); // no ydoc in rangeOf

    const ann = map.get(id) as Annotation;
    expect(ann.relRange).toBeUndefined();

    const refreshed = refreshRange(ann, ydoc, map);
    expect(refreshed.annotation.relRange).toBeDefined();
  });
});

describe("annotation on multi-document", () => {
  it("annotations are per-document", () => {
    const ydoc1 = setupDoc("md-1", "Doc one");
    const ydoc2 = setupDoc("md-2", "Doc two");

    const map1 = ydoc1.getMap(Y_MAP_ANNOTATIONS);
    const map2 = ydoc2.getMap(Y_MAP_ANNOTATIONS);

    createAnnotation(map1, ydoc1, "comment", unanchored(0, 3), "on doc 1");
    createAnnotation(map2, ydoc2, "highlight", unanchored(0, 3), "", { color: "yellow" });

    expect(collectAnnotations(map1, DOC_HASH)).toHaveLength(1);
    expect(collectAnnotations(map2, DOC_HASH)).toHaveLength(1);
    expect(collectAnnotations(map1, DOC_HASH)[0].type).toBe("comment");
    expect(collectAnnotations(map2, DOC_HASH)[0].type).toBe("highlight");
  });
});

// ── tandem_exportAnnotations + WS-A2 Solo hold ──────────────────────────────
//
// The export was the one Claude-facing egress with no Solo gate. The exemption
// was documented as deliberate ("an export is an explicit give-Claude-everything
// action") on a premise that is false by construction: there is no user-invocable
// path to this tool, so the only actor who can perform that "explicit user
// action" is Claude. Meanwhile the editor showed an amber Held pill telling the
// user those items were being withheld.
describe("tandem_exportAnnotations — Solo hold", () => {
  const seedDoc = (id: string) => setupDoc(id, "Hello world for export");

  function setMode(mode: string) {
    getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode);
  }

  afterEach(() => {
    getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE);
  });

  it("withholds user annotations in Solo and DISCLOSES the count", () => {
    const ydoc = seedDoc("export-solo");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", unanchored(0, 5), "user note", { author: "user" });
    setMode("solo");

    const all = collectAnnotations(map, "sha256:export-solo");
    const modeState = readModeState();
    const exportable = all
      .filter((a) => a.type !== "note")
      .filter((a) => !hideFromAI(a, modeState));

    expect(exportable).toHaveLength(0);
    // The disclosure is the whole point: a bare filter would leave the caller
    // reporting "no annotations" for a document that has one.
    expect(all.filter((a) => a.type !== "note").length - exportable.length).toBe(1);
  });

  // The empty-case string must not assert completeness it doesn't have.
  it("never claims 'no annotations found' when items were withheld", () => {
    const ydoc = seedDoc("export-empty");
    const markdown = exportAnnotations(ydoc, []);
    expect(markdown).not.toMatch(/No annotations found/i);
    expect(markdown).toMatch(/No annotations available for export/i);
  });

  // Fail-closed on indeterminate (post-restart, mode unknown) — hides only the
  // records carrying the persisted marker, matching every other surface.
  it("in indeterminate mode withholds only persisted heldInSolo records", () => {
    const ydoc = seedDoc("export-indet");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const plainId = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "plain", {
      author: "user",
    });
    const heldId = createAnnotation(map, ydoc, "comment", unanchored(6, 11), "held", {
      author: "user",
    });
    const held = map.get(heldId) as Annotation;
    map.set(heldId, { ...held, heldInSolo: true });

    const all = collectAnnotations(map, "sha256:export-indet");
    const modeState = readModeState(); // no mode key set → indeterminate
    const exportable = all.filter((a) => !hideFromAI(a, modeState));
    const ids = exportable.map((a) => a.id);

    expect(ids).toContain(plainId);
    expect(ids).not.toContain(heldId);
  });
});
