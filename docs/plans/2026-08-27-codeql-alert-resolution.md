# Resolving the open GitHub security alerts

**Status:** in progress. `ci.yml` permissions shipped — **PR #1649 merged 2026-08-27**. The five
`actions/missing-workflow-permissions` alerts should close on the next CodeQL run; confirm they
did rather than assuming, since a fix landing is not the same as an alert closing.
**Branch:** `security/codeql-alert-resolution`.

There are 26 open code-scanning alerts and 1 secret-scanning alert. Triage plus four
adversarial passes put them in three buckets, and the middle bucket is the one that
matters: **the first triage said 0 of 22 were real, and that was wrong.**

| Bucket | Alerts | Disposition |
|---|---|---|
| `actions/missing-workflow-permissions` | 5 | Fixed — PR #1649, merged 2026-08-27 |
| `js/path-injection` | 17 | **4 sit on genuine defects** (§1–§3). Fix those; dismiss the other 13 (§5) |
| `js/tainted-format-string` | 3 | Dismiss (§5) |
| `js/incomplete-multi-character-sanitization` | 1 | Dismiss (§5) |
| Secret scanning | 1 | Dismiss (§5) |

**The real defects are inside the path-injection bucket, not beside it.** An earlier draft of
this plan counted them in both columns and summed to 29 of 26. The three alerts whose sinks
§1–§3 touch are 18, 19, 20 (`docx-apply.ts:258`, `:260`, `:250`) and 94 (`convert.ts:119`) —
and §5 records why they do **not** become `false positive` just because the code around them
improves.

**And the most severe finding has no alert at all.** §2b — `tandem_restoreBackup` reading through
a symlink and reporting success — was found by the second adversarial review of this plan, on the
restore side, which CodeQL never modelled. It is the reason this document is worth more than its
dismissal list.

---

## What the adversarial passes changed

The first triage concluded every `js/path-injection` alert was a false positive on two
premises: that only the local user can reach the five `/api` handlers, and that each flagged
sink is downstream of a real validator.

**Premise 1 survived.** `app.use("/api", enforceLoopbackMutation)` at `src/server/mcp/server.ts:691`
is mounted ahead of every registrar (`registerApiRoutes` at `:740`), reads
`req.socket.remoteAddress` (`api-routes.ts:285`) and never a header, and none of the five routes
is in `NON_LOOPBACK_ALLOWED`. Verified directly, along with the two caveats §5 records.

**Premise 2 did not.** Four defects below are real. The first is not a security finding at all —
it is a data-safety bug that reports success — and the fourth (§2b) was found by reviewing this
plan rather than by CodeQL, on a surface no alert covers.

---

## §1 `docx-apply.ts:253` — `slice(0, -0)` discards the sanitized path

**Problem.** The anti-clobber branch computes `resolvedBackup.slice(0, -ext.length)`. When
`path.extname` returns `""` — an extensionless `backupPath`, a directory, a dotfile — that is
`slice(0, -0)`, and `-0 === 0` in JavaScript, so it evaluates to `slice(0, 0)`: the empty
string. Line 254 then builds `"-<timestamp>"`, a **relative** path, and `fs.copyFile` resolves
it against the server process's CWD.

Measured, not reasoned: `"/home/u/.ssh"` → `ext=""` → `base=""` → `"-1756300000000"`.

Reachable because `backupPath` gets no extension screen — only `rejectUnsafeWindowsPrefix` at
`:74-77`. The absolute path `path.resolve` produced at `:61` is thrown away, and the comment at
`docx-apply.ts:56-59` claims `path.resolve` "normalises backupPath to an absolute path, which is
also the CodeQL-recognised sanitizer". The sanitizer's output does not reach the sink.

**Cite the alerts honestly.** There is **no alert at `:253`**. Alerts 18/19/20 sit at `:258`,
`:260` and `:250`. The line this section fixes is the *reason* those sinks receive an
unsanitized value; it is not itself a flagged line. Say that, rather than implying CodeQL
pointed at it.

**Why it is worse than a path bug.** The size check at `:260-265` stats the file that *was*
written, so the sizes match and the apply reports success. The user's backup is silently in the
wrong place under a garbage name. That is #1448's contract — "tandem makes no unexpected
changes" — broken confidently.

**Fix.** Build the uniquified name without depending on `extname` being non-empty:

```js
const ext = path.extname(resolvedBackup);
const base = ext ? resolvedBackup.slice(0, -ext.length) : resolvedBackup;
```

**Nothing cleans up the strays.** `reaper.ts:38-40`'s `ATOMIC_TEMP_RE` is anchored on
`.tandem-tmp-…` and sweeps only the annotations and sessions dirs. Files already dropped in a
user's CWD by this bug stay there forever. The CHANGELOG entry must not imply cleanup.

## §2 `docx-apply.ts:258` — the write-through, and the fix that must not break restore

**Correcting this section's own earlier draft.** It claimed "default flags truncate an existing
destination". They do, but that path is unreachable here: `fs.access` succeeding at `:250` is
exactly what triggers the uniquify branch, so an existing *regular* destination is already never
overwritten. Two cases remain, and only these justify the change:

- a **dangling symlink** at the destination — `fs.access` follows it, gets ENOENT, takes the
  `catch` at `:255` ("No existing backup"), and `fs.copyFile` then writes *through* the link to
  wherever it points;
- a destination created between `:250` and `:258` — a genuine TOCTOU race.

**The composition defect the review caught.** `docx-apply.ts:417`, inside `tandem_restoreBackup`,
hard-codes `filePath.replace(/\.docx$/i, ".backup.docx")`. It never discovers a timestamped
sidecar. So a naive "uniquify on `EEXIST`" fix would move the backup to a name the tool
documented to find it (`docx-apply.ts:372`, `docs/mcp-tools.md:743`) cannot reach — trading a
write-through for a silently unrecoverable backup.

**Fix, shaped so the default name survives.**

1. Replace `fs.access` with `fs.lstat`, which does not follow symlinks, and **narrow the `catch`
   at `:255` to `ENOENT`**. Leaving it broad means an `EACCES` on the parent is still silently
   read as "no existing backup" — the same swallow class §1 is about.
2. A symlink at the destination is not a legitimate previous backup. **Refuse** with a coded
   error and a message that names both the path *and* the `backupPath` parameter
   (`docs/mcp-tools.md:706`), because refusing leaves a user whose destination is a symlink with
   no working `tandem_applyChanges` until they discover the override.
3. **Pin every other entry state, not just "symlink or regular file".** A directory, FIFO, socket
   or device node at the destination is neither. Branch on `isSymbolicLink()` → refuse, else
   uniquify — *not* on `isFile()` → uniquify, else fall through, which would send a directory to
   the default name and let `copyFile` throw a raw `EISDIR` that matches no case in `:344-358`
   and rethrows as an unhandled MCP protocol failure.
4. A regular file at the destination keeps today's uniquify behaviour — the *first* backup keeps
   the default name, which is the one restore reads. Load-bearing, not incidental.
5. `fs.copyFile(..., fs.constants.COPYFILE_EXCL)` closes the race. Available off `fs/promises` on
   the pinned engine (`package.json:80`, `>=22.12.0`); no import change.

**The retry must use the house pattern, not a bare timestamp.** An earlier draft said "recompute
from the original base" — which produces the **identical string** whenever the retry completes
inside the same millisecond, and a `copyFile` `EEXIST` returns immediately, so that is the normal
case. Five identical `EEXIST`s is not a retry. The repo solved this three times already and every
one uses randomness for exactly this reason: `integrations/backup.ts:79-83` (timestamp +
`randomUUID().slice(0,8)`, commented as defeating predictable-path attacks),
`file-io/doc-backup.ts:541-545` (`wx` + UUID suffix), `file-io/index.ts:339-341`
(`crypto.randomBytes(6)`, commented that concurrent writers "cannot collide on a shared
`Date.now()` millisecond"). Adopt it: timestamp + random suffix, recomputed fresh each attempt,
bounded at 5, terminating in `BACKUP_FAILED`.

**Pick the code by looking at both mappings, not one.** An earlier draft chose `INVALID_PATH` from
the `_shared.ts` tables alone — where it is correct (`400` / `INVALID_PATH`, `:135`, `:181`, with
a scrub message at `:273`). But `docx-apply.ts:348` maps `INVALID_PATH` to `mcpError("FORMAT_ERROR")`,
so an AI caller of `tandem_applyChanges` — the surface this tool is actually driven from — would be
told its backup destination is a *format* problem. `INVALID_PATH` is already overloaded there for
"cannot apply changes to uploaded files" (`:97`). Either add a distinct MCP branch or mint a new
code; do not justify the choice from the `/api` half alone.

The new throw fires before `snapshotBeforeFirstWrite` (`:274`) and `atomicWriteBuffer` (`:295`),
so the apply aborts with nothing written. No data-loss risk from the abort itself.

**The only way this is worse than today** is usability: a symlinked destination currently completes
the apply and afterwards refuses it. Given §2b, refusing is right — but item 2's error message is
what keeps it from being a dead end.

## §2b `docx-apply.ts:419-441` — restore reads through a symlink and calls it success

**Found by the second review of this plan, not by CodeQL, and it is the most severe item here.**
It is on the restore side, which nothing in the alert set points at.

`tandem_restoreBackup`'s `.docx` fallback derives `backupPath` from the document path (`:417`),
then:

- `:419` `fs.access(backupPath)` — **follows the symlink**, succeeds;
- `:432` `fs.copyFile(backupPath, filePath)` — reads **through** the link and overwrites the
  user's document with whatever it points at;
- `:434-438` compares `fs.stat(backupPath)` against `fs.stat(filePath)` — both through the link,
  so identical by construction, so verification **passes**;
- `:441` reports `Restored <name> from backup.`

A symlink planted at `{name}.backup.docx` is therefore a silent whole-document replacement from an
arbitrary attacker-chosen file, reported as a success. Same shape as §1 and strictly worse in
consequence: §1 misplaces a backup, this destroys the document. It fires only when the
doc-backups store has no snapshot for the file — i.e. on a fresh server run — and it needs a local
write next to the user's document, which is a real bound and belongs in the writeup.

**Fix.** The same `lstat`-and-refuse at `:419` that §2 applies at `:250`. If the argument for not
following symlinks holds at the write side, it holds harder here.

**Correcting a claim an earlier draft made about this fixture.** It called "a symlink to an
*existing* file" green either way. That is false in both directions. On the apply side it takes
the uniquify branch today and is *refused* after the fix, so it is red-today/green-after — it just
is not the fixture carrying the write-through defect. On the restore side it is the whole finding.
Do not repeat the claim; a reviewer who checks it reads it as evidence the fix does not do what
§2 step 2 says.

That also makes explicit an undisclosed behaviour change: a user who *deliberately* symlinks their
backup destination goes from working to refused. §2 item 2's error message is what keeps that from
being a dead end.

## §3 `convert.ts:119` — the re-check is skipped on exactly the path it guards

**Problem.** `fs.realpath(resolvedOutput)` exists, per the comment at `:116-117`, to "follow
symlinked export dirs and re-check the resolved location's prefix". For an output file that does
not exist yet — the normal case for an export — it throws ENOENT, `:133` swallows it, and
`resolvedOutput` stays uncanonicalized. The post-canonicalization `rejectUnsafeWindowsPrefix` at
`:120` never runs. Alert 94 is exactly this line.

**The same defect exists one file away, but the two files are not interchangeable.**
`src/server/mcp/annotations.ts:874-895` (`tandem_exportAnnotations`'s `outputPath`) has the same
`fs.realpath` → `rejectUnsafeWindowsPrefix(real)` → `fs.stat` shape with the `catch` swallowing
ENOENT. An earlier draft called them "byte-for-byte the same" and said fixing convert alone would
be "cosmetic". Both are wrong, in the direction that matters:

- **`convert.ts` is the HTTP-reachable half.** `outputPath` reaches it through
  `routes/convert.ts:6-19`. `tandem_exportAnnotations` has **no `/api` route** — which is why
  alert 94 is on `convert.ts` alone. Fixing convert and not annotations is incomplete; calling it
  cosmetic inverts which half carries the reachable surface.
- **They cannot share an implementation as written.** `convert.ts` *throws* `code: "INVALID_PATH"`
  from an exported core; `annotations.ts:865, 872, 876, 889` all `return mcpError(...)` from
  inside the tool callback.
- **Their non-ENOENT branches already differ.** `annotations.ts:889-894` returns a coded
  `INVALID_PATH` for any non-ENOENT error; `convert.ts:132-133` rethrows raw. So the coded
  parent-missing error below applies to `convert.ts` only — in `annotations.ts` it would sit
  beside an existing coded branch, and the two surfaces diverge unless that is deliberate.
- **The leaf-missing branch is the normal case only in convert.** `annotations.ts:848-851`
  documents that re-export deliberately overwrites on collision, so only the *first* export to a
  given `outputPath` takes it. `findAvailablePath` means convert takes it on essentially every
  call.

`annotations.ts` needs no `isAbsolute` addition — the zod refine at `:774` already enforces it.

**Narrows, does not close — say so.** The pre-resolve screen at `:112` did run, so the residual
is a Windows junction whose target is a UNC share. And canonicalizing at `:119` while writing at
`:147` (via `findAvailablePath` at `:141`, documented as best-effort TOCTOU at `:143-145`) leaves
a window in which the junction can be repointed. The dismissal text in §5 must not claim this is
closed.

**Fix, scoped correctly.** Not "the deepest existing ancestor" — `atomicWrite`
(`src/server/file-io/index.ts:349-353`) builds its temp via `tempSiblingPath` and does no `mkdir`,
so an export whose parent directory does not exist already fails today. Walking up more than one
level has no caller. Canonicalize `path.dirname(resolvedOutput)` when the leaf is missing, screen
that, and rejoin the basename. The rejoin reintroduces nothing: `resolvedOutput` is already
`path.resolve(outputPath)` (`:111`), so its basename is normalized and separator-free.

While here: the parent-missing case currently escapes as a raw ENOENT → `500` / `INTERNAL`. Give
it a coded `FILE_NOT_FOUND` (convert only — see above).

**Two things an earlier draft got wrong about the surrounding code.**

- It called the `stat.isDirectory()` join at `:127` a second unscreened hole. It is not reachable
  as one: `real` was screened one line earlier at `:120-123`, and `baseName` derives from
  `docState.filePath` — server state, not caller input, with uploads refused at `:66`. Screening
  it anyway is fine as defense-in-depth and will help CodeQL, but **no fixture can turn it red**,
  so it must not be written up as though one could.
- It said "screen at `:119`, write at `:147`" as if nothing intervened. `resolvedOutput` is
  **reassigned at `:141`** by `findAvailablePath`. Checked: `convert.ts:21-40` rebuilds candidates
  from the already-screened `dir`/`name`/`ext`, so it cannot reintroduce a prefix. Worth stating
  rather than leaving a reader to assume it.

Note also that `findAvailablePath` probes with `fs.access` (`:31`), which follows symlinks, so a
dangling symlink at the leaf reads as "available". That is safe here — `atomicWrite` renames
rather than writing through — but it means the leaf-missing branch this section fixes is also the
dangling-symlink branch.

**One branch this section does not touch, named so it is not mistaken for an oversight:** with
`outputPath` omitted (`:138-140`), the destination is derived from `docState.filePath` and is
never realpath'd. Not caller-controlled, so not a hole. Same for `annotations.ts`, where the whole
block is gated on `if (outputPath)` (`:873`).

## §4 Two things to fix that are not alerts

**`file-opener.ts:302`** builds an upload's synthetic registry path as
`` `${UPLOAD_PREFIX}${randomUUID()}/${fileName}` `` with `fileName` taken raw from `req.body`
(`routes/upload.ts:8-11`, string-typed only). `../` segments land verbatim in a registry
`filePath`. The adversary traced it to every sink and could not reach one — `isUploadPath`
diverts it at three call sites, `convertToMarkdown` refuses uploads, save-as/rename/apply-changes
gate on `source`, and uploads are `readOnly: true` — but stated plainly that this is a
**reachability accident, not a barrier**.

Three details the fix depends on:

- **Use `path.posix.basename`, not `path.basename`.** `path.basename` is `win32` on Windows and
  `posix` on Linux, and the `check` job is ubuntu-only. Measured:
  `path.posix.basename("..\\..\\evil.md")` returns the string unchanged, while
  `path.win32.basename` returns `"evil.md"`. The synthetic path is a `upload://` **URI** whose
  only structural separator is `/`, so `posix` is both correct and platform-stable.
- **Apply it to `fileName` once, at the top of the handler**, not only at `:302`. The same value
  feeds `displayName` / `writeDocMeta` (`:310`, `:322`) and the API response's `fileName`
  (`:331`); basenaming only the path leaves the one surface a user actually sees still carrying
  `../../`. This changes the response payload, so check the upload tests.
- Round-tripping is safe: `doc-hash.ts:96-107` splits on the first `/` after `upload://`, so
  traversal segments were already inert in the hash. `path.posix.basename("foo/")` is `"foo"`;
  `basename("/")` is `""`, and an empty `fileName` yields `upload://<uuid>/`, which `docHash`
  still handles.

**The false invariant is in three places, not one.** All three assert the registry path is "only
ever set by `openFileByPath` / `resolveAndValidatePath` / a validated rename or save-as", and all
three cite closed issue #1042 as authority for a dismissal:

- `src/server/mcp/file-opener.ts:1881`
- `src/server/mcp/document-service.ts:381`
- `src/server/mcp/document-service.ts:1119`

Correcting one and leaving two is the "correct every artifact carrying the claim" failure.

**And the correction is smaller than the earlier draft said.** That draft called save-as a
counter-example because it stores `path.resolve` output — but `saveDocumentAsToDisk`
(`document-service.ts:685-720`) runs `rejectUnsafeWindowsPrefix` raw *and* resolved, an
extension-match check, *and* `assertPathSafe`'s symlink-rejection walk. That is validated. The
**upload writer is the only genuine counter-example** — and once §4's `path.posix.basename`
lands, the invariant becomes true again. So: land the basename first, then decide whether the
comments need changing at all rather than rewriting them on a premise the fix removes. Note that
`file-opener.ts:1885` is live alert **158**, so touching that comment is touching an open alert's
justification.

## §5 Dismissals, and what their text must say

Dismiss only after §1–§4 land and CodeQL re-scans, so anything the fixes actually close is closed
by the fix rather than by a note claiming it was never a problem.

- **13 `js/path-injection`** → `false positive`, on the loopback premise. (17 open, minus the four
  below. An earlier draft said 14 — the arithmetic in this document has now been wrong twice, so
  check it against the live alert list rather than against this line.) The thirteen are 9, 12, 16,
  77, 85, 86, 90, 119, 120, 122, 158, 165, 174.
- **Alerts 18, 19, 20 and 94** → **`won't fix`, not `false positive`.** The plan establishes
  genuine defects at these sinks. The fixes do not remove the taint flow from `backupPath` /
  `outputPath` to the fs sink, and §6 records that `resolveAndValidatePath` applies **no root
  confinement** — so CodeQL will likely still flag them. Dismissing a line this plan just fixed
  as "never a problem" is the wrong record.
- **3 `js/tainted-format-string`** → `false positive`. State the reason correctly: `%` **does**
  survive `encodeURIComponent` — it is what `encodeURIComponent` emits. What cannot survive is a
  valid `util.format` *specifier*: the two characters after `%` are uppercase hex, and none of
  `s/d/i/f/j/o/c/O` is uppercase-hex-reachable. Verified with a discriminating control
  (`format("a %s b","ARG")` → `"a ARG b"`; `format("a %25s b","ARG")` → `"a %25s b ARG"`).
- **1 `js/incomplete-multi-character-sanitization`** → `used in tests`. It strips Yjs XML tags
  for an `indexOf` offset; no HTML sink, and no equivalent shape in `src/`.
- **1 secret-scanning** → `used_in_tests`. Svix's published fixture, proven: HMAC-SHA256 over the
  documented message with that key reproduces Svix's published signature byte-for-byte. Not
  Stripe — this repo has no Stripe integration.

**On precedent.** 28 alerts are already dismissed in this repo (23 `false positive`, 5
`won't fix`) — but all 28 are `js/path-injection`. There is no dismissal precedent for the
format-string or sanitization classes, so do not cite one.

**Two caveats the path-injection dismissal text must contain**, because "only the local user"
reads stronger than what the code enforces:

1. `LOCALHOST_ORIGIN_RE` is **port-wildcarded** (`^https?://(127\.0\.0\.1|<TAURI_HOSTNAME>)(:\d+)?$`,
   `api-routes.ts:112-114`). Any page served from any port on loopback is a fully allowlisted
   origin. An XSS in an unrelated local dev server is a path to these handlers.
2. The same sinks are reachable through `/mcp` under an opt-in `TANDEM_BIND_HOST=<lan>` with a
   token. `enforceLoopbackMutation` is mounted on `/api` only.

Also worth stating once: **CodeQL modelled only the `/api` sources.** The MCP tool surface —
`tandem_applyChanges.backupPath`, `tandem_convertToMarkdown.outputPath` — reaches the same sinks
and no alert covers it. "All dismissed" is not "this class is clean".

## §6 Tracked artifacts this work owes

The fixes are not the whole deliverable. Each of these has a convention that a code-only change
would silently skip.

**`docs/security.md` Open findings — and the tracker, both.** `docs/security.md:144-148` states
it is the tracked home for open findings and that a new one belongs there *as well as* in the
tracker; CLAUDE.md repeats it. §2, §2b and §3 are security findings and get entries in both, with
**§2b first** — it is the only one whose consequence is loss of the user's document. **§1 is
not** — by this plan's own framing it is a data-safety bug, so it belongs in the tracker under
the #1448 corruption programme, not the security register. Nothing here duplicates an existing
finding: `docs/security.md` mentions none of these files, and the issue search returns empty.

**CHANGELOG.** House style is Keep a Changelog with a dedicated `### Security` subsection, written
as user-facing prose with the limits stated out loud (`:30`, `:32` are the models). `[Unreleased]`
already has `### Fixed` and `### Security`, so no new headings.

- `### Fixed` — §1, the backup silently written to the wrong place while reporting success.
- `### Security` — §2b first (a restore that could silently replace the document with the contents
  of a planted symlink, and report success), then §2 and §3, each with its honest-limit sentence.
  §2b's is that it needs a local write next to the user's document and fires only when the
  doc-backups store has no snapshot. §3's is "a Windows junction whose target is a UNC share", and
  that §3 narrows rather than closes it.
- `### Internal` at most for §4.

**Close #1547** — "Make `check` a required status check on master — every CI gate is currently
advisory". It is still open, and the answer is now measured: branch protection on master has
`strict: true`, `enforce_admins: true`, contexts `["check", "rust-test (ubuntu-latest)",
"rust-test (macos-latest)", "rust-test (windows-latest)", "windows-acl-proof"]`. Post the
evidence on the issue and close it; then replace CLAUDE.md's hedge ("confirm it before treating
this as a merge gate") with the fact.

**Correct `docs/roadmap.md:413`.** It records PR c as shipping "bind mode selection
(`TANDEM_BIND_HOST`): default `127.0.0.1`, **Cowork mode binds `0.0.0.0`**". Nothing in the
product ever sets `TANDEM_BIND_HOST` — `integrations_probe.rs:314-326` deliberately omits it
("the launcher MUST NEVER set TANDEM_BIND_HOST=0.0.0.0 … #477 PR 4 out of scope"), and
`build_launch_env_never_sets_bind_host` (`:407`) is a `cargo test` gate on that, under a required
status check. LAN binding is user-set env only. This matters here because §5's dismissal premise
partly rests on it: a reader verifying against the roadmap would conclude Cowork binds
`0.0.0.0` by default and that §5's `/mcp` residual is the default posture rather than an opt-in
one.

**Correct one fact this plan previously stated.** `resolveAndValidatePath` rejects **four**
things, not three: UNC/extended-length prefixes, a non-allowlisted extension, >50 MB, and a
nonexistent file (`fs.stat` at `file-opener.ts:728` is unguarded and throws ENOENT). It also does
not reject a directory whose name ends in an allowlisted extension. The load-bearing half — **no
root confinement** — is correct and is what §5's `won't fix` disposition rests on.

## Verification

Each fix needs a test that a broken version would fail. An earlier draft's verification section
had **three of four tests that could not fail** — the repo's signature failure mode — so a
reviewer traced every fixture against the code on disk and ran probes. All five below are
confirmed red-today / green-after, four of them empirically. What follows is what that trace
found, including the mechanics that would have made a correct fixture fail for the wrong reason.

Existing coverage cannot substitute. `tests/server/docx-apply.test.ts` never creates a
pre-existing backup destination, so `:251-258` is unexercised, and — critically —
`tests/server/routes/response-path-scrub.test.ts` hoists `vi.mock` over both `docx-apply.js`
(`:36`) and `convert.js` (`:33`) at file scope. **A new spec added to that file would be insulated
identically and would be worthless.** All five land elsewhere; `tests/server/` is covered whole by
`tsconfig.tests.node.json`.

**§1 — extensionless existing `backupPath`.** Assert the returned `backupPath` is absolute. Proven
red: the probe returned `"-1787880898965"`, `isAbsolute` false, apply reporting success. Two
mechanics, both of which would otherwise fail the spec for the wrong reason:

- Use `REAL_APPLY_TIMEOUT_MS` (`docx-apply.test.ts:990`). This is a real apply — measured 21.6s —
  against a 15s default, so it would time out rather than assert.
- Put the stray-file cleanup in `finally` or `afterEach`, not after the assertion. On the red run
  the assertion throws first and the junk `-<timestamp>` file survives in the repo root.

**§2a — dangling symlink.** Today: `access` follows the link → ENOENT → default name →
`copyFile` opens with `O_WRONLY|O_CREAT|O_TRUNC`, following the link and **creating the target**;
`stat` follows it too, so the apply succeeds. Assert the target is untouched and the error is the
coded refusal. `runIf(!win32)` — unprivileged `symlink(2)` is fine on ubuntu, and this dev machine
has no symlink privilege, so ubuntu's `check` is the only leg that runs it and Windows gets none.
Say that rather than implying cross-platform cover. Needs the 60s timeout too.

**§2b — restore reads through the symlink.** Same POSIX gate. Plant a symlink at
`{name}.backup.docx` pointing at a file with different content, ensure the doc-backups store has
no snapshot, call `tandem_restoreBackup`, and assert the document is **not** replaced. Today it is
replaced and the call reports success.

**§2c — bounded retry on `EEXIST`.** The plan called this "a unit test that does not need
symlinks", which is true and misleading: today's code never passes `COPYFILE_EXCL`, so `EEXIST`
cannot arise from a real filesystem, and the collision name embeds `Date.now()` so it cannot be
pre-created. **It requires a spy.** `docx-apply.ts:7` imports the default `fs from "fs/promises"`,
whose `copyFile` is writable and configurable, and the default objects of `"fs/promises"` and
`"node:fs/promises"` are the same object — so `vi.spyOn(fs, "copyFile")` works (precedent:
`tests/server/annotations/store.test.ts:123`). Do **not** use `vi.mock("fs/promises")` here; it
would break the file's own `fsp` fixture setup.

And assert more than the terminal error: a `BACKUP_FAILED`-only assertion is satisfied whether or
not the retry compounds, which is the exact bug item 5 warns about. **Assert the spy's recorded
destinations** — five attempts, each a sibling of the *original* base, none a `-ts-ts` compound —
or the retry's stated contract is untested.

**§3 — symlinked parent, missing leaf.** Confirmed to reach `fs.realpath` in both files with
nothing rejecting it first: `convert.ts` passes `isAbsolute` (`:96`) and both prefix screens
(`:107`, `:112`) as POSIX no-ops before throwing ENOENT at `:119`; `annotations.ts` likewise
past the zod refine (`:771-780`) and `:858`/`:861` before `:875`. Both return the uncanonicalized
path verbatim today (`convert.ts:153`, `annotations.ts:910`). Non-symlink controls for both were
run and pass, so the fixtures are constructible — `convertToMarkdown` is directly importable, and
`tandem_exportAnnotations` drives through the in-memory MCP client (`edit-annotation.test.ts:22-30`).

- Build the expectation from `await fsp.realpath(realDir)`, **not** `os.tmpdir()`. macOS
  `/var/folders` is itself a symlink, which would make the before and after values coincide.
- Do not assert on a throw for the convert spec. `resolveAndValidatePath` (`file-opener.ts:702-712`)
  realpaths and does not reject symlinks, so the convert succeeds today and returns a `documentId`
  hashed from the canonical path while `outputPath` is uncanonical. That mismatch is a good second
  assertion.

**§4 — `fileName` with forward slashes.** Proven red: the probe produced
`upload://<uuid>/../../evil.md`. Pin the fixture to `/` — `path.posix.basename("..\..\evil.md")`
returns the string unchanged, so a backslash fixture stays red *after* the fix. Assert **both**
`filePath` and the returned `fileName`: a `filePath`-only assertion passes a fix applied at `:302`
alone, which is the placement §4 argues against.

**Then:** full `npm test`, `npm run typecheck`, `npm run typecheck:tests`, and CI green before
dismissing anything.
