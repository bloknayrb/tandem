/**
 * Covers the atomicity concern for the "recolor" path in toggleHighlight.
 *
 * The recolor scenario wraps delete + set in a single ydoc.transact() call so
 * the Y.Map observer sees one event rather than two separate add/delete events.
 * This test verifies the Y.Map ends up with exactly one entry and no phantom
 * second annotation after a recolor operation.
 */
import { describe, expect, it } from "vitest";
import { toggleHighlight } from "../../src/client/editor/toolbar/highlight-toggle";
import { getAnnotationsMap, makeAnnotation, makeEmptyDoc } from "../helpers/ydoc-factory";

const RANGE = { from: 5, to: 15 };

describe("toggleHighlight — transaction atomicity (recolor)", () => {
  it("recolor leaves exactly one annotation, old entry gone, new entry has new color", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_recolor_test",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "green",
      content: "",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_recolor_test", existing);

    // Track observer events to confirm a single transaction fires one event.
    const events: string[] = [];
    getAnnotationsMap(doc).observe((evt) => {
      events.push(`keys:${[...evt.keysChanged].sort().join(",")}`);
    });

    const result = toggleHighlight(doc, RANGE, "pink");

    expect(result).toBe("recolored");
    // Exactly one annotation remains.
    expect(getAnnotationsMap(doc).size).toBe(1);

    const entries = [...getAnnotationsMap(doc).entries()];
    const [newKey, newAnn] = entries[0];
    // Old key is gone.
    expect(newKey).not.toBe("ann_recolor_test");
    // New annotation has the requested color.
    expect((newAnn as ReturnType<typeof makeAnnotation>).color).toBe("pink");
    expect((newAnn as ReturnType<typeof makeAnnotation>).author).toBe("user");
    expect((newAnn as ReturnType<typeof makeAnnotation>).status).toBe("pending");

    // The transact() wrapper fires the observer once with both changed keys.
    expect(events).toHaveLength(1);
    // Both old and new key appear in the single event's keysChanged set.
    expect(events[0]).toContain("ann_recolor_test");
  });

  it("add path does not wrap in a transaction but still results in exactly one new annotation", () => {
    const doc = makeEmptyDoc();

    const result = toggleHighlight(doc, RANGE, "yellow");

    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(1);
    const ann = [...getAnnotationsMap(doc).values()][0] as ReturnType<typeof makeAnnotation>;
    expect(ann.color).toBe("yellow");
  });

  it("remove path leaves map empty", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_to_remove",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "blue",
      content: "",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_to_remove", existing);

    const result = toggleHighlight(doc, RANGE, "blue");

    expect(result).toBe("removed");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });
});
