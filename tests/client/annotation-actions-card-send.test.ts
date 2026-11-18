/**
 * The send notice's seam (#1123, the brief "the send notice", R1): a card send
 * raises once, after its write, and nothing about the raise can change the
 * write. Flag-free: the seam is a spy, so this file holds in both flag states.
 *
 * Runs in the client project's happy-dom environment; nothing here needs a
 * DOM, and the node suites that import `annotation-actions.ts` are pinned by
 * the source pin below instead.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  promoteNotesToComments,
  sendNoteToClaude,
} from "../../src/client/panels/annotation-actions.js";
import { setCardSendRaise } from "../../src/client/panels/card-send-raise.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeImportNote } from "../helpers/ydoc-factory.js";

function seeded(seed: Record<string, unknown>): { doc: Y.Doc; map: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const map = getAnnotationsMap(doc);
  doc.transact(() => {
    for (const [id, ann] of Object.entries(seed)) map.set(id, ann);
  }, "seed");
  return { doc, map };
}

const note = (id: string) => makeImportNote({ id });
const comment = (id: string) => ({ ...makeImportNote({ id }), type: "comment", author: "user" });

afterEach(() => {
  // R1.4: every case leaves the seam unset.
  setCardSendRaise(null);
  vi.restoreAllMocks();
});

describe("sendNoteToClaude raises once when it promoted a note (R1.2)", () => {
  it("a promoted note: one raise", () => {
    const raise = vi.fn();
    setCardSendRaise(raise);
    const { doc, map } = seeded({ n1: note("n1") });
    sendNoteToClaude(doc, "n1");
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith();
    expect((map.get("n1") as Annotation).type).toBe("comment");
  });

  it("a comment id, a missing id, a null doc: no raise", () => {
    const raise = vi.fn();
    setCardSendRaise(raise);
    const { doc } = seeded({ c1: comment("c1") });
    sendNoteToClaude(doc, "c1");
    sendNoteToClaude(doc, "missing");
    sendNoteToClaude(null, "c1");
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("promoteNotesToComments raises once per call that promoted (R1.2)", () => {
  it("two notes, a comment and a missing id: one raise, returns 2", () => {
    const raise = vi.fn();
    setCardSendRaise(raise);
    const { doc } = seeded({ n1: note("n1"), n2: note("n2"), c1: comment("c1") });
    expect(promoteNotesToComments(doc, ["n1", "c1", "missing", "n2"])).toBe(2);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it("[] and a list with no note: no raise", () => {
    const raise = vi.fn();
    setCardSendRaise(raise);
    const { doc } = seeded({ c1: comment("c1") });
    expect(promoteNotesToComments(doc, [])).toBe(0);
    expect(promoteNotesToComments(doc, ["c1", "missing"])).toBe(0);
    expect(promoteNotesToComments(null, ["c1"])).toBe(0);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("the raise comes after the transact returns (R1.2)", () => {
  for (const [name, send] of [
    ["sendNoteToClaude", (doc: Y.Doc) => sendNoteToClaude(doc, "n1")],
    ["promoteNotesToComments", (doc: Y.Doc) => promoteNotesToComments(doc, ["n1"])],
  ] as const) {
    it(`${name}: ["tx", "raise"]`, () => {
      const order: string[] = [];
      const { doc } = seeded({ n1: note("n1") });
      doc.on("afterTransaction", () => order.push("tx"));
      setCardSendRaise(() => order.push("raise"));
      send(doc);
      expect(order).toEqual(["tx", "raise"]);
    });
  }
});

describe("a throwing raise is caught (R1.3, Ruling SN-6)", () => {
  it("sendNoteToClaude: the comment stands, nothing thrown, logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setCardSendRaise(() => {
      throw new Error("boom");
    });
    const { doc, map } = seeded({ n1: note("n1") });
    expect(() => sendNoteToClaude(doc, "n1")).not.toThrow();
    expect((map.get("n1") as Annotation).type).toBe("comment");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("promoteNotesToComments: the count returned, the comments in the map, nothing thrown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setCardSendRaise(() => {
      throw new Error("boom");
    });
    const { doc, map } = seeded({ n1: note("n1"), n2: note("n2") });
    let count = -1;
    expect(() => {
      count = promoteNotesToComments(doc, ["n1", "n2"]);
    }).not.toThrow();
    expect(count).toBe(2);
    expect((map.get("n1") as Annotation).type).toBe("comment");
    expect((map.get("n2") as Annotation).type).toBe("comment");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("unset: master's behaviour, no raise and nothing logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { doc, map } = seeded({ n1: note("n1") });
    sendNoteToClaude(doc, "n1");
    expect((map.get("n1") as Annotation).type).toBe("comment");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the seam's imports (R1.1, source pin)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  /** Every static `import … from` / `export … from` statement, multi-line included. */
  const statements = (src: string) =>
    [...src.matchAll(/^(import|export)\b([^;]*?)\bfrom\s+["']([^"']+)["'];?/gms)].map((m) => ({
      kind: m[1] as string,
      typeOnly: /^\s*type\b/.test(m[2] as string),
      spec: m[3] as string,
    }));

  it("the seam module has only `import type` statements, and only from src/shared/", () => {
    const src = read("src/client/panels/card-send-raise.ts");
    for (const s of statements(src)) {
      expect(s.kind, s.spec).toBe("import");
      expect(s.typeOnly, s.spec).toBe(true);
      expect(s.spec.startsWith("../../shared/"), s.spec).toBe(true);
    }
    // No side-effect import, dynamic import or require.
    expect(src).not.toMatch(/^\s*import\s+["']/m);
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it("annotation-actions.ts imports master's modules plus the seam, and re-exports nothing", () => {
    const src = read("src/client/panels/annotation-actions.ts");
    expect(statements(src).map((s) => `${s.kind} ${s.spec}`)).toEqual([
      "import yjs",
      "import ../../shared/api-paths",
      "import ../../shared/constants",
      "import ../../shared/origins",
      "import ../../shared/sanitize",
      "import ../../shared/types",
      "import ../utils/fileUpload",
      "import ./card-send-raise",
    ]);
    // The seam is imported for its raise only, and never re-exported (the
    // license-off panels test hand-stubs this module's exports).
    expect(src).toMatch(/^import \{ raiseCardSend \} from "\.\/card-send-raise";$/m);
    expect(src).not.toMatch(/^export\s*(\{[^}]*\}|\*)\s*from/m);
    expect(src).not.toMatch(/setCardSendRaise/);
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});
