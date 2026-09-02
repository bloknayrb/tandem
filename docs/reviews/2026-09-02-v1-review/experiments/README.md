# Reproduction scripts

Run every script from the **repository root**. Imports are relative to this folder, so moving a
file breaks it. None of these is collected by `npm test` (the vitest include is `tests/**`), and
none is typechecked or linted; they are evidence, not product code. Several use raw
`doc.transact(...)` because they stand outside `src/` and the origin-tag rule.

Two ports are used by the server probes, 4918 and 4919. They are the review's scratch pair: not the
product's 3478/3479 and not the E2E harness pair in `scripts/test-ports.ts`.

## Server and file-io (`npx tsx <file>`)

| Script | Reproduces | Still broken when the output shows |
|---|---|---|
| `e1-docx.ts` | #1754: Word comment offsets drift by +1 per empty paragraph and −1 per page break; tabs are fine. | CASE 1 prints `"delta"` → `"elta"`; CASE 2b prints a range ending `"arget\n"`; CASE 2c matches. |
| `exp6.ts`, `exp7.ts` | #1754: `w:tab`, `w:br`, `w:sym` make `applyTrackedChanges` throw "Flat text mismatch"; footnote refs and headings in cells mis-anchor. | Any `Flat text mismatch` line. |
| `exp4.ts` | #1750: a 75-character Cyrillic path → ENAMETOOLONG in `sessionKey`; #1755: body images dropped on docx import. | `ENAMETOOLONG`; image count 0 after import. |
| `exp2.ts`, `exp8.ts` | #1751: marks inside frontmatter, footnote definitions, HTML blocks and code blocks serialize as `<bold>…</bold>`; #1752: mid-surrogate offsets accepted and U+FFFD written. | Literal `<bold>` or `<italic>` in the saved markdown; `�` in the text. |
| `exp5.ts` | #1753: `[[wikilinks]]` saved as `\[[…]]`; user escapes stripped. | Output differs from input on the wikilink cases. |
| `exp3.ts` | #1800: a truncated `ydocState` throws on restore and nothing quarantines it. | `THROWS` for the cut cases. |
| `e5-merge.ts`, `e5b.ts` | #1765: cross-block `tandem_edit` merge deletes the tail element; anchors re-anchored from stale offsets as `repaired`. | The annotation on the last word of the merged paragraph reads `""` or `"ilon zeta"`; controls (same-block, third paragraph) stay right. |
| `e6-snapshot.ts`, `e6b.ts` | #1767: a lone high surrogate at the 200-char snapshot cap becomes U+FFFD after any Yjs round-trip, so relocation is RANGE_GONE and `snapshotContradicts` flips. | `post-roundtrip contradicts: true`; the JSON path stays `false`. |
| `crdt-verify.ts` | #1764 (Enter before/inside an annotation collapses to `{4,4}` and is persisted), the `repaired` arm re-anchoring from stale offsets, #1766 (spanning heading range accepted), zero-length ranges, hardBreak `from` drift (#1823). | The section prints `{4,4}`, `{4,5}`, `{1,1}`; `validateRange(4,9)` passes with `rejectHeadingOverlap`. |
| `e3-table.ts`, `ul3.ts` | Refuted claim: escaped `\|` in table cells round-trips. | `DIFF` on the escaped-pipe case would reopen it. |
| `e4-heading.ts`, `e4b.ts` | Refuted claim: a hard break in a heading counts as one flat char. Low: setext hard break lost on save. | A miscount in the heading case would reopen it. |
| `rt.ts` | The 107-construct markdown round-trip corpus (verified fine). | Any construct not idempotent. |
| `watch-rename.mjs` | #1749: `fs.watch` emits `change, rename, rename` after a rename-replace, then nothing for later writes. | Fewer events than writes after the rename. |
| `epipe.mjs`, `epipe2.mjs`, `epipe3.mjs`, `epipe4.mjs` (`node <file>`) | #1757: writing to a child's closed stdin raises EPIPE as an uncaught exception; no `stdin.on("error")` catches it. | `UNCAUGHT: EPIPE`. |
| `probe-redos.mts` | #1795: `(a+)+$` on 29 characters blocks for ~20 s; the 2 s guard never fires. | `elapsed ms` above 2000. |
| `probe-tools.mts` | In-memory MCP client against the real tool registrations: #1752 (`edit(6, 99999)` deletes to end), #1768 (no-arg `restoreBackup` on `.docx`), #1796, #1797, and the error-code inconsistencies in #1823. | Each case prints its own PASS/FAIL line. |
| `upgrade-envelope-probe.ts` | #1791: a new enum value in a stored annotation fails the whole envelope to `.corrupt`; passthrough covers new fields only. | Parse throws on the unknown `type` case. |
| `yjs-race.ts` | #1826: concurrent `map.set` on one key resolves by clientID. | Documents the ordering; no failure line. |

## Client harness (`npx vitest run --config docs/reviews/2026-09-02-v1-review/experiments/harness/vitest.config.ts`)

Tiptap in happy-dom with the production schema. **A passing test here means the bug reproduces**;
the assertions encode the wrong behaviour so a fix turns them red. Rewrite each into a real spec
under `tests/client/` when the fix lands.

| File | Reproduces |
|---|---|
| `harness/a-bugs.test.ts` | #1774 find/replace off by one per hard break; #1775 slash menu inside a code block; #1776 `activity.cursor` written as a PM position (38 vs flat 32). |
| `harness/e-keys.test.ts` | #1777: Ctrl+Enter inserts a hard break and resolves the pending annotation; AltGr letters on pl/ro/cs/de layouts fire shortcuts (synthetic events; the Playwright lane confirmed the DOM half). |
| `harness/f-undo.test.ts`, `f2-undo.test.ts`, `f3-undo.test.ts` | #1764: plain undo recovers the block-split collapse; after a re-anchor, undo trips the inverted-range guard and the range is `failed` forever. |
| `harness/d-flat.test.ts` | PM ↔ flat mapping byte-identical to the server's `extractText` on 24 corpus shapes (verified fine). |
| `harness/g-inbox-ledger.test.ts` | #1770 item 3: accept → poll → undo → dismiss → poll returns `userResponses: []`. |

The six client Highs were also confirmed in a real browser (Playwright on the reserved harness
ports); that spec was deleted after the run and its log is `../raw/verify-client.txt`.

## Server probes (`server-probes/`)

`run.sh` starts a scratch server on 4918/4919 with the license gate **armed** and an isolated
app-data dir under the OS temp directory; `run2.sh` runs the built server (`npm run build:server`
first) with the gate dark, which is the only way the static layer mounts under a probe.
`wsprobe.mjs <ws-url> <MiB>` sends one oversized frame to Hocuspocus before authenticating
(#1822 item 2: 90 MiB is accepted, 120 MiB closes 1009); `wsidle.mjs <ws-url>` checks the idle
close. The HTTP probes in `../raw/gapfill-F.txt` (mode/release origin matrix, `/api/open` with an
outside path, `/api/license/status` while dark, text/plain CSRF, unknown `Mcp-Session-Id`) were
`curl` one-liners against these servers and are reproduced there verbatim.

## Test-quality scanners

`scan-zero-assert.mjs`, `scan-subject-mock.mjs`, `scan-stale-mock.mjs` and `find_no_expect.py`
walk `tests/` and print candidates: test bodies with no `expect`, suites that mock their own
subject, and `vi.mock` targets that no longer exist. They found #1783's vacuous tests and the
mocked-subject inventory in `../raw/gapfill-G.txt`; every hit was read by hand before filing.
