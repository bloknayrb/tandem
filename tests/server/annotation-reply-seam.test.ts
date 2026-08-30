/**
 * ADR-035 Unit 8f: the reply family behind the lifecycle seam.
 *
 * The privacy rule for replies lives on `AnnotationLifecycle.reply` and NOT on
 * `addUserReply`, because the browser must reach the mechanism ungated — a user
 * replying in their own private note's thread is exactly what ADR-027 permits.
 * That split is right, and it means a new MCP-side caller can bypass the guard
 * by importing the other symbol: no edit to any existing file, nothing red.
 *
 * `replies-privacy-readwrite.test.ts` pins what each entry DOES. This file pins
 * who is allowed to call them, which is the half no behavioural spec can see.
 *
 * The two directions are asserted separately because they fail separately:
 *
 * 1. **No MCP-side module may import `addUserReply`.** That is the bypass.
 * 2. **`addUserReply` must remain the only unguarded producer of a newly
 *    authored reply.** A second one — a `writeReply` wrapper exported from
 *    `lifecycle.ts`, say — satisfies direction 1 while reopening the same hole
 *    from inside a sanctioned file. Review demonstrated exactly this defeat
 *    against Unit 8e's first draft.
 */

import { describe, expect, it } from "vitest";
import { filesMentioning, SRC_FILES, stripComments } from "../helpers/src-tree.js";

const LIFECYCLE = "src/server/annotations/lifecycle.ts";

describe("ADR-035 Unit 8f: who may write a reply", () => {
  /**
   * Keyed on the SYMBOL, not on the module specifier. A specifier-shaped scan is
   * beaten by a dropped extension — `moduleResolution: "bundler"` makes
   * `from "../annotations/lifecycle"` legal — and the symbol name survives that.
   * Comments are stripped so prose *about* an entry is not counted as a use.
   */
  const SANCTIONED_UNGUARDED = [
    // Defines it, and is where `AnnotationLifecycle.reply` adds the guard.
    LIFECYCLE,
    // The browser's reply box. The ONE production caller entitled to the
    // unguarded path.
    "src/server/mcp/routes/annotation-reply.ts",
  ];

  it("addUserReply is reachable only from the lifecycle module and the browser's route", () => {
    // Control: a sweep that silently read nothing satisfies every "no
    // unexpected files" assertion below it.
    expect(SRC_FILES.size, "control: the sweep found source files").toBeGreaterThan(100);

    // Equality against a non-empty list, for the same reason.
    expect(filesMentioning("addUserReply")).toStrictEqual(SANCTIONED_UNGUARDED);
  });

  it("keeps the guarded entry off the browser's route, and the unguarded one off Claude's", () => {
    // The inverse of the census, and it is not implied by it. The list above
    // stays green if `routes/annotation-reply.ts` ALSO starts calling
    // `lifecycle.reply` — the file is already sanctioned — which would refuse a
    // user's reply in their own note thread and read as a privacy improvement
    // while being a regression of #1000.
    const route = stripComments(SRC_FILES.get("src/server/mcp/routes/annotation-reply.ts") ?? "");
    expect(route).toContain("addUserReply(");

    // **Keyed on the reachable spelling, not the private one.** This asserted
    // `not.toMatch(/\breplyForClaude\b/)` until review measured it: that symbol
    // is module-private, so no compiling change to the route can ever contain
    // it, and the assertion had no reachable failing input — a zero check
    // satisfied by zero. The regression the paragraph above names was then
    // demonstrated GREEN by adding a real `createAnnotationLifecycle(ydoc)
    // .reply(...)` call to the route. These two are what that costs.
    expect(route, "the browser must not acquire Claude's ADR-027 guard").not.toMatch(
      /\bcreateAnnotationLifecycle\b/,
    );
    expect(route, "…and must not reach it through a lifecycle held elsewhere").not.toMatch(
      /\.reply\s*\(/,
    );

    // And the MCP tool must not reach past its own store onto the browser entry.
    const mcp = stripComments(SRC_FILES.get("src/server/mcp/annotations.ts") ?? "");
    expect(mcp, "Claude's tool must not reach the unguarded entry").not.toMatch(/\baddUserReply\b/);
  });

  it("has exactly one unguarded producer inside the lifecycle module itself", () => {
    // **The file-level pin is defeated from INSIDE a sanctioned file.** Export a
    // second thin wrapper over `writeReply` from `lifecycle.ts`, import THAT
    // from an MCP-side module, and every assertion above stays green: the new
    // caller never mentions `addUserReply`, and the wrapper lives in a file
    // already on the list.
    //
    // So pin the private mechanism's call sites. Exactly three occurrences of
    // `writeReply` in this module: the declaration, `addUserReply`'s call, and
    // `replyForClaude`'s call. A fourth is a new producer, and it must be a
    // decision someone makes on purpose rather than a diff nothing notices.
    const lifecycle = stripComments(SRC_FILES.get(LIFECYCLE) ?? "");
    expect(
      lifecycle.match(/\bwriteReply\b/g) ?? [],
      "declaration + addUserReply + replyForClaude — a fourth is a new unguarded producer",
    ).toHaveLength(3);

    // **And the same pin on `addUserReply` itself, which is the defeat the
    // paragraph above did not cover.** Measured by two reviewers independently:
    // `export const postReplyAsUser = addUserReply;` in this file, imported by
    // an MCP-side module, left all four specs GREEN. The census never sees it —
    // the alias is *defined* in a sanctioned file and the consumer never spells
    // the pinned name — and `writeReply`'s count is untouched, because the alias
    // goes through `addUserReply`. Exactly ONE occurrence here once comments are
    // stripped: the declaration. Its body calls `writeReply`, not itself, so a
    // second mention is an alias, a re-export, or a new internal caller — each
    // of which hands the unguarded capability somewhere this suite cannot see.
    expect(
      lifecycle.match(/\baddUserReply\b/g) ?? [],
      "the declaration and nothing else — a second mention hands the capability on",
    ).toHaveLength(1);
    expect(lifecycle, "no alias binding of the unguarded entry").not.toMatch(
      /export\s+(?:const|let|var|function)\s+\w+\s*=?\s*addUserReply\b/,
    );
    expect(lifecycle, "no aliased re-export of the unguarded entry").not.toMatch(
      /export\s*\{[^}]*\baddUserReply\b[^}]*\bas\b/,
    );

    // `writeReply` stays module-private. Exporting it makes the count above
    // meaningless: a caller in any other file would then reach the mechanism
    // with no guard and no wrapper to notice.
    expect(lifecycle, "writeReply must stay module-private").not.toMatch(
      /export\s+(async\s+)?function\s+writeReply\b/,
    );
    expect(filesMentioning("writeReply"), "…and so must have no callers elsewhere").toStrictEqual([
      LIFECYCLE,
    ]);
  });

  it("routes Claude's two consumers through the same refusal describer", () => {
    // `describeReplyWriteRefusal` holds the family's only `never` anchor. A
    // consumer that re-derives its own wire code from `result.kind` compiles,
    // passes, and silently stops being covered by that anchor — which is how
    // the remove family shipped a ternary ending in an unreachable catch-all
    // one PR earlier.
    for (const consumer of ["src/server/mcp/annotations.ts", "src/server/local-model/tools.ts"]) {
      // Keyed on the CALL, not the name. Measured: a mutant that replaced the
      // call with an inline `{ code: "REPLY_FAILED" }` and left the import
      // untouched passed a bare-name check — the identifier was still in the
      // file, in the one position that proves nothing.
      expect(
        stripComments(SRC_FILES.get(consumer) ?? ""),
        `${consumer} must describe a refusal through the anchored describer`,
      ).toMatch(/\bdescribeReplyWriteRefusal\s*\(/);
    }

    // Named separately from `annotations/projection.ts`'s `describeReplyRefusal`,
    // which is about refusing to PROJECT a reply rather than to write one. Two
    // same-named exports in one subsystem never error — they are simply never
    // imported together — so nothing but this line notices a re-collision.
    expect(
      filesMentioning("describeReplyWriteRefusal"),
      "the write-refusal describer's reach, kept distinct from the projection one",
    ).toStrictEqual([
      LIFECYCLE,
      "src/server/local-model/tools.ts",
      "src/server/mcp/annotations.ts",
      "src/server/mcp/routes/annotation-reply.ts",
    ]);
  });
});
