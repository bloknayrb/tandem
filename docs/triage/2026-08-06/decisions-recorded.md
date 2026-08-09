# Decisions recorded — 2026-08-08

Every row of [decision-queue.md](decision-queue.md) was answered by Bryan on 2026-08-08, in
annotations on the document itself. This file records what was decided and where each decision now
lives, so the queue document stays readable as the *question* artifact and this one carries the
*answers*.

Three rows (D-6, D-12, D-16) had already been decided before the queue was reviewed; they are
included for completeness.

## The sixteen

| Row | Issue(s) | Decision | Recorded |
|---|---|---|---|
| D-1 | #989 #964 #928 #916 | Defer past v1.0 | `deferred` label, comment |
| D-1 | #892 | **Close** — superseded by #917 | closed |
| D-1 | #832 | Split: PeekStrip fix now, rest deferred | comment, `deferred` |
| D-2 | #316 #317 #552 | Cowork auto-setup is Windows-only for v1.0 | comment, `deferred` |
| D-3 | #997 | **Close** — extend the native menu instead | closed |
| D-4 | #995 | `/table` 3×3 ships; alignment + row ops deferred | retitled, comment |
| D-5 | #994 #1262 | Allowlist context-menu policy; Appearance/Editor split | comment |
| D-6 | #992 | Themed native menus, Option 1 (~40 lines) | pre-decided |
| D-7 | #321 | **Park** with a named reopen trigger | comment, `deferred` |
| D-8 | #438 | **Close** — superseded by ADR-045 / #1233 | closed |
| D-9 | #798 | GA gates on the shipped subset; A6b/A16b exempt | comment; closes with the docs PR |
| D-10 | #1263 | Chat remains global | comment; closes with the ADR |
| D-11 | #1308 | Kill the KG, keep `/diverge` — already done by #1311 | comment |
| D-12 | #1287 | Fix the copy; do not suppress the pill | pre-decided |
| D-13 | #630 | Rewrite to items 4–7 + 8; macOS gap split out as #1344 | comment |
| D-14 | #1213 | **Keep both Solo gates permanently** | retitled + body corrected |
| D-15 | #1197 | Disable the job; revisit 2026-11-01 as #1345 | comment; #1345 filed |
| D-16 | #1045 | Declined — no CLI version pin | pre-decided, closed |

## The three that were not in the original sixteen

| Issue | Decision |
|---|---|
| #1320 | **Option 3** — declare `/api` loopback-only as an invariant, with the Cowork and `shutdown` carve-outs enumerated by name |
| #1334 | **Exit 1** — measure the status flip, not the accept control's removal; keep the 500 ms budget |
| #1292 | **Stays open.** Blocks the BYO-models flag flip, not the release. `roadmap.md:614` stays FAIL for that gate specifically |

## New issues filed

- **#1344** — macOS Opened-event opens skip the extension and `is_file()` checks the argv path
  performs, so the failure is silent. Split out of #630.
- **#1345** — 2026-11-01: revisit packaged-desktop WebDriver smoke coverage. The dated home for
  D-15's deferral.
- **#1346** — ADR-040 amendment: unlicensed means a plain markdown editor with no AI integration at
  all, rather than a read-only AI. Raised in the margin of #1320.

## Three corrections made while recording

Worth keeping, because each is a claim that would have shipped as fact.

**#1213's remaining work was smaller than the issue said.** Step 1 has already shipped — the
forwarder gate is `shouldForwardExternally` at `queue.ts:175-180`, applied at both `pushEvent`
(`:277-283`, gating only `externalSubscribers`) and `replaySince` (`:365`), holding every event type
in Solo rather than just accept/dismiss + `document:*`. The CRDT-F1 sub-item is covered too, by the
`isModeReleaseWake` id exemption. Only step 2 remained, and step 2 is now declined.

**The macOS item-2 finding was partly wrong.** A triage pass reported that the macOS Opened-event
path surfaces no rejection toast on any surface. It does — `handle_opened_urls` emits
`EVENT_STARTUP_FILE_REJECTED` directly at `lib.rs:704`, deliberately bypassing the buffer because an
Apple Event arrives post-launch. The real defect is upstream: `classify_opened_url`
(`lib.rs:462-470`) tests only scheme, host and path conversion, with no extension or `is_file()`
check, so the realistic failure passes classification and dies downstream in a `log::warn!`. Filed
accurately as #1344. Fixing the emit path would have been fixing the wrong thing.

**A third line reference was wrong and nearly propagated.** The collaborator's `document:*` abort is
at `collaborator.ts:417-421`, not the `~286-290` the issue cites nor the `:302-303` the triage doc
carried forward. Three separate citations for one site, none of them right — the same pattern as the
#1320 route count, where four enumerations produced 4 → 11 → 9 → 10 and only the one that re-derived
from source was correct.
