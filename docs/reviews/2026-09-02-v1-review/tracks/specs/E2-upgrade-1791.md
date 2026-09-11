# E2-upgrade — #1791 a new enum value quarantines the whole annotation file, and the `.future` park deletes the only parked copy on the second cycle

Branch `fix/upgrade-and-downgrade-paths-annotation-envelope-compatibility-and-settings-that-go-silently-inert-1791`. Closes #1791 (both halves). Ledger: `docs/reviews/2026-09-02-v1-review/areas/upgrade-path.md:19` (park) and `:20` (enum quarantine). Probes: `experiments/upgrade-envelope-probe.ts` (pre-existing) and `experiments/future-park-probe.ts` (new, added by this branch).

**Both halves measured on this branch before designing.** `npx tsx docs/reviews/2026-09-02-v1-review/experiments/upgrade-envelope-probe.ts` prints `good + additive field => ok, 2 annotations kept` / `good + future type => FAIL error=corrupt` / `good + future status => FAIL error=corrupt`. `TANDEM_APP_DATA_DIR=$(mktemp -d -t tandem-XXXXXX) npx tsx …/future-park-probe.ts` drives the **real** `createStore(...).load()` through two downgrade cycles and prints `after downgrade #1: .future = USER-NOTE-FROM-CYCLE-1`, `after downgrade #2: .future = CYCLE-2`, `CYCLE-1 PARKED COPY DESTROYED`, with exactly one `.future*` file left in the directory. One cycle looks fine; two is what shows it.

## Problem

**(a) One unreadable row fails the whole envelope.** `schema.ts:4-13` promises forward compatibility via `.passthrough()`. That holds for new *fields* only. `AnnotationRecordSchemaV1` (`schema.ts:105-111`) types `type`/`status`/`author` as the closed `z.enum`s from `src/shared/types.ts:17,19,23`; one unknown value fails the row, `z.array` fails `AnnotationDocSchemaV1` (`schema.ts:215-224`), `parseAnnotationDoc` returns `corrupt`, and `loadOne` (`store.ts:620-631`) renames the file `.corrupt.<ts>` and returns an empty doc. Every annotation is gone, **including the user's personal notes** (ADR-027), not only the row the older build could not read.

**(b) The `.future` park destroys the previous park.** `loadOne` (`store.ts:635-648`) runs `fs.unlink(futurePath)` *before* `fs.rename(target, futurePath)`, and reports to stderr only where the corrupt path toasts. `.future` is the sole surviving copy of the pre-downgrade annotations — nothing ever reads it back — so the second downgrade cycle deletes it. This also falsifies `doctor.ts:2898-2900`'s "they are never deleted". Dormant until `SCHEMA_VERSION` (`schema.ts:29`) moves; `migrations/v1_to_v2.ts` and `migrateUp` are already wired at `schema.ts:350`.

## Fix

**`src/server/annotations/schema.ts` — row-level tolerance, inside `parseAnnotationDoc` only.** No schema restructuring: after `migrateUp` (`:350`) and *before* `AnnotationDocSchemaV1.safeParse`, filter `annotations` and `replies` row-by-row with `AnnotationRecordSchemaV1` / `AnnotationReplyRecordSchemaV1`, counting drops; build the object handed to `safeParse` as `{ ...migrated, annotations: kept, replies: kept }` (a spread, so `.passthrough()` keys survive) rather than mutating the caller's arrays. The precedent is `migrateToV1` (`:400-440`), which already does exactly this per-row skip-and-count with a `console.error` naming each dropped id — copy its log shape.

- **`tombstones` stays a hard `z.array` — deliberate asymmetry, and it is load-bearing.** Dropping a tombstone row resurrects a deleted annotation (#700/#695, `sync.ts:263-266`). `TombstoneRecordSchemaV1` is `{id, rev, deletedAt}` with no enum, so no additive enum change can reach it; a bad tombstone row is real corruption and must still fail the envelope. Say so in a comment at the filter.
- `ParseAnnotationDocResult`'s ok arm becomes `{ ok: true; doc; skipped: { annotations: number; replies: number } }`. The four `src` call sites (`store.ts:617`, `rename-recovery.ts:134`, `session/manager.ts:1000,1161`, `cli/annotation-store-scan.ts:311`) only read `.doc`/`.error` and need no change.
- The envelope shell (`schemaVersion`, `docHash`, `meta`) still failing → `corrupt`, unchanged.

**`src/server/annotations/store.ts` — surface it, and keep a copy.** In `loadOne`, on `result.ok` with `skipped.annotations + skipped.replies > 0`: `fs.copyFile(target, `${target}.corrupt.${Date.now()}`)` (catch-and-log) **before** returning the partial doc, then a notice. The copy is not optional — `sync.ts`'s `snapshot()` (`:182`) rebuilds the envelope from Y.Map state, so the skipped rows are permanently gone on the next debounced write. Reusing the existing `.corrupt.<ts>` suffix is deliberate: `cli/annotation-store-scan.ts:228` already counts it, `ENVELOPE_FILENAME_RE` (`session/manager.ts`) and `ATOMIC_TEMP_RE` (`file-io/reaper.ts:39`) both refuse to match it, so no sweeper contract changes.

**`store.ts` park order.** Replace `await fs.unlink(futurePath).catch(() => {})` with `await fs.rename(futurePath, `${futurePath}.${Date.now()}`).catch(() => {})` — archive the previous park, then rename `target` onto `.future`. **Keep `.future` as the primary park name**: `store.test.ts:221` pins "parks the file at `.future` without timestamp", `cli/annotation-store-scan.ts:229` filters `endsWith(".json.future")`, and `doctor.ts:2896` reads that count. A timestamped *primary* name would silently break all three.

**Both branches get a notice.** Add `notifyLoadIssue(docHash, filePath, message, dedupKey)` beside `notifyFailure` (`store.ts:399`) — `pushNotification` with `type: "annotation-error"` (not `"save-error"`: `activityCenter.ts`'s `formatActivityMessage` folds `errorCode` into `save-error` messages only), `severity: "warning"`, **past tense** (`types.ts:646-654`: warning/error persist in the tray, which is a log). No path in the message — only `path.basename`, as `notifyFailure:412` does.

**`src/cli/doctor.ts:2896`** — widen the parked filter in `cli/annotation-store-scan.ts:229` from `endsWith(".json.future")` to `includes(".json.future")` so the archived parks this fix now creates are visible, and drop "they are never deleted" from `doctor.ts:2899` only if it is still false (it is now true — keep it).

**Rules that bite:** no Y.Doc writes here, so no origin helper applies; `notifyLoadIssue` must not embed an absolute path (#1816); `console.error` with a user-named basename goes in as a `%s` argument, never the format string (CodeQL `js/tainted-format-string`, `store.ts:448`).

## Tests

`tests/server/annotations/schema.test.ts`:
1. Envelope with one good row + one `type: "suggestion"` row → `ok: true`, one annotation kept, `skipped.annotations === 1`. Kills a fix that only widens the enums (which would keep **two**) and a fix that only changes the store.
2. Same for an unknown `status` and an unknown `author`, and for a bad **reply** row → `skipped.replies === 1`.
3. **A malformed `tombstones` row still returns `corrupt`.** Kills an over-tolerant fix that filters all three arrays and resurrects deleted annotations.
4. **Migration of the two pinned contracts** at `:118` and `:124` (wrong-typed field; annotation missing `rev`): they assert `{ok:false, error:"corrupt"}` today and must become `ok: true` with `skipped.annotations === 1`, each with a comment saying the row-level tolerance is what relaxed them. Envelope-level cases (`:88`, `:107`, `:112`) stay `corrupt` unchanged — that split is the discriminator.

`tests/server/annotations/store.test.ts`:
5. Partial-parse load: a file with one good and one unknown-`type` row → `load()` returns one annotation, a `<hash>.json.corrupt.<ts>` **copy** exists, and `<hash>.json` is **still present** (kills a fix that reuses the rename).
6. **Two-cycle park** (the probe, as a spec): write a v2 envelope, `load()`, overwrite with a second v2 envelope, `load()` again; assert `.future` holds cycle 2 **and** exactly one `.future.<ts>` archive holds cycle 1. One cycle passes on the broken code; two is the only shape that fails it.
7. **Migrate `store.test.ts:235`** ("No toast for future (expected during downgrade)") to assert a notice IS pushed, with a comment naming #1791 as what reversed it.
8. Mutation-test (lesson 5): revert the `unlink`→`rename` line and watch test 6 go red; revert the row filter and watch test 1 go red; restore from a file copy, never `git checkout`.

## Done when

The two probes print the preserved outcome; tests 1-7 green; `npm run typecheck` + `npm test` green; the three migrated assertions each carry a why-comment.

## Not in scope

Reading a `.future` file back on a later upgrade (nothing does today; the park is an archive, not a queue). A `skippedRows` counter in `annotation-store-scan.ts` / a second doctor check for it — the load-time notice is the surface #1791 asks for. `notifyFailure`'s "Failed to save annotations" wording on the *corrupt-load* path (wrong verb, pre-existing, not this issue). Bumping `SCHEMA_VERSION`.
