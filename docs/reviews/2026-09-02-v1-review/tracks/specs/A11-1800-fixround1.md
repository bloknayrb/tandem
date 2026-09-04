# A11-1800 fix round 1 — read-only review of pushed `fe6ff7a`

Two Real findings, both low severity, both fixed small. No behavior change
beyond R1/R2. No test renames. Boundary and config-writer pins untouched
(R1 is a callee swap within one statement; R2 touches no imports).

## R1 — Evict-failure isolation stopped one scope short

`maybeRestoreSession` guarded only the `restoreYDoc` call. The
empty-fragment fall-through called `evictPartialDocStateAndAuthorship`
bare, so a throwing evict propagated out of `maybeRestoreSession` and
`openFromDisk` rejected — the #1800 symptom on a path that opened fine
before the PR.

Resolution: the fall-through now calls the simplify-factored
`evictBestEffort` helper (swallow; already falling back to disk, nothing
left to protect). Fall-through semantics otherwise identical — still inside
`if (!changed || dirtySession)`, still before the shared return.
(`src/server/documents/open.ts`, fall-through comment extended.)

Test: `evict failure on the empty-fragment path still opens from disk`
(empty dirty fragment fixture + `evictShouldThrow`, mirrors the existing
evict-failure twin: resolves `fresh` from disk, healthy session file
untouched, fall-through log fires, no session-corrupt toast). Verified red
with the bare call (`evict boom (test)` escapes `openFromDisk`), green
with the guard.

## R2 — Unreadable-winner promoted the superseded legacy record

`loadSessionWithPath` consulted the loser for ANY non-ok winner reason.
Only `unparseable` renames the winner away; for `unreadable`/EACCES (the
#1599 AV-lock shape) nothing was renamed, so an AV-locked current session
beside a leftover legacy file restored the SUPERSEDED legacy with
`restored: true` — the old code deliberately returned null here and fell
to disk.

Resolution: promote the loser ONLY when the winner was renamed away
(`reason === "unparseable"`); otherwise return null. This also closes the
torn-read race (winner statted, then vanished) in the same direction: a
vanished winner is torn state, disk is the safe answer. The docblock
defense sentence now states the exact condition instead of claiming a
promoted loser is never a resurrection. (`src/server/session/manager.ts`.)

Test: `EACCES-locked winner falls to disk instead of promoting the legacy
record` (scoped `fs.readFile` mock throwing EACCES on the winner path
only, installed after fixtures; healthy legacy with disk-divergent text
present). Asserts disk content, both session files untouched, no
quarantine, no toast. Verified red under the old code (open restored the
legacy branch text `'Shared opener paragraph.\nOlder diver…'`), green
with the guard.
