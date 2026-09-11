# E2-upgrade — #1791 a new enum value quarantines the whole annotation file, and the `.future` park deletes the only parked copy on the second cycle

Branch `fix/upgrade-and-downgrade-paths-annotation-envelope-compatibility-and-settings-that-go-silently-inert-1791`. Closes #1791 (both halves). Ledger: `docs/reviews/2026-09-02-v1-review/areas/upgrade-path.md:19` (park) and `:20` (enum quarantine).

**Both halves measured on this branch before designing.** `npx tsx docs/reviews/2026-09-02-v1-review/experiments/upgrade-envelope-probe.ts` prints `good + additive field => ok, 2 annotations kept` / `good + future type => FAIL error=corrupt` / `good + future status => FAIL error=corrupt`. `TANDEM_APP_DATA_DIR=$(mktemp -d -t tandem-XXXXXX) npx tsx …/future-park-probe.ts` drives the **real** `createStore(...).load()` through two downgrade cycles and prints `after downgrade #1: .future = USER-NOTE-FROM-CYCLE-1`, `after downgrade #2: .future = CYCLE-2`, `CYCLE-1 PARKED COPY DESTROYED`, with exactly one `.future*` file left. One cycle looks fine; two is what shows it. **Both probes are pre-fix measurement, not gates** — their predicates are written against today's behaviour, so neither is in Done-when and neither is edited by this branch.

## Problem

**(a) One unreadable row fails the whole envelope.** `schema.ts:4-13` promises forward compatibility via `.passthrough()`. That holds for new *fields* only. `AnnotationRecordSchemaV1` (`schema.ts:105-111`) types `type`/`status`/`author` as closed `z.enum`s; one unknown value fails the row, `z.array` fails `AnnotationDocSchemaV1` (`schema.ts:215-224`), `parseAnnotationDoc` returns `corrupt`, and `loadOne` (`store.ts:620-631`) renames the file `.corrupt.<ts>` and returns an empty doc. Every annotation is gone, **including the user's personal notes** (ADR-027), not only the row the older build could not read.

**(b) The `.future` park destroys the previous park.** `loadOne` (`store.ts:635-648`) runs `fs.unlink(futurePath)` *before* `fs.rename(target, futurePath)`. `.future` is the sole surviving copy of the pre-downgrade annotations, so the second downgrade cycle deletes it. Dormant until `SCHEMA_VERSION` (`schema.ts:29`) moves; `migrations/v1_to_v2.ts` and `migrateUp` are already wired at `schema.ts:350`.

## Fix

**1. `src/server/annotations/schema.ts` — row-level tolerance inside `parseAnnotationDoc` only.** No schema restructuring: filter `annotations` and `replies` row-by-row with `AnnotationRecordSchemaV1` / `AnnotationReplyRecordSchemaV1`, counting drops and `console.error`ing each dropped id; hand onward `{ ...candidate, annotations: kept, replies: kept }` (a spread, so `.passthrough()` keys survive). `migrateToV1` (`:400-440`) already does exactly this per-row skip-and-count — copy its log shape.

- **The filter runs BEFORE `migrateUp` (`:350`).** `migrations/v1_to_v2.ts:44-46` builds `FrozenV1InputSchema` and calls a **throwing** `.parse(input)` over every record; `schema.ts:351-356` catches that and returns `corrupt`. A filter placed after `migrateUp` evaporates at the `SCHEMA_VERSION` bump this fix exists to survive. One comment at each end saying the two are a pair.
- **Gated on `Array.isArray`; a non-array is left untouched** and still reaches `AnnotationDocSchemaV1.safeParse` → `corrupt`. **Never coerce a non-array `annotations`/`replies`/`tombstones` to `[]`** — that reports a successful load of zero annotations, which `loadAndMerge` (`sync.ts:568`) reads as `fileEmpty` and clobbers the envelope. That split is the envelope-vs-row discriminator the tests pin.
- **`tombstones` stays a hard `z.array`.** Dropping a tombstone resurrects a deleted annotation (#700/#695, `sync.ts:263-266`), and `TombstoneRecordSchemaV1` carries no enum, so no additive change can reach it. Comment it at the filter.
- Replies of a dropped annotation are retained as orphans, matching `loadAndMerge`'s existing rule. Counts are reported separately.

**2. `ParseAnnotationDocResult`'s ok arm becomes `{ ok: true; doc; skipped: { annotations: number; replies: number } }`, and `skipped` is a required consult at the two sites that PERSIST the parsed doc.** The five `src` call sites split by *writes back* vs *reads*, not by whether they compile:

- Read-only, no change: `store.ts:617` (handled below), `session/manager.ts:1000`, `cli/annotation-store-scan.ts:311`.
- **`session/manager.ts:1162` (`cleanupStaleTombstones`)** — today `if (!parsed.ok) continue;` is the only thing protecting a file with an unreadable row. After the fix it parses `ok`, `:1173` builds `rewritten` from the partial doc and `:1176-1177` flushes it, clobbering `<hash>.json` with the survivors. The open-doc guard at `:1151` means this fires on CLOSED documents. Change to `if (!parsed.ok || parsed.skipped.annotations + parsed.skipped.replies > 0) continue;` with a comment: *a partially-tolerated envelope is not a safe base for a full-envelope clobber.*
- **`annotations/rename-recovery.ts:135`** — same shape, worse ending: `:178` pushes `parsed.doc`, `:191` spreads it into `rekeyed`, `:204-205` flushes it under the NEW docHash, `:252` `fs.unlink`s the source. Same one-line change, keeping the function's existing "skip this candidate, never fail the recovery" semantics.

**3. `src/server/annotations/store.ts` — keep a copy of the partial file.** In `loadOne`, on `result.ok` with a non-zero `skipped` total, `fs.copyFile(target, \`${target}.corrupt.partial\`, fs.constants.COPYFILE_EXCL)` (catch-and-log, `EEXIST` is success) **before** returning the partial doc. Not optional: `sync.ts`'s `snapshot()` (`:182`) rebuilds the envelope from Y.Map state, so the skipped rows are gone on the next debounced write. **Deterministic name, written once** — the partial file is not always healed (`queueWrite` is inert under `isReadOnly()`; file-sync origins skip the durable queue, `sync.ts:284-286`), so a `Date.now()` name would write one copy per open forever. The `.corrupt.` infix keeps every sweeper contract unchanged (`annotation-store-scan.ts:228` counts it; `ENVELOPE_FILENAME_RE` in `doc-hash.ts:143` and `ATOMIC_TEMP_RE` in `file-io/reaper.ts:39` both refuse it).

**4. `store.ts` park order.** Replace `await fs.unlink(futurePath).catch(() => {})` with a rename of the existing park to `${futurePath}.${Date.now()}-${crypto.randomBytes(4).toString("hex")}` (the shape `atomicWrite` already uses; millisecond resolution alone can collide), then rename `target` onto `.future`. **Keep `.future` as the primary name** — `store.test.ts:221`, `annotation-store-scan.ts:229` and `doctor.ts:2896` all read it.

**Rules that bite:** no Y.Doc writes here, so no origin helper applies; a user-named basename goes into `console.error` as a `%s` argument, never the format string (CodeQL `js/tainted-format-string`, `store.ts:448`).

## Tests

`tests/server/annotations/schema.test.ts`:
1. One good row + one `type: "suggestion"` row → `ok: true`, one annotation kept, `skipped.annotations === 1`. Kills a fix that only widens the enums (which keeps **two**) and one that only changes the store.
2. Same for an unknown `status`, an unknown `author`, and a bad **reply** row → `skipped.replies === 1`; dropping an annotation leaves its replies in place.
3. A malformed `tombstones` row still returns `corrupt`. Kills an over-tolerant fix that resurrects deleted annotations.
4. **Exactly one pinned contract migrates**: `:124` (annotation missing `rev`) becomes `ok: true` / `skipped.annotations === 1`, with a why-comment. `:88`, `:107`, `:112` and `:118` stay `corrupt` — `:118` is `{...validDoc, annotations: "not an array"}`, an envelope-level failure with no rows to skip, and the only way to "migrate" it is the coercion the Fix forbids.

`tests/server/annotations/store.test.ts`:
5. Partial load: one good + one unknown-`type` row → `load()` returns one annotation, `<hash>.json.corrupt.partial` exists, `<hash>.json` is **still present** (kills a fix that reuses the rename). Loading the same file twice leaves exactly ONE copy.
6. Two park cycles: write a v2 envelope, `load()`, overwrite with a second, `load()` → `.future` holds cycle 2 **and** one `.future.<suffix>` archive holds cycle 1. Two cycles is the minimum that fails today's code.

`tests/server/session/` + the rename-recovery suite — the only tests that discriminate the `skipped` consult:
7. An envelope with one unknown-`type` row **and** a stale tombstone survives `cleanupStaleTombstones` **byte-for-byte**.
8. A rename-recovery source with one unknown-`type` row and a matching `contentHash` is **not** recovered: no envelope under the new hash, source file still present.

9. Mutation-test (lesson 5): revert the `unlink`→`rename` line → test 6 red; revert the row filter → test 1 red; revert the `skipped` consult in `manager.ts` → test 7 red; in `rename-recovery.ts` → test 8 red. Restore from a file copy, never `git checkout`.

## Done when

Tests 1-8 green; `npm run typecheck` + `npm test` green; the migrated assertion at `:124` carries a why-comment.

## Not in scope

Reading a `.future` or `.corrupt.*` file back (#1980). Any notification for the partial branch — the dropped-id `console.error` is the surface, and `store.test.ts:235`'s "No toast for future (expected during downgrade)" therefore stays as written. Doctor / `annotation-store-scan` changes of any kind: the `.future.<suffix>` archives this fix creates are **not** counted by `annotation-store-scan.ts:229`'s `endsWith(".json.future")` filter, and the `.corrupt.partial` copy **is** counted as quarantined — both stated rather than fixed, because neither is a defect #1791 reports. Bumping `SCHEMA_VERSION`, and any test or comment pinning post-bump behaviour.

## Review corrections (scope cut)

**Removed, not repaired**

- **`notifyLoadIssue` + the `pushNotification` assertion + migrating `store.test.ts:235`.** A new notification helper, its `type`/`severity`/tense reasoning and a reversed pinned assertion are a user-surface addition; #1791 asks that the annotations survive, not that a toast appears. Cutting it makes the round-1 finding about toast shape moot and leaves `store.test.ts:235` untouched.
- **`doctor.ts:2887`/`:2899` remediation rewording and the `annotation-store-scan.ts:229` filter widening (old test 12).** Doctor copy is not a defect #1791 reports. The two consequences are now stated in Not-in-scope instead.
- **The post-bump bound (old test 5).** The *placement* stays — it is one line and free — but a test or comment pinning behaviour after a version bump that has not happened is a drift guard.
- **The third park cycle (old test 8).** Two cycles is what discriminates; the random suffix stays because it is one expression.
- **Editing `future-park-probe.ts` and gating Done-when on probe stdout.** The finding was right that the probe's PRESERVED predicate contradicts the fix. Removing the probe from Done-when makes it moot: the probe is recorded as the pre-fix measurement it was, and test 6 is the gate.

**Fixed directly (kept from round 1)**

- The two destructive consumers (`session/manager.ts:1162`, `rename-recovery.ts:135`) bail on a non-zero `skipped` total — verified on this branch at `manager.ts:1173/1176-1177` and `rename-recovery.ts:178/191/205/252`. Tests 7 and 8.
- `schema.test.ts:118` is envelope-level (`annotations: "not an array"`, re-read at `:119`) and stays `corrupt`; only `:124` migrates.
- The preservation copy is `.corrupt.partial`, `COPYFILE_EXCL`, one per envelope.
