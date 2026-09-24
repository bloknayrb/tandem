# Spike report: SuperDoc as Tandem's `.docx` engine (ADR-052)

**Plan:** [superdoc-engine-spike-plan.md](superdoc-engine-spike-plan.md)
**Run:** 2026-09-23 to 2026-09-24, in Docker containers only.
**Status:** Shelved (2026-09-24). ADR-052 is shelved and `.docx` ships dark (ADR-053).
**Decision it serves:** [ADR-052](../decisions.md#adr-052-superdoc-replaces-the-docx-readwrite-pipeline-server-side-behind-the-existing-editor)

The plan's Output section limits this report to one verdict per question: GO, NO-GO or NOT RUN.
The results behind each verdict are kept locally, and publishing any of them is Bryan's call.

- **GO:** every pass criterion was met, each by a positive case.
- **NO-GO:** at least one pass criterion was run and not met.
- **NOT RUN:** at least one pass criterion was not exercised, and none was run and not met.

The verdicts are against the plan's criteria as written.

| question | verdict |
|---|---|
| S1 — headless in the sidecar (kill gate) | **NO-GO** |
| S2 — nothing leaves the machine (kill gate) | **NOT RUN** |
| S3 — a usable, private Y.Doc on import | **NO-GO** |
| S4 — offsets land on the right characters | **NO-GO** |
| S5 — the save is a correct splice | **NO-GO** |
| S6 — comment engine facts | **NO-GO** |
| S7 — tracked changes | **NO-GO** |
| S8 — hostile input | **NO-GO** |
| S9 — what the Y.Doc does not model | **NO-GO** |
| S10 — the safety net | **NO-GO** |
