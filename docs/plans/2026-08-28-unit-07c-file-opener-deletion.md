# Unit 7c — Move the reload family into `documents/`, then delete `mcp/file-opener.ts`

**Status:** reviewed (two adversarial passes), ready to implement
**Depends on:** #1661 (Unit 7b) — merged 2026-08-28, `c4fd26b`
**ADR:** [ADR-034](../decisions.md#adr-034-file-open-pipeline) · **Programme:**
[2026-08-24 maintainability remediation](2026-08-24-ai-assisted-maintainability-remediation.md), Unit 7c

## References

| Thing | Where |
|---|---|
| The module being deleted | `src/server/mcp/file-opener.ts` (376 lines, 3 exports) |
| Its four production consumers | `mcp/docx-apply.ts:30`, `mcp/routes/backups.ts:25`, `mcp/routes/external-conflict.ts:9`, `mcp/routes/document-reload.ts:9` |
| Per-symbol allowlist + module sweep | `tests/server/documents-open.test.ts` — `SANCTIONED` :129, `ENTRIES` :103, `seam`/`impl` :145, specs :219 and :246 |
| Import-edge inventory | `tests/docs/documents-boundary.test.ts` — `FAN_IN` :260, `FAN_OUT` :325, export pin :589 |
| Reload-skip caller inventory | `tests/server/open-result-consumption.test.ts:105` (`CALLERS`) |
| #1599 config-writer inventory | `tests/docs/config-writer-set-claims.test.ts` — `DURABLE_WRITER_FILES` :203, `WRITER_SITES` :123, `SCAN_ROOTS` :343 |
| The origin tags being moved | `file-opener.ts:313` and `:415` — two `withInternal` calls |

## What is left in the module

Unit 7a moved everything that *opens* a document to `documents/open.ts`. What
remains is three functions that **replace the content of an already-open
document**:

| Export | What it does |
|---|---|
| `reloadDocumentFromMarkdown(id, markdown)` | Replaces an open `.md` document from a caller-supplied string (the raw-source editor), then persists for `source: "file"` docs |
| `restoreDocumentFromBackup(id, backupName)` | Restores `.md`/`.txt`/`.docx` from a pre-overwrite snapshot, snapshotting current disk state first |
| `resolveExternalConflict(id, choice, expectedDetectedAt?)` | Answers the conflict banner — `"keep"` clears the flag and re-baselines, `"reload"` routes through `reloadFromDisk` |

All three depend on `documents/watcher.ts`'s reload guard
(`acquireReloadGuard` / `releaseReloadGuard` / `isReloadInProgress`) and on
`reloadFromDisk`. That dependency is why `watcher.ts` exports the guard outward
today rather than keeping it private — its own header says so
(`watcher.ts:9-15`). Moving these three is what lets that stop being an
exception.

## The design

**All three go into one new module, `src/server/documents/reload-family.ts`.**
The name is the one ADR-034 and `CLAUDE.md` already use for them.

**Why not split `resolveExternalConflict` into `documents/conflict.ts`**, which
already owns the read and write halves of `Y_MAP_EXTERNAL_CONFLICT` and where
resolving the flag reads like its third half: `watcher.ts:45` imports
`flagExternalConflict` and `readPendingConflict` from `conflict.ts`, and
`resolveExternalConflict` needs `reloadFromDisk` from `watcher.ts`. That is
`conflict.ts → watcher.ts → conflict.ts`. Verified by reading both import
blocks.

A variant *does* escape the cycle — move the flag's read/write pair out of
`conflict.ts` so `watcher.ts` stops depending on it. **Not this unit**, and
probably not any unit: it un-does the thing Unit 7a's conflict split existed to
do, which was putting one piece of state's two halves in one module. Recorded
so a later reader knows it was considered rather than missed.

Splitting the other two apart is three modules for three functions sharing one
guard protocol and one contract. One module.

They do **not** go into `watcher.ts`. That module is the watch loop plus
`reloadFromDisk`; these three are caller-initiated content replacement that
*uses* the loop's primitives. Merging them makes a ~600-line module with two
unrelated entry surfaces, and the guard's acquire/release contract stops being
a published interface with named external callers — which is what made it
reviewable.

## What the move costs

Each is a real edge, and each belongs in the PR body.

1. **`documents/` gains a second edge into `mcp/document-service.ts`**, for
   `canSaveToDisk` / `saveDocumentToDisk`. `documents/autosave.ts` already has
   one, and `documents-boundary.test.ts:350` calls it "the ONLY thing in
   `documents/` still reaching `document-service`." That sentence becomes false
   and must be **rewritten, not deleted**. Both edges disappear together when
   `autoSaveAllToDisk` moves out of `document-service` — later work.
2. **`documents/` gains outward edges** to `file-io/doc-backup.ts`,
   `file-io/docx-size-gate.ts`, `file-io/index.ts`, `file-watcher.ts`,
   `platform.ts`, `yjs/provider.ts`. All one-directional.
3. **Six `FAN_IN` rows disappear** (`mcp/file-opener.ts → documents/*`, lines
   276, 277, 281, 282, 283, 289). Their rationale comments explain why
   *`mcp/` reaching into `documents/`* was acceptable; that story no longer
   applies, so the comments are rewritten, not just deleted with the rows.
4. **Four production consumers repoint**, turning `mcp/* → mcp/*` edges into
   `mcp/* → documents/*` — a direction `FAN_IN` already tracks.

**No cycle is created.** Traced every module `reload-family.ts` would import;
none imports back. `mcp/document-service.ts:39-40` already imports
`documents/open.ts` and `documents/watcher.ts` directly and no longer imports
`file-opener.ts` at all, so `reload-family.ts → document-service.ts → documents/*`
is one-directional.

**No coordinate-system or re-anchoring risk.** None of the three calls
`anchoredRange` / `refreshAllRanges` / touches `relRange`; that logic is in
`populate.ts` and `watcher.ts`, which do not move.

## The guards that change, and the trap in each

Four inventories name the module by path. Review found that the risk is **not**
evenly distributed: two fail loudly if under-fixed, one goes silently vacuous,
and one never checked the property it is being asked to defend.

### `tests/server/documents-open.test.ts` — one spec dies silently

Three things beyond `SANCTIONED` must move:

- `ENTRIES` (:103) derives its vocabulary by **importing the module being
  deleted**. It throws on a missing module — loud, not silent, but it means the
  file needs real surgery, not a one-line edit.
- `seam` / `impl` (:145) are path constants, and `impl` is a **required member**
  of the walked-file list at :227. It fails hard once the file is gone.
- The second spec, *"sanctioned modules take only the symbols they are
  sanctioned for"* (:246), loops `Object.entries(SANCTIONED)`. **Emptying the
  list makes it run zero assertions** — and unlike the first spec, no positive
  control can be bolted on, because there is no row to plant one in.

An earlier draft of this plan said "empty the list, add a positive control,"
which patches the file-level sweep and lets the per-symbol allowlist die. The
defeat: add `import { resolveExternalConflict }` to `routes/backups.ts`, which
is only entitled to `restoreDocumentFromBackup`. Green, forever.

**Fix: migrate the allowlist, do not empty it.** `SANCTIONED` re-keys on
`documents/reload-family.js` with the same four consumer rows and the symbols
each is entitled to. The invariant survives the move instead of being deleted
along with the module that motivated it.

### `tests/docs/documents-boundary.test.ts` — five assertions, not one

An earlier draft named only the export pin (:589). Also touched: the `FAN_IN`
exact-set (:260), the `FAN_OUT` exact-set (:325, gaining the seven new rows
from *What the move costs* 1–2), the per-target "has a namer" sweep, and the
Tarjan no-internal-cycle check. All fail loudly. The export pin's own comment
says "7c deletes the module" — the **new** module inherits the pin, or the
property it buys (nobody adds a fourth reload entry unwritten-down) is lost.

### `tests/server/open-result-consumption.test.ts` — no trap

`"server/mcp/file-opener.ts"` → `"server/documents/reload-family.ts"` in
`CALLERS`. Exact-set equality; fails loudly. Listed so the edit is deliberate.

### `tests/docs/config-writer-set-claims.test.ts` — the claim with no checker

`DURABLE_WRITER_FILES` pins the **scope of the #1599 accepted security
finding**, and `CLAUDE.md` says adding a config writer is what widens it.

An earlier draft said the edit "must be verified as a rename, not a change of
set," without saying how. Review established there is no how:
`DURABLE_WRITER_FILES` is compared as a **set of paths** (:371), and the
per-file count mechanism `WRITER_SITES` is scoped to
`SCAN_ROOTS = ["src/server/integrations", "src/cli"]` (:343) — which does not
include this file. So a durable write **added** during the move passes every
assertion, under cover of a path edit. That is the exact widening the
inventory exists to prevent, and "verified as a rename" was narrative.

**Fix: make it checkable.** Apply the file's own `durableWriteSites()` counter
(:275) to `git show <merge-base>:src/server/mcp/file-opener.ts` and to the new
`documents/reload-family.ts`, and assert the counts are equal — as a spec, not
a sentence in a PR body.

## Origin tagging — the omission that mattered most

The three functions carry **two `withInternal` calls** (`file-opener.ts:313`,
`:415`), the only Y.Doc-write origin tags in the module. Critical Rule 2 says
picking the wrong helper is a silent bug, and a copy-paste across a module
boundary is exactly where one gets picked wrong.

Swapping `withInternal` for `withMcp` (or a raw `doc.transact`) during the move
would pass typecheck, pass every repointed test, and be invisible to all four
inventories — none of which inspects *how* a write is tagged. The only
detector today is the warn-only PostToolUse hook, which is not a gate.
`tests/server/external-conflict.test.ts` has no origin assertion at all.

**Fix, and it is a prerequisite rather than a nice-to-have:** add an origin
assertion to the conflict-resolution path *before* moving anything, so the
assertion exists on both sides of the move and the battery below has something
to turn red.

## Behaviour must not change

Nothing here changes what the three functions do.

- The four consumer tests (`restore-backup`, `reload-from-markdown`,
  `external-conflict`, `docx-size-gate-call-sites`) change **no assertion, no
  mock target, and no import target beyond the specifier path**. Anything more
  is evidence the move was not behaviour-preserving — investigate rather than
  edit. (Stated this way deliberately: an earlier "must not otherwise change"
  would have forbidden fixing the now-stale prose comments naming
  `file-opener` in `reload-from-markdown.test.ts:210` and
  `restore-backup.test.ts:17`, which are legitimate hygiene.)
- `tests/server/security-1121.test.ts:49` mocks by path — specifier only.
- Full `npm test`, `typecheck`, `typecheck:tests`, `cargo test`.

## Mutation battery

The guards are as much the deliverable as the move, so they get attacked. Rows
7–9 exist because review named a change that survived every row of the first
draft.

| # | Mutation | Expect |
|---|---|---|
| 1 | Re-introduce a `file-opener.js` import in a `src/` module | RED |
| 2 | Break the sweep's file walk (point it at an empty dir) | RED — the vacuity probe |
| 3 | Add a fourth export to `reload-family.ts` | RED (export pin) |
| 4 | Add a fifth `reloadFromDisk` caller | RED |
| 5 | Drop a `DURABLE_WRITER_FILES` entry | RED |
| 6 | Rename a function inside `reload-family.ts` without touching consumers | RED (typecheck) |
| **7** | **Give a consumer a symbol it is not entitled to** (`resolveExternalConflict` into `routes/backups.ts`) | **RED** — catches the per-symbol vacuity |
| **8** | **Add a new durable write inside `reload-family.ts`** | **RED** — catches a smuggled widening of #1599 |
| **9** | **Swap a `withInternal` for `withMcp`** | **RED** — catches a mis-tagged write |
| P1 | Reformat a consumer's import (multi-line) | GREEN |
| P2 | Add a comment naming `file-opener.js` in prose | GREEN |
| P3 | Add a non-writing helper to `reload-family.ts` | GREEN |

Rows 8 and 9 are RED only if their fixes above land first. If either turns out
not to be implementable, the row does not get dropped — the plan does.

## Docs to update

`CLAUDE.md` (the "`mcp/file-opener.ts` is now the reload family only" line
becomes false), `docs/architecture.md`'s `documents/` file map, and an ADR-034
amendment recording that 7c completed the split and what the two remaining
`documents/ → document-service` edges cost.

Two more that review found, **both already stale today** because Unit 7a moved
the open pipeline and neither was updated then — after 7c they become dangling
references to a deleted file:

- `docs/mcp-tools.md:1023` — "`/api/open` and `/api/upload` converge with `tandem_open` in `file-opener.ts`"
- `docs/decisions.md:781` — "consumed via direct imports from `mcp/convert.ts` and `file-opener.ts`"

Prose-only references in test files and `docs/lessons-learned.md`,
`docs/gotchas.md`, `src/server/file-io/docx-comments.ts:426` are deliberately
**not** gated (mutation P2 says so) and are left alone.

## Order

One PR. The programme's rollback rule says *do not delete the compatibility
module in the same PR that first redirects callers* — 7a already redirected
every open caller, and this redirects the reload callers and deletes the module
in one step, which is the same change either way.

**If review of the implementation disagrees, split it:** PR 1 adds the origin
assertion and the `durableWriteSites` count spec (both prerequisites, both
independently useful), PR 2 creates `reload-family.ts` and repoints consumers,
PR 3 deletes the empty module. The rollback rule is not mine to reinterpret.
