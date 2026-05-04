import { describe, expect, it } from "vitest";
import { toggleHighlight } from "../../src/client/editor/toolbar/highlight-toggle";
import { getAnnotationsMap, makeAnnotation, makeEmptyDoc } from "../helpers/ydoc-factory";

const RANGE = { from: 0, to: 10 };
const OTHER_RANGE = { from: 20, to: 30 };

describe("toggleHighlight", () => {
  it("empty map — inserts a new annotation, returns 'added'", () => {
    const doc = makeEmptyDoc();
    const result = toggleHighlight(doc, RANGE, "yellow");
    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(1);
    const ann = [...getAnnotationsMap(doc).values()][0] as ReturnType<typeof makeAnnotation>;
    expect(ann.type).toBe("highlight");
    expect(ann.color).toBe("yellow");
    expect(ann.author).toBe("user");
    expect(ann.status).toBe("pending");
    expect(ann.content).toBe("");
  });

  it("same range + same color + pending + empty content — removes highlight, returns 'removed'", () => {
    const doc = makeEmptyDoc();
    // Insert a matching highlight manually
    const existing = makeAnnotation({
      id: "ann_existing",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "yellow",
      content: "",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_existing", existing);
    expect(getAnnotationsMap(doc).size).toBe(1);

    const result = toggleHighlight(doc, RANGE, "yellow");
    expect(result).toBe("removed");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });

  it("same range + different color — recolors, returns 'recolored', exactly 1 annotation with new color", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_existing",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "yellow",
      content: "",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_existing", existing);

    const result = toggleHighlight(doc, RANGE, "blue");
    expect(result).toBe("recolored");
    expect(getAnnotationsMap(doc).size).toBe(1);
    const ann = [...getAnnotationsMap(doc).values()][0] as ReturnType<typeof makeAnnotation>;
    expect(ann.color).toBe("blue");
    expect(ann.id).not.toBe("ann_existing");
  });

  it("different ranges — both kept, returns 'added'", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_existing",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "yellow",
      content: "",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_existing", existing);

    const result = toggleHighlight(doc, OTHER_RANGE, "yellow");
    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(2);
  });

  it("status guard: accepted highlight at same range+color — not removed, returns 'added', count = 2", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_accepted",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "yellow",
      content: "",
      status: "accepted",
    });
    getAnnotationsMap(doc).set("ann_accepted", existing);

    const result = toggleHighlight(doc, RANGE, "yellow");
    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(2);
  });

  it("status guard: dismissed highlight at same range+color — not removed, returns 'added', count = 2", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_dismissed",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "yellow",
      content: "",
      status: "dismissed",
    });
    getAnnotationsMap(doc).set("ann_dismissed", existing);

    const result = toggleHighlight(doc, RANGE, "yellow");
    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(2);
  });

  it("content guard: highlight with non-empty content — not deleted, returns 'added', count = 2", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_edited",
      author: "user",
      type: "highlight",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      color: "yellow",
      content: "some note",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_edited", existing);

    const result = toggleHighlight(doc, RANGE, "yellow");
    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(2);
  });

  it("author guard: Claude annotation at same range — not deleted, returns 'added'", () => {
    const doc = makeEmptyDoc();
    const existing = makeAnnotation({
      id: "ann_claude",
      author: "claude",
      type: "comment",
      range: RANGE as ReturnType<typeof makeAnnotation>["range"],
      content: "Claude comment",
      status: "pending",
    });
    getAnnotationsMap(doc).set("ann_claude", existing);

    const result = toggleHighlight(doc, RANGE, "yellow");
    expect(result).toBe("added");
    expect(getAnnotationsMap(doc).size).toBe(2);
  });
});
