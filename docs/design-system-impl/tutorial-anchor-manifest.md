# Tutorial-Anchor Manifest

> **Captured 2026-05-21** on `feat/design-system-impl`. Every `targetText`
> substring in `src/server/mcp/tutorial-annotations.ts` is listed below with
> the `sample/welcome.md` line it currently resolves against and the kind of
> tutorial annotation it produces. Any sub-PR that edits welcome.md or the
> annotation definitions must keep these aligned — the vitest gate at
> `tests/design-system-impl/tutorial-anchor.test.ts` will fail loudly if an
> anchor stops resolving or becomes ambiguous.

## Why this matters

`injectTutorialAnnotations` resolves anchors by exact-substring `indexOf`
into the document's flat text. When welcome.md drifts — a paragraph
rephrased, a phrase rewritten — the anchor silently breaks: the function
logs `[tutorial] Target text "..." not found` and skips the annotation. The
user opens welcome.md and sees a partially-broken tutorial without any
explicit error surfacing in the UI. See lesson
`feedback_tutorial_anchors_drift_silently`.

The gate enforces two properties per anchor: (1) the substring is **present**
in welcome.md, and (2) it appears **exactly once** so the anchor resolves
unambiguously to a single position.

## Anchors

| Anchor ID                  | Type        | `targetText` substring                       | welcome.md line | Author seeded as |
| -------------------------- | ----------- | -------------------------------------------- | --------------- | ---------------- |
| `__tutorial__highlight-1`  | `highlight` | `highlight text and your AI sees it`         | line 3          | `claude`         |
| `__tutorial__comment-1`    | `comment`   | `edit this document at the same time`        | line 9          | `claude`         |
| `__tutorial__suggest-1`    | `comment` (with `suggestedText: "streamline onboarding"`) | `simplify onboarding` | line 19 | `claude` |
| `__tutorial__note-1`       | `note`      | `accept or dismiss`                          | line 13         | `user`           |

The `__tutorial__` prefix is `TUTORIAL_ANNOTATION_PREFIX` from
`src/shared/constants.ts`. The `injectTutorialAnnotations` function is
idempotent — re-injection skips entries whose IDs already exist in the
Y.Map.

## Contract

1. **No anchor drift.** Editing welcome.md to rephrase a sentence that
   contains an anchor substring is a breaking change. Either:
   - Keep the substring verbatim in the new wording, OR
   - Update the corresponding `targetText` in `tutorial-annotations.ts` in
     the same commit AND verify the new substring is unique in welcome.md
     by re-running the vitest gate.
2. **No duplicate substrings.** If a sub-PR edits welcome.md in a way that
   introduces a second occurrence of any anchor substring, the gate fails
   (uniqueness check). Either disambiguate (e.g. lengthen the anchor) or
   restructure the prose so the substring stays unique.
3. **Author seeding stays intentional.** Notes are seeded as `user` per
   ADR-027 (Claude cannot author user-private content); comments and
   highlights are seeded as `claude` so the cross-author authorship
   indicator shows correctly in the demo. Don't flip these.

## Enforcement

`tests/design-system-impl/tutorial-anchor.test.ts` — parses
`targetText: "..."` literals out of the tutorial annotations source,
unescapes JSON-style escapes, and asserts each substring resolves
**uniquely** in welcome.md. Test runs in the existing `node` vitest project
alongside the other Phase 0 gates.

## Known limitations

- The extractor only handles double-quoted `targetText: "..."` literals.
  If a future entry uses backticks or single quotes, extend the regex in
  the test and update this manifest.
- The test does NOT exercise `anchoredRange` itself — it only verifies the
  precondition (substring presence + uniqueness). A bug in the
  flat-offset → CRDT-position resolver could still skip an annotation in
  the runtime path; that is covered by the existing unit tests in
  `tests/server/`.
- The author-seeded mapping above is documentation-only; the test does not
  assert the seeded `author` matches expectation. If the rules change,
  update both the table here and the seeding logic in
  `injectTutorialAnnotations` in the same commit.
