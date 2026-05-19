---
id: rule-e2e-data-testid
type: rule
name: E2E tests use data-testid
last_verified: 2026-05-18
sources:
  - tests/e2e/
  - CLAUDE.md
---

# Rule: E2E tests use data-testid attributes

Playwright E2E tests select elements by `data-testid` (kebab-case), never by class name, role, or text content (except when testing accessible labels).

**Why this matters:** Svelte component refactors, class-name churn, and i18n changes all break tests that select by anything-but-testid. Testid is the only selector that survives normal UI evolution.

**Convention:** kebab-case, semantic name (`accept-btn`, `annotation-card-{id}`, `palette-input`). When adding new interactive elements that ship to production, add a testid even if no test currently uses it — adding testid retroactively after a regression is more expensive than adding it preemptively.

The full canonical list of testids in active use is in `CLAUDE.md` under the E2E section — when adding new ones, append to that list to keep it discoverable.
