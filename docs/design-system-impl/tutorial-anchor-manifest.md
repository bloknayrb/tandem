---
tags: [audience/contributor, topic/design-system, topic/testing]
aliases: [Tutorial-anchor manifest, Tutorial anchors]
---

# Tutorial-Anchor Manifest

[Home](../README.md) › [Contributing](../maps/contributing.md)

> **Status: live.** Every `targetText` substring in
> `src/server/mcp/tutorial-annotations.ts` is listed below with the
> `sample/welcome.md` section it resolves in and the kind of tutorial
> annotation it produces. Any sub-PR that edits welcome.md or the annotation
> definitions must keep these aligned — the vitest gate at
> `tests/design-system-impl/tutorial-anchor.test.ts` will fail loudly if an
> anchor stops resolving or becomes ambiguous. (First captured 2026-05-21 on
> `feat/design-system-impl`; anchors and sections re-checked 2026-10-20.)

## Why this matters

`injectTutorialAnnotations` resolves anchors by exact-substring `indexOf`
into the document's flat text. When welcome.md drifts — a paragraph
rephrased, a phrase rewritten — the anchor silently breaks: the function
logs `[tutorial] Target text "..." not found` and skips the annotation. The
user opens welcome.md and sees a partially-broken tutorial without any
explicit error surfacing in the UI. The docblock of
`tests/server/tutorial-annotations.test.ts` records the same lesson.

The gate enforces two properties per anchor: (1) the substring is **present**
in welcome.md, and (2) it appears **exactly once** so the anchor resolves
unambiguously to a single position.

## Anchors

| Anchor ID                | Type        | `targetText` substring                       | welcome.md section | Author seeded as |
| ------------------------ | ----------- | -------------------------------------------- | ------------------ | ---------------- |
| `tutorial-highlight-1`   | `highlight` | `highlight text and your AI sees it`         | opening paragraph (under the title) | `user` |
| `tutorial-comment-1`     | `comment`   | `edit this document at the same time`        | Getting Started    | `claude`         |
| `tutorial-suggest-1`     | `comment` (with `suggestedText: "streamline onboarding"`) | `simplify onboarding` | Sample Content | `claude` |
| `tutorial-note-1`        | `note`      | `accept or dismiss`                          | Try These (step 1, "Respond to a suggestion") | `user` |

The section column is for orientation only; find an anchor by searching for
its substring. The gate checks presence and uniqueness, not position, so no
line number is kept here (an earlier line column drifted out of date).

The `tutorial-` prefix is `TUTORIAL_ANNOTATION_PREFIX` from
`src/shared/constants.ts`. The `injectTutorialAnnotations` function is
idempotent — re-injection skips entries whose IDs already exist in the
Y.Map, and also skips a seed the user deleted: an id tombstoned in the
ledger for that file is not re-created (#1696). The exception is an explicit
replay request (Settings → Replay tutorial), which re-creates tombstoned
seeds at a `rev` above their tombstone; the function returns how many it
re-created, and a caller that gets a non-zero count must persist a snapshot
for the replay to outlive the session. Each seed states its author and
audience: the two `claude` comments are written `audience: "outbound"` — a
Claude-authored seed the user is invited to accept or dismiss is outbound by
intent — and the two `user` seeds, the highlight and the
[note](../glossary.md#note), are written `audience: "private"`, matching what
sanitize's demote guard would force on read. Highlights are the user's own
marks (#1725), so the highlight seed carries no Accept or Dismiss and the
welcome document has two review targets.

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
   ADR-027 (Claude cannot author user-private content); [comments](../glossary.md#comment) and
   [highlights](../glossary.md#highlight) are seeded as `claude` so the cross-author authorship
   indicator shows correctly in the demo. Don't flip these.

## Enforcement

`tests/design-system-impl/tutorial-anchor.test.ts` — parses
`targetText: "..."` literals out of the tutorial annotations source,
unescapes JSON-style escapes, and asserts each substring resolves
**uniquely** in welcome.md. Test runs in the existing `node` vitest project
alongside the other Phase 0 gates. `tests/server/tutorial-annotations.test.ts`
runs the injection itself against a committed fixture
(`tests/fixtures/welcome-snapshot.md`), and also checks that the live
welcome.md is anchor-equivalent to that fixture, so an edit to an anchor
sentence means updating both.

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

## Related

- [Contributing map → Design system](../maps/contributing.md#design-system): the other live design references.
- [The welcome document](../../sample/welcome.md): the text every anchor must resolve in.
- [Workflows → Onboarding tutorial](../workflows.md#onboarding-tutorial-first-run): what the tutorial looks like to a user.
- [Architecture → Onboarding tutorial](../architecture.md#onboarding-tutorial): how the tutorial is wired.
- [ADR-027](../decisions.md#adr-027-annotation-system-redesign--audience-based-model): why notes are seeded as the user's.
- [Test-selector manifest](testid-manifest.md): the sibling manifest for E2E selectors.
