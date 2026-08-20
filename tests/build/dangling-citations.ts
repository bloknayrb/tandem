/**
 * The dangling-`§N`-citation detector, shared by the repo-wide guard
 * (`invariant-citations.test.ts`) and available to any narrower one.
 *
 * BACKGROUND. #1374 found six `(security invariant §N)` / `(invariant §N)` /
 * `(security §N)` citations in `src-tauri/src/firewall.rs` pointing at a
 * numbered list that exists nowhere in the repo — not in `docs/`, not in
 * `CLAUDE.md`, not in any ADR. It was a citation *habit*, not a maintained
 * document: `§4` and `§12` are each reused for unrelated concepts in different
 * files, which is only possible when nothing is being cited. #1531 found the
 * same habit in `lib.rs`, `cowork_installer.rs`, three `src/cli/*.ts` files,
 * `useModels.svelte.ts`, and four test files. This module is the pattern both
 * fixes were verified against.
 *
 * WHAT IS A DEFECT AND WHAT IS NOT. `§` is used legitimately and often here —
 * `ADR-040 §5`, `JSON-RPC 2.0 §5.1`, `OOXML §2.5.39`, `RFC 4632 §3.1`,
 * `spec §6.4`, `#1417 §1C`. Every one of those names the document it points
 * into, so a reader can find it. The defect is the *label-less* shape: either
 * the words `invariant`/`security` (which name a list, not a document) or no
 * label at all.
 *
 * Three branches, matching the three shapes actually observed:
 *
 *  1. `invariant §N` / `security invariant §N`, parenthesised or not — two of
 *     #1374's six carried no parens, so requiring them would have missed
 *     exactly those two.
 *  2. `security §N` with no `invariant`.
 *  3. bare `(§N)` with no label at all.
 *
 * Branch 3 requires the `(` to be followed immediately by the `§`, which is
 * what keeps every legitimate citation out: `(ADR-040 §5)` and
 * `(RFC 4632 §3.1)` both have a label sitting between the paren and the
 * section mark. That is what makes the numeral shape safe to widen — dotted
 * subsection numerals (`§3.4`, `§2.5.39`) are included, because a bare
 * `(§3.4)` is the same defect written with a finer numeral, and #1531 found
 * seven of them citing a plan that lives in gitignored `.claude/plans/`. The
 * one legitimate dotted citation the widening reached, `docx-apply.ts`'s
 * OOXML backreference, was given back the `OOXML ` label it was missing
 * rather than carved out — the pattern stays uniform.
 *
 * `§3` — and only the exact integer `3` — is excluded. It is the one numeral
 * in this family that resolves: the defense-in-depth path guard defined inline
 * at `cowork_workspace_scan.rs:7`/`:605` and cited accurately from
 * `cowork_atomic_json.rs:128`, `src/cli/win-path-guard.ts`, and
 * `tests/shared/unc-check-duplication.test.ts:114`. Excluding it is not
 * convenience: a pattern that flagged the one citation that *does* resolve
 * would contradict the reasoning above.
 */

/** All three defect shapes. Global + case-insensitive; `§3` filtered below. */
export const DANGLING_CITATION_RE =
  /(?<![\w-])(?:security\s+)?invariant\s*§\s*(\d+(?:\.\d+)*)|(?<![\w-])security\s*§\s*(\d+(?:\.\d+)*)(?!\w)|\(\s*§\s*(\d+(?:\.\d+)*)\s*\)/gi;

/** Every dangling citation in `text`, in source order. `§3` is not one. */
export function danglingCitations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(DANGLING_CITATION_RE)) {
    const num = m[1] ?? m[2] ?? m[3];
    if (num === "3") continue; // the one legitimate, resolvable numeral
    found.push(m[0]);
  }
  return found;
}
