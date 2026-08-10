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

5. **Open the version with a plain-language summary, before any `###` subsection.** Two or
   three sentences for someone who does not know the codebase, the issue numbers, or our
   vocabulary, answering "what is different for me now?" Name the one or two changes most
   people will notice, and say plainly if the release is mostly internal. No issue numbers,
   no file paths, no subsystem names in the summary — those belong in the entries below it.

6. **Order entries within each section by user impact, most impactful first.** Not by issue
   number, not by merge order, not by subsystem. Ask which bullet a user would be sorriest to
   miss and put it at the top. A reader who stops after the first bullet of each section
   should still have the release's substance.

7. Format as a `## [Unreleased]` section. Each entry should be:
   - Bold summary with PR number: `- **Description** (#N)`
   - Group related commits into a single entry where appropriate
   - Use imperative mood ("Add", "Fix", "Remove" — not "Added", "Fixes")

8. Output the formatted block for the user to review and paste into `CHANGELOG.md`.

## Important

- Do NOT write directly to CHANGELOG.md — output the block for editorial review
- Check the existing CHANGELOG.md format to match style (indentation, heading levels, PR references)
- If there's already an `[Unreleased]` section, show what to append, not a replacement
- Omit empty categories (don't show "### Security" if there are no security commits)
- **List spacing is load-bearing.** `CHANGELOG.md` has a byte-identical `serializeMdast`
  round-trip golden test (`tests/server/file-io/markdown-escaping.test.ts`). `### Fixed` uses
  tight lists (no blank line between bullets) while `### Added`/`### Changed` use loose ones;
  mixing them fails the test. Run that test after editing, not at the end.
- **The in-app View Changelog surface renders this file**, so an HTML comment is invisible
  there. Caveats and hedges go in the prose or they reach nobody.

## Releasing

See `.claude/skills/release/SKILL.md` for the full release sequence (version bump across all
six surfaces, tag, GitHub Release publish, smoke checklist).

## Conventions

Going forward, changelog entries follow [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) framing — write "your AI" / "the AI" generically; use "Claude" as the concrete example when a feature is Claude-specific (e.g. channel push, plugin monitor, cowork, auto-launcher, plugin marketplace). Past entries (v0.12.0 and earlier) are historical record and not rewritten.
