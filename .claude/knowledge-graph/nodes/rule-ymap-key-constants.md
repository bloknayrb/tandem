---
id: rule-ymap-key-constants
type: rule
name: Y.Map keys from constants only
last_verified: 2026-05-18
sources:
  - src/shared/constants.ts
  - CLAUDE.md
---

# Rule: Y.Map key strings from constants only

Use `Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, `Y_MAP_DOCUMENT_META`, `Y_MAP_USER_AWARENESS`, `Y_MAP_MODE`, etc. from `src/shared/constants.ts` — **never raw string literals** for Y.Map keys.

**Why this matters:** a typo in a raw string is silent and the resulting Y.Map will be empty (or a parallel map will exist that no observer is watching). Constants are typo-loud (typecheck fails) and grep-able for ownership.

**Enforced by:** convention + code review. Not currently hooked, but a regex linter (`.claude/hooks/check-ymap-keys.sh`) warns on PostToolUse for new raw-string Y.Map accesses.

Applies to: every Y.Map access on `concept-y-doc`, `CTRL_ROOM`, and per-document Y.Docs.
