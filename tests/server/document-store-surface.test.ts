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
 * sites in `document.ts`, one in `docx-apply.ts` and four in
 * `local-model/collaborator.ts` (which ships dark), and always has. Those
 * writes are correctly `withMcp`-tagged today — a sweep finds no raw
 * `.transact(` in `src/` outside `shared/origins.ts`, which is where the six
 * helpers are implemented — but by discipline, exactly as this store's hatch
 * was. Tracked as #1700. An earlier draft of this unit proposed pinning the importer set of
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
 * **This pattern was defeated nine ways on its first day, and the fixes are
 * every widening below.** The original required `[(:;<]` immediately after the
 * name, which is a TYPE ANNOTATION or a call — so every shape that puts
 * something else there was invisible, and each one re-opens the hatch verbatim
 * with the member list byte-identical:
 *
 * - `readonly ydoc = this.#ydoc;` and `readonly getRawDoc = () => this.#ydoc;`
 *   — an initializer puts `=` there. The arrow-property form is the most
 *   idiomatic TS field shape after the annotated one.
 * - `readonly ydoc!: Y.Doc;` and `readonly ydoc?: Y.Doc;` — a definite-assignment
 *   or optional marker sits between the name and the colon. `!` is what someone
 *   writes the moment initialization moves out of the constructor, and `ydoc?`
 *   needs no cast at the call site at all: `store.ydoc!`.
 * - `declare readonly ydoc: Y.Doc;` and `accessor ydoc: Y.Doc;` — modifiers the
 *   alternation did not list.
 * - `"ydoc": Y.Doc;` and `["ydoc"]: Y.Doc;` — a string or computed member name
 *   is not `\w+`, and `store.ydoc` still reads it.
 *
 * All eight are in the self-test below, because an exact-list assertion is
 * satisfied by a parser that reads nothing.
 *
 * **The ninth is `static { … }`, and no widening of THIS function catches it** —
 * there is no member name to match. That is what the parse-completeness
 * assertion is for: every line that starts a member must yield exactly one
 * name, so a shape this pattern cannot read fails loudly instead of vanishing.
 */
function membersOf(body: string): string[] {
  return (
    [
      ...body.matchAll(
        /^ {2}(?:(?:readonly|private|protected|public|static|async|get|set|declare|accessor|override)\s+)*(#?\w+|"[^"]*"|'[^']*'|\[[^\]]*\])[!?]?\s*[(:;<=]/gm,
      ),
    ]
      // `"ydoc"` and `["ydoc"]` are the same property as `ydoc`, so normalize —
      // otherwise a quoted re-add lands beside the pinned list instead of
      // colliding with it, and reads as a new member rather than the old one.
      .map((m) => m[1].replace(/^\[?["']?|["']?\]?$/g, ""))
      .sort()
  );
}

/**
 * Lines in a declaration body that begin a member.
 *
 * Everything at exactly two-space indent except closers: `  }`, `  };`, and the
 * `  ): T {` / `  } {` tails of a multi-line signature. Measured against the
 * real `YDocStore` body — those three shapes are the complete set of two-space
 * lines that are not member starts.
 */
function memberStartLines(body: string): string[] {
  return body.split("\n").filter((l) => /^ {2}\S/.test(l) && !/^ {2}[})]/.test(l));
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

    // The eight shapes that defeated the first version of this pattern. Each
    // compiles, each hands back the raw `Y.Doc`, and each left the pinned list
    // below untouched until the widenings in `membersOf`'s docblock landed.
    expect(membersOf("  readonly ydoc = this.#ydoc;")).toStrictEqual(["ydoc"]);
    expect(membersOf("  readonly getRawDoc = () => this.#ydoc;")).toStrictEqual(["getRawDoc"]);
    expect(membersOf("  readonly ydoc!: Y.Doc;")).toStrictEqual(["ydoc"]);
    expect(membersOf("  readonly ydoc?: Y.Doc;")).toStrictEqual(["ydoc"]);
    expect(membersOf("  declare readonly ydoc: Y.Doc;")).toStrictEqual(["ydoc"]);
    expect(membersOf("  accessor ydoc: Y.Doc;")).toStrictEqual(["ydoc"]);
    expect(membersOf('  "ydoc": Y.Doc;')).toStrictEqual(["ydoc"]);
    expect(membersOf('  ["ydoc"]: Y.Doc;')).toStrictEqual(["ydoc"]);

    // The ninth defeat has no name to match, so it is the parse-completeness
    // assertion's job, not this one's. Pinned here so the division of labour is
    // visible rather than looking like an oversight.
    expect(membersOf("  static {")).toStrictEqual([]);
    expect(memberStartLines("  static {")).toStrictEqual(["  static {"]);

    // A deeper indent is a nested declaration, not a member of the class.
    expect(membersOf("      const ydoc: Y.Doc = x;")).toStrictEqual([]);
    // Closers are not member starts — the three shapes the real body contains.
    expect(memberStartLines("  }\n  };\n  ): T {\n  } {")).toStrictEqual([]);
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

  it("every member start PARSES — a shape the pattern cannot read fails loudly", () => {
    // **The exact list above is a list of the shapes one regex happens to read,
    // unless something checks that it read all of them.** `static { … }` has no
    // member name, so no widening of `membersOf` can ever see it — and a static
    // block sits INSIDE the class body, where the `#` brand check passes, so it
    // reaches `#ydoc` freely and can hang a getter on the prototype with
    // `Object.defineProperty`. Measured, not assumed: that hands back the raw
    // `Y.Doc` and leaves the member list byte-identical. This assertion is the
    // only thing in the file that reds on it.
    for (const [label, source] of [
      ["YDocStore", read("src/server/mcp/document-store.ts")],
      ["AnnotationLifecycle", read("src/server/annotations/lifecycle.ts")],
    ] as const) {
      const body =
        label === "YDocStore"
          ? source.slice(
              source.indexOf("export class YDocStore {"),
              source.indexOf("export function getDocumentStore"),
            )
          : source.slice(
              source.indexOf("export interface AnnotationLifecycle {"),
              source.indexOf("\n}", source.indexOf("export interface AnnotationLifecycle {")),
            );
      expect(
        memberStartLines(body).filter((l) => membersOf(l).length !== 1),
        `${label}: a member-start line this pattern cannot read — widen \`membersOf\`, do not drop the line from the sweep`,
      ).toStrictEqual([]);
    }
  });

  it("the two fields that hold Y.js values are #, and no member names a Y type", () => {
    // `private` erases at compile time, so `(store as any).ydoc` reaches a
    // `private` field with no error — and Y.js's `AbstractType` exposes a public
    // `doc`, so a `private map` hands back the raw document through
    // `(store as any).map.doc` with NO new member for the pin above to see.
    //
    // **What the `#` brand actually buys, stated exactly, because an earlier
    // draft of this comment oversold it.** It stops readers OUTSIDE the class
    // body. It does not make the file itself trustworthy: a `static { … }` block
    // is inside the body and reads `#ydoc` freely — see the parse-completeness
    // assertion above, which is what covers that. So `#` closes the `as any`
    // route by compiler; the rest of this file is still what closes the others.
    const source = read("src/server/mcp/document-store.ts");
    expect(source).toContain("readonly #ydoc: Y.Doc;");
    expect(source).toContain("readonly #map: Y.Map<unknown>;");

    // **The member pin reads NAMES; the class docblock claims a fact about
    // TYPES** — "none returns a `Y.Doc` or a `Y.Map`". Those are not the same
    // assertion, and the gap is walkable: widening an EXISTING member's
    // multi-line inline return type with `raw: Y.Map<unknown>` sits at four-space
    // indent, so `membersOf` reports the identical list while
    // `store.getUserAwareness().raw.doc` is the raw document. Pinning the three
    // lines that may name a Y type is what closes it, and it also subsumes the
    // `private readonly x: Y.…` check this replaces — that one could only fire
    // on a shape the exact-list pin already reds.
    const body = source.slice(
      source.indexOf("export class YDocStore {"),
      source.indexOf("export function getDocumentStore"),
    );
    expect(
      body.split("\n").filter((l) => /Y\.(Doc|Map)/.test(l)),
      "a Y.js type may be named only by the two # fields and the constructor parameter",
    ).toStrictEqual([
      "  readonly #ydoc: Y.Doc;",
      "  readonly #map: Y.Map<unknown>;",
      "  constructor(ydoc: Y.Doc, filePath: string, documentId: string) {",
    ]);
  });

  it("AnnotationLifecycle exposes exactly these members — the store's public seam", () => {
    // Pinned alongside the store because `readonly lifecycle` is public: a
    // `getRawDoc(): Y.Doc` added HERE is reachable as
    // `store.lifecycle.getRawDoc()` while every assertion above stays green.
    const source = read("src/server/annotations/lifecycle.ts");
    const start = source.indexOf("export interface AnnotationLifecycle {");
    expect(start, "the interface must be locatable").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));

    // The NAME list cannot see a Y type in a return position; parse
    // completeness for this body is asserted by its own spec above.
    expect(
      body.split("\n").filter((l) => /Y\.(Doc|Map)/.test(l)),
      "this interface must name no Y.js type at all — it is the seam the store hands out",
    ).toStrictEqual([]);

    expect(
      membersOf(body),
      "the lifecycle is the seam callers hold — a member returning a Y.Doc or Y.Map re-opens the hatch the store just closed",
    ).toStrictEqual(["accept", "create", "dismiss", "editPending", "remove", "reply"]);
  });
});
