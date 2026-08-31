/**
 * What `YDocStore` and `AnnotationLifecycle` expose, as a census rather than as
 * prose (ADR-035 Unit 8j-2).
 *
 * **WHY THIS EXISTS.** Unit 8's instruction ends "remove raw `ydoc` and
 * `transactMcp` escape hatches". Removing them is a diff; keeping them removed
 * is this file. A `readonly ydoc` re-added to the store hands any handler the
 * raw `Y.Doc` — every origin tag, every range invariant and every ADR-027 gate
 * below the seam becomes optional at that point, and nothing else in the suite
 * would say a word: `audit:origins` cannot follow a write reached through a
 * helper, and the license-gate walk is scoped to registration sites.
 *
 * **Both surfaces are pinned, because pinning one is defeated for free.**
 * `readonly lifecycle` is public on the store and stays public. Adding
 * `getRawDoc(): Y.Doc` to `AnnotationLifecycle` reopens the hatch as
 * `store.lifecycle.getRawDoc()` while the store's own member list is untouched —
 * and it slips past `annotation-create-seam-census.test.ts` too, which pins
 * `lifecycle.ts`'s exported NAMES, not that interface's members. Review
 * constructed that defeat against this unit's plan.
 *
 * **What these pins do NOT claim.** They do not make the raw `Y.Doc`
 * unreachable from `src/server/mcp/`. `requireDocument` (`documents/registry.ts`,
 * re-exported by `document-service.ts`) returns `{ doc: Y.Doc }` to seven call
 * sites in `document.ts` and one in `docx-apply.ts`, and always has. Those
 * writes are correctly `withMcp`-tagged today — a sweep finds zero raw
 * `.transact(` anywhere in `src/` — but by discipline, exactly as this store's
 * hatch was. An earlier draft of this unit proposed pinning the importer set of
 * `getOrCreateDocument` within `src/server/mcp/` and calling that closure; it
 * would have been **false on day one** (that symbol has ~11 importers there,
 * most of them unrelated `CTRL_ROOM` and document-lifecycle lookups) and
 * defeated three ways besides — an alias in `provider.ts`, `requireDocument`,
 * and `(store as any).map.doc`. The third is why the store's fields are
 * `#private`: that one is closed by the compiler, not by a test.
 */

import { describe, expect, it } from "vitest";
import { SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * Read a `src/` file from the SHARED cache, never from disk.
 *
 * `SRC_FILES` is one `readdirSync` walk per worker, and its own header records
 * why: a re-read per lookup was measurably enough extra Windows filesystem
 * contention to push two suites over their timeouts in the full run. The first
 * draft of this file called `readFileSync` inside each `it` — three reads, two
 * of them on the same path — which is the fifth copy of a walk the helper exists
 * to prevent. It also throws on undecodable content, so a mangled file fails
 * loudly here rather than silently matching no members.
 */
function read(rel: string): string {
  const source = SRC_FILES.get(rel);
  if (source === undefined) throw new Error(`${rel} is not in the src/ sweep`);
  return stripComments(source);
}

/**
 * Members declared directly on a `class`/`interface` body.
 *
 * Two-space indentation is the class-body depth in this codebase's formatting,
 * and biome enforces it — a nested member (inside a method, inside an object
 * literal) sits deeper and is correctly not a member of the declaration.
 *
 * **`get x()` is matched deliberately.** A getter is the cheapest way to re-add
 * `ydoc` while a field-shaped regex reports nothing, and the plan named it as a
 * likely blind spot before this pattern existed. The self-test below proves it
 * fires rather than asserting that it does.
 */
function membersOf(body: string): string[] {
  return [
    ...body.matchAll(
      /^ {2}(?:(?:readonly|private|protected|public|static|async|get|set)\s+)*(#?\w+)\s*[(:;<]/gm,
    ),
  ]
    .map((m) => m[1])
    .sort();
}

describe("YDocStore's surface — the escape hatches stay closed", () => {
  it("membersOf sees the forms an offender would actually use", () => {
    // The assertions below are exact lists, and an exact list is satisfied by a
    // parser that reads nothing. Each probe is a shape someone would really
    // write to re-open the hatch, so the pattern is shown to discriminate
    // rather than merely to match.
    expect(membersOf("  readonly ydoc: Y.Doc;")).toStrictEqual(["ydoc"]);
    expect(membersOf("  get ydoc(): Y.Doc {")).toStrictEqual(["ydoc"]);
    expect(membersOf("  transactMcp(fn: () => void): void {")).toStrictEqual(["transactMcp"]);
    expect(membersOf("  private readonly map: Y.Map<unknown>;")).toStrictEqual(["map"]);
    expect(membersOf("  readonly #ydoc: Y.Doc;")).toStrictEqual(["#ydoc"]);
    expect(membersOf("  getRawDoc(): Y.Doc;")).toStrictEqual(["getRawDoc"]);
    // A deeper indent is a nested declaration, not a member of the class.
    expect(membersOf("      const ydoc: Y.Doc = x;")).toStrictEqual([]);
  });

  it("YDocStore exposes exactly these members — no ydoc, no transactMcp", () => {
    const source = read("src/server/mcp/document-store.ts");
    const body = source.slice(
      source.indexOf("export class YDocStore {"),
      source.indexOf("export function getDocumentStore"),
    );
    expect(body, "the class body must be locatable").toContain("constructor(");

    expect(
      membersOf(body),
      "a new member on this store is a decision: add it here on purpose. `ydoc` or `transactMcp` returning is the escape hatch Unit 8j-2 removed.",
    ).toStrictEqual([
      "#map",
      "#ydoc",
      "acceptAnnotation",
      "addReply",
      "anchorRange",
      "captureSnapshot",
      "constructor",
      "dismissAnnotation",
      "docHash",
      "documentId",
      "editAnnotation",
      "exportAnnotationsMarkdown",
      "filePath",
      "getText",
      "getUserAwareness",
      "lifecycle",
      "listAnnotations",
      "listAnnotationsRefreshed",
      "listReplies",
      "onLossy",
      "refreshAnnotations",
      "removeAnnotation",
    ]);
  });

  it("the two fields that hold Y.js values are # — the compiler, not this test", () => {
    // `private` erases at compile time, so `(store as any).ydoc` reaches a
    // `private` field with no error — and Y.js's `AbstractType` exposes a public
    // `doc`, so a `private map` hands back the raw document through
    // `(store as any).map.doc` with NO new member for the pin above to see.
    // `#` fields carry a runtime brand check, which is what makes this
    // structural instead of a convention.
    const source = read("src/server/mcp/document-store.ts");
    expect(source).toContain("readonly #ydoc: Y.Doc;");
    expect(source).toContain("readonly #map: Y.Map<unknown>;");
    expect(source, "a `private` Y.js field is reachable via `as any`").not.toMatch(
      /private\s+readonly\s+\w+\s*:\s*Y\./,
    );
  });

  it("AnnotationLifecycle exposes exactly these members — the store's public seam", () => {
    // Pinned alongside the store because `readonly lifecycle` is public: a
    // `getRawDoc(): Y.Doc` added HERE is reachable as
    // `store.lifecycle.getRawDoc()` while every assertion above stays green.
    const source = read("src/server/annotations/lifecycle.ts");
    const start = source.indexOf("export interface AnnotationLifecycle {");
    expect(start, "the interface must be locatable").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));

    expect(
      membersOf(body),
      "the lifecycle is the seam callers hold — a member returning a Y.Doc or Y.Map re-opens the hatch the store just closed",
    ).toStrictEqual(["accept", "create", "dismiss", "editPending", "remove", "reply"]);
  });
});
