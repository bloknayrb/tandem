---
name: changelog
description: Generate a Keep a Changelog entry from git log since the last tag
disable-model-invocation: true
---

# Generate Changelog Entry

Generate a formatted CHANGELOG entry from commits since the last release tag.

## Steps

1. Find the last release tag:

```bash
git describe --tags --abbrev=0
```

2. List commits since that tag:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline --no-merges
```

3. **Read the diff of each change, not its subject line.** `git show <sha> -- <path>` for
   anything you are about to describe. The commit prefix tells you where an entry goes; only
   the diff tells you what it says. v0.20.0 shipped five defective entries composed from PR
   titles — the worst promised a detection capability that did not exist. Where a change
   landed across several commits (a fix, then its review corrections), describe the **final**
   state: `git log --oneline v<prev>..HEAD -- <path>` shows whether what you just read was
   later amended, and `git show v<prev>:<file>` settles "is this actually new?"

4. Group into Keep a Changelog categories based on conventional commit prefixes:
   - `feat(...)` → **Added** (new features) or **Changed** (enhancements to existing)
   - `fix(...)` → **Fixed**
   - `refactor(...)` → **Changed**
   - `docs(...)` → **Documentation**
   - `test(...)` → **Tests**
   - `chore(...)` → **Maintenance**
   - `perf(...)` → **Performance**
   - Security-related commits → **Security**

5. **Write the entries** (see *Writing the prose* below), ordered within each section by user
   impact, most impactful first. Not by issue number, not by merge order, not by subsystem. A
   reader who stops after the first bullet of each section should still have the release's
   substance.

6. **Then write a `### What's New` section and place it first**, above every other subsection.
   It is written last and read first — you cannot summarise entries you have not drafted.

   - 3–6 bullets, most impactful first, one line each (≤20 words).
   - No PR numbers, no subsystem names, no file paths, no bounds — those live in the entries.
   - Each bullet is derived from an entry's bold clause. **Re-derive the bullet whenever you
     edit that entry**; nothing checks that the two agree, so this is the only thing keeping
     the summary from drifting away from the detail it summarises.
   - If the release is mostly internal, one bullet says so plainly.

   **Lead with 1–2 sentences of prose above the bullets only when a genuinely large feature or
   change headlines the release** — something that changes how Tandem is used or how a release
   should be approached, not a good bug fix. Otherwise go straight to the bullets.

7. Format as a `## [Unreleased]` section. Each entry is:
   - Bold summary with PR number: `- **Description** (#N)`
   - Related commits grouped into a single entry
   - Imperative mood ("Add", "Fix", "Remove" — not "Added", "Fixes")

8. Output the formatted block for the user to review and paste into `CHANGELOG.md`.

## Writing the prose

Entries earned their length historically by carrying honest qualifications, and they also
accumulated a lot of narration. Tighten the narration; keep the qualifications.

**The shape is the discipline, not a word count.** An entry is:

1. A bold clause: what is different now.
2. One sentence of consequence: what the user saw, or would have seen, when it was wrong.
3. Zero or more **bounds**, one sentence each — see below.

Nothing else. If a sentence is doing a fourth job, it belongs in the PR. **120 words is a
runaway backstop, not a target**, and bounds do not count toward it — an entry that needs
three honest bounds gets three sentences and is still correct. Draft the entry, then cut it to
shape; do not aim short and stop early, because the first draft is where you find out what
actually mattered.

### Bounds

A bound is a sentence that changes what the reader would **do or believe**. Label it
**Bound:** (or a more specific label when it is not a scope limit — **Unverified:**, **Not
exercised before release:**). Real fixes often carry more than one, and each gets its own
sentence; do not merge two bounds about two different populations of files into one, and do
not pick a winner between them.

Keep a bound when it answers any of:

- Am I affected? — including *when* the fault existed and what produces it, where that is the
  test for "are my files affected". ("A file Word wrote was never affected; it needs a `.docx`
  built by something else.")
- Will something visibly change for me on upgrade?
- Is there residue I should clean up?
- Is this narrower than it sounds? — say what it does **not** cover, especially when the
  obvious reading is that it now does.
- Was this actually verified? — an unexercised path, or one smoke-tested on one platform, says
  so.

Drop a hedge that only qualifies a mechanism the entry no longer describes.

### Cut

- **Mechanism archaeology.** How the bug worked, which field held the wrong value, which two
  code paths disagreed, which one was written first. That is what the PR is for. Duration is
  *not* archaeology when it is the "am I affected" test — see Bounds.
- **Self-narration.** "Two changes, neither of which alters…", "This was the more serious of
  the two", "found by a test written to check the opposite."
- **Reassurance about what was not affected**, when nobody would have assumed otherwise. When
  they would, it is a bound: one sentence, not a paragraph.
- **Discovery attribution**, unless it is a severity signal — "not caught by any scanner" tells
  a security-minded reader that sibling instances may be undiscovered, and stays.
- Hedging stacks ("could potentially sometimes"), and "the system" where "Tandem" is meant.

Voice: active; present tense for current behaviour, past for what it used to do.

### Worked example — an ordinary fix

Before (247 words):

> - **Accepting a suggestion that came from a Word comment now marks that comment resolved in
>   the `.docx`.** When you open a `.docx`, its reviewer comments come in as personal notes;
>   send one to Claude, take Claude's suggested wording, accept it, and `tandem_applyChanges`
>   writes the edit back as a tracked change. It was supposed to tick the original Word comment
>   off as done in the same pass, and never did — not for some comments, for all of them.
>   Tandem was working out which Word comment a suggestion came from by reading its own
>   internal id, in a shape those ids stopped using four months ago, twelve days after the
>   resolving step was written, so the answer was always "no comment" and the resolving step
>   quietly did nothing. Reopening the file in Word showed every comment still outstanding,
>   including the ones you had just addressed. Tandem now reads the original comment number off
>   the note itself, which is where it has been stored all along.

After (44 words):

> - **Accepting a suggestion from a Word comment now resolves that comment in the `.docx`
>   (#1234).** `tandem_applyChanges` wrote the tracked change but never ticked the original
>   comment off, so reopening in Word showed every comment still outstanding — including ones
>   you had just addressed.

### Worked example — a security entry with two bounds

This is the shape that goes wrong. The entry compresses; the bounds do not.

> - **Claude can no longer choose the name of a file Tandem writes for you — only the folder
>   (#1234).** The annotation export and the `.docx`-to-Markdown conversion both took a
>   caller-supplied filename, so a session talked into it could drop a `CLAUDE.md` into a
>   project that had none — a file every future session there loads as instructions. Exports
>   must now end `.annotations.md` or `.annotations.json`, and a conversion takes a folder,
>   naming the file after the document. **Bound:** this narrows rather than closes — renaming
>   your document first still reaches a chosen name, but that changes the tab in front of you.
>   **Bound:** nothing in Tandem's own interface passed these values, so no workflow of yours
>   changes.

## Important

- Do NOT write directly to CHANGELOG.md — output the block for editorial review
- Check the existing CHANGELOG.md for **formatting** style (indentation, heading levels, PR
  references). Do **not** match the length of pre-2026-09 entries; they predate the shape above.
- If there's already an `[Unreleased]` section, show what to append, not a replacement
- Omit empty categories (don't show "### Security" if there are no security commits)
- **Never retighten an already-released entry.** Three doc-claim tests grep CHANGELOG prose for
  exact phrasing inside historical sections — `tests/docs/wake-availability-claims.test.ts`,
  `tests/docs/monitor-arming-claims.test.ts`, `tests/docs/native-theme-claims.test.ts` — so a
  tidy-up of old versions turns `check` red for reasons the diff will not explain. Shipped
  entries are also a record of what users were told. Editorial cleanup is forward-only.
- **List spacing is load-bearing.** `CHANGELOG.md` has a byte-identical `serializeMdast`
  round-trip golden test (`tests/server/file-io/markdown-escaping.test.ts`). The serializer
  decides tight-vs-loose **per list node** (`spread` on the list, not on the item): one
  multi-paragraph bullet makes every bullet in that list loose. So spacing is uniform within a
  section, and a single entry spilling into a second paragraph forces blank lines between all
  of that section's entries. One-paragraph entries keep every list tight. `### What's New` is
  its own list and does not propagate. Run that test after editing, not at the end.
- **The in-app View Changelog surface renders this file** as an ordinary read-only document,
  scrolled linearly. An HTML comment is invisible there, so caveats go in the prose or they
  reach nobody — and a reader meets each `What's New` bullet again in full a few inches later,
  which is why the bullets stay one short line.

## Releasing

See `.claude/skills/release/SKILL.md` for the full release sequence (version bump across all
six surfaces, tag, GitHub Release publish, smoke checklist).

## Conventions

Going forward, changelog entries follow [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) framing — write "your AI" / "the AI" generically; use "Claude" as the concrete example when a feature is Claude-specific (e.g. channel push, plugin monitor, cowork, auto-launcher, plugin marketplace). Past entries (v0.12.0 and earlier) are historical record and not rewritten.
