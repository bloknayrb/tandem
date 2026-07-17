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

3. Group commits into Keep a Changelog categories based on conventional commit prefixes:
   - `feat(...)` → **Added** (new features) or **Changed** (enhancements to existing)
   - `fix(...)` → **Fixed**
   - `refactor(...)` → **Changed**
   - `docs(...)` → **Documentation**
   - `test(...)` → **Tests**
   - `chore(...)` → **Maintenance**
   - `perf(...)` → **Performance**
   - Security-related commits → **Security**

4. Format as a `## [Unreleased]` section. Each entry should be:
   - Bold summary with PR number: `- **Description** (#N)`
   - Group related commits into a single entry where appropriate
   - Use imperative mood ("Add", "Fix", "Remove" — not "Added", "Fixes")

5. Output the formatted block for the user to review and paste into `CHANGELOG.md`.

## Important

- Do NOT write directly to CHANGELOG.md — output the block for editorial review
- Check the existing CHANGELOG.md format to match style (indentation, heading levels, PR references)
- If there's already an `[Unreleased]` section, show what to append, not a replacement
- Omit empty categories (don't show "### Security" if there are no security commits)

## Releasing

See `.claude/skills/release/SKILL.md` for the full release sequence (version bump across all
six surfaces, tag, GitHub Release publish, smoke checklist).

## Conventions

Going forward, changelog entries follow [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) framing — write "your AI" / "the AI" generically; use "Claude" as the concrete example when a feature is Claude-specific (e.g. channel push, plugin monitor, cowork, auto-launcher, plugin marketplace). Past entries (v0.12.0 and earlier) are historical record and not rewritten.
