# Spike plan: SuperDoc as Tandem's `.docx` engine (ADR-052)

**Status:** Approved to run (2026-09-23). Nothing has run yet.
**Decision it serves:** [ADR-052](../decisions.md#adr-052-superdoc-replaces-the-docx-readwrite-pipeline-server-side-behind-the-existing-editor)
**Prior art to reuse:**
- the [GenOffice spike](genoffice-docx-engine-spike.md), for its fixtures and its `w:ind` /
  `w:shd` / `w:rFonts` measurements;
- the Phase 0d fidelity harness (`tests/helpers/docx-fidelity-harness.ts` +
  `tests/helpers/docx-corpus.ts`);
- the E2E fixtures `tests/e2e/fixtures/{reviewer-comments,single-paragraph}.docx`.

**What the spike must answer:** can SuperDoc's engine, running headless inside Tandem's sidecar
with no network, replace the current pipeline without moving any annotation? And does the save
really splice rather than regenerate?

## What is already decided

Bryan, 2026-09-23:
- **Licence scope.** Proceed on the basis that Tandem may use SuperDoc with telemetry off and no
  data leaving the user's machine. The written terms are still owed before any implementation PR
  merges (ADR-052's licence checklist); this decision covers the spike.
- **Who runs it.** Claude runs every step, engine included.
- **Where results go** was not decided, so the default holds: everything stays in
  `private/superdoc-spike/` (gitignored). The tracked report records only GO / NO-GO / NOT RUN
  per question. Nothing about results goes into auto-memory.

## Rules for every question

1. **S1 and S2 are kill gates.** If either fails, stop and go back to Bryan.
2. **Every pass needs a positive case.** A criterion met because nothing exercised the feature is
   recorded as NOT RUN, not PASS. Where a check could pass by seeing nothing (a network capture,
   a verify step), the plan names a control that must be seen first.
3. **No probing the engine.** Only documented APIs, documented configuration, and the XML inside
   the files it reads and writes (compared from outside) are used. Tracing, string-scanning or
   otherwise investigating the engine's code or undocumented behaviour is forbidden by its
   licence (§3.1(a), §7.2).
4. **The engine only ever runs inside a container.** It is never installed or run directly on
   Bryan's machine.

## Isolation: Docker containers

Docker Desktop (Linux containers) on Bryan's Windows machine. Each run is a throwaway container:
- **fixed paths:** the spike worktree is mounted read-only at `/src`; the Linux install lives in
  the image at `/app` (its own `node_modules`, never the host's Windows-built one); one output
  directory under the session scratchpad is mounted at `/out`, the only writable mount;
- nothing else from the host is mounted, and no host environment variable is passed in, so the
  container holds no credentials;
- `--network none`, except in Tier 3's lab, where the only network is an internal one with a
  sink on it;
- **one container per fixture** wherever memory is measured, because the cgroup's `memory.peak`
  covers the container's whole life and cannot be reset on this kernel.

**Images** (Dockerfile and scripts under `scripts/spikes/superdoc/`):
- `tandem-spike:acquired`, from `node:24-bookworm` plus `iproute2`, `procps` and `tcpdump`. It
  copies the spike worktree's source to `/app`, runs `npm ci --ignore-scripts`, builds `dist/`,
  and keeps the npm cache so later offline installs work. `docker build` is the one networked
  step, and it runs no package code. The build also records every package with
  `hasInstallScript`, and `npm pack`s the engine to hash its licence (step 3).
- `tandem-spike:ready` is `acquired` after `npm rebuild` has run those install scripts in a
  `--network none` container, committed with `docker commit --change 'CMD ["sleep","infinity"]'`.
  Tier 3 re-runs the rebuild inside its lab to see whether the scripts try the network.

**What this does not cover, recorded as NOT RUN:** the Windows build of host B's native binary,
Windows-only network routes (SMB and WebDAV leaving as system services), and `cargo tauri build`.
Those move to the implementation's Windows smoke test.

## Setup — engine-free work, done first

1. **The harness seams land on master as their own PR.** It touches one `src/` module,
   `docx-capture.ts`, without changing its production behaviour. Today `docx-fidelity-harness.ts`
   hard-codes `getAdapter("docx")`, and its round trip saves with no edit. A splice of zero edits
   returns the input bytes, so the stability gate would pass by construction. The change:
   - adds a harness-local type:
     `type HarnessAdapter = Omit<FormatAdapter, "saveBinary"> & { saveBinary?(doc: Y.Doc, original: Buffer): Promise<Buffer> }`.
     `getAdapter("docx")` still assigns to it, and `FormatAdapter` is not touched;
   - changes the signature to
     `runRoundTrip(bytes, opts?: { adapter?: HarnessAdapter; edit?: (doc: Y.Doc) => void })`.
     Both `importGeneration` calls use `opts.adapter`. The edit is applied under
     `transactForTest` after import, and `gen1` is captured **after** it;
   - keeps the one existing caller, `docx-roundtrip-fidelity.test.ts`, green unchanged;
   - adds two fields to `AnnotationSnapshot` in `docx-capture.ts` for imported comments: the
     Word author (`importSource.author`) and the comment's body text. Tier 2 matches comments on
     these, because the anchor is what it tests and the id is re-minted. The date is left out:
     `w:date` is stored as the record's `timestamp`, but a comment without one gets `Date.now()`
     (`docx-comments.ts`), so it would differ between generations;
   - adds a test helper that overrides `getAdapter("docx")` with a `vi.mock` of `file-io/index`,
     so a test can drive another adapter through cold open, restart, `force: true`, watcher
     reload and session restore. The PR has a test per path proving the override reaches it. A
     path it cannot reach is NOT RUN wherever the plan needs it.

   **Save is out of the override's reach, deliberately.** Today's save calls
   `adapter.saveBinary!(doc)` with no original bytes and then `verifyDocxRoundtrips`, which
   re-imports through `getAdapter("docx")` (`mcp/document-service.ts`, `docx-verify.ts`). Under a
   `vi.mock` that verify would be the engine checking itself, and no save-time hash check exists
   yet. So every spike save goes through the spike's own **save driver**: one synchronous snapshot
   (ADR-052 Decision 3), the splice, then S10's verify. The real save path is an acceptance
   criterion of implementation step 2 (see Output).
2. **The spike worktree.**
   - Its own worktree (`../tandem-superdoc-spike`, branch `spike/superdoc-engine`) off step 1's
     branch, so the spike does not wait for that PR to merge. On the host, `npm ci --ignore-scripts` from master's lockfile, then
     `npx husky`, and assert `.husky/_/pre-commit` exists before the first commit.
   - The engine goes into that branch's `package.json`. Its lockfile is produced on the host with
     `npm install --package-lock-only --ignore-scripts`, which writes metadata only and unpacks
     nothing.
   - Spike code lives under `scripts/spikes/superdoc/` and is not wired into `src/`.
   - **The branch is never pushed and never opened as a PR.** `ci.yml` and
     `claude-code-review.yml` run on PRs in a public repo, and CI's `npm ci` would install the
     engine.
3. **Pin versions.** `superdoc@2.17.0`, `@superdoc/docx-engine@0.16.0` and
   `@superdoc-dev/sdk@1.21.3`, exact. The `acquired` build hashes the packed
   `DOCX-ENGINE-LICENSE.md`; it must equal
   `cb750acaec9e1fa7b106d326d0a7db0f3811c022048b09affc73842258419172`, or stop.
4. **Legacy baseline**, in the `ready` image so both pipelines run on the same machine. For every
   corpus and GenOffice fixture except the hostile ones (the 400 KB OOM file belongs to S8 only),
   spawn one fresh container per fixture running import → the fixed
   edit → `saveBinary` through the legacy adapter. **The fixed edit** inserts the string `SPIKE`
   into the first non-heading textblock of length ≥ 2, in document order. It goes at
   start + floor(length / 2), moved one step forward if that position splits a surrogate pair,
   and must pass `validateRange`, which rejects and never clamps. A fixture with no such
   textblock is NOT RUN for every measurement that needs the edit.
   - Record wall time for the cold (first) run and a warm (second, same process) run.
   - Record peak memory as the container cgroup's `memory.peak`, which covers every process in
     it, and `process.resourceUsage().maxRSS` for the Node process alone.
   - "Largest fixture" means largest by byte size.
5. **The independent reader's reading table** (ADR-052 Decision 1) is written down: for each
   OOXML element, what the reader emits. Written before Tier 2 uses it.
6. **Fixtures.** Build what the corpus lacks: the #1951 comment id classes (S6), the S8 hostile
   files, a paragraph holding hidden text, a field, an unmapped mark and a blanked link (S5), and
   one fixture each for headers, footers, footnotes, endnotes, images, section breaks and styles
   (S9).
7. **Calibrate Tier 3's lab**, before any engine code exists (see Tier 3).

## Tier 1 — S1: can it run headless inside the sidecar? (kill gate)

**Two possible hosts:**
- **A:** the `superdoc` package in Node, which brings in `jsdom` and `y-websocket`.
- **B:** `@superdoc-dev/sdk`, which drives a native binary.

**Where.** A `--network none` container from `ready`, with documented telemetry off.

**Method.** Run exactly the setup step 4 procedure for each host, then check:

- **Round-trips.** A run completes, and its output re-imports through the same host without
  throwing.
- **No browser.** No DOM shim beyond what the host ships.
- **Engine work stays in `parse`** (ADR-052 Decision 5). `adapter.apply` runs inside synchronous
  transactions, so:
  - `apply` lives in its own module. A check walks that module's import graph and asserts it
    reaches no engine module. **Positive controls:** two fixture `apply` modules must each fail
    the walk, one reaching the engine two static imports away and one through a dynamic
    `import()`;
  - `parse` awaits the engine's **documented** idle or dispose before it resolves. If none is
    documented, this check fails; it is not improvised;
  - `process.getActiveResourcesInfo()` after `parse` equals its value before the call. For host
    B, the SDK's documented engine child is the one allowed difference, listed by name. This view
    omits unref'd handles, so it is evidence, not proof;
  - `parse` returns `structuredClone(result)`, and `apply` is only ever handed that clone. The
    check asserts with `toStrictEqual` (plain `toEqual` treats a class instance and its clone as
    equal) that the returned value equals the pre-clone result, and that the result contains no
    `SharedArrayBuffer`, which a clone shares rather than copies;
  - **positive controls:** a fake `parse` whose result holds a class instance must fail the
    clone check, and one that leaves a timer running must fail the resource check.

  A `Proxy.revocable` wrapper would not do this job: a probe showed that closures the engine
  captured before revocation keep working.
- **stdout.** The spike script installs the same console redirect as `src/server/index.ts` and
  runs as `sh -c 'node script > /out/out.bin 2> /out/err.txt'`. This catches raw writes to file
  descriptor 1, which a `process.stdout.write` wrapper would miss.
  - **Positive control:** the same command, run on a control script that writes one byte to fd 1,
    must produce a 1-byte file.
  - The real script prints a completion marker to stderr, and `err.txt` must end with it, so a
    crash cannot pass as silence.
  - The SDK, not the spike, decides how its child's stdio is wired. Record it; if the child
    inherits stdout, that host fails this check.
- **No listening socket.** Throughout the run, poll `ss -ltnupx` (TCP, UDP and Unix sockets)
  inside the container, which holds only the run's processes, and diff against a snapshot taken
  before it. The SDK's documented stdio channel is the one exemption, listed by name.
  **Positive control:** a child that listens on a TCP port for one second and then exits must be
  caught by the poll.
- **Paths.** If host B takes only a path, record where its temp copy is created, its permissions,
  and that it is deleted.
- **Size and packaging.** Record the size delta of `npm i -g --offline --prefix <scratch dir>`
  from a tarball made by `npm pack --ignore-scripts` of the built spike branch, inside the
  container, using the image's npm cache. Record the published unpacked size of each
  platform's host B binary from the registry metadata. Check whether tsup bundles the host or
  needs it external. If it bundles, confirm the engine's proprietary notices survive byte for
  byte (§3.1(c)).

**Pass.**
- One host round-trips every fixture.
- Peak memory stays within 2× the legacy baseline on the largest fixture, and under 1 GB.
- The `apply` module's import graph is engine-free; every `parse` result equals its clone and
  holds no `SharedArrayBuffer`; idle/dispose is documented and active resources return to
  baseline. All four positive controls fail as they should.
- The stdout control produces 1 byte, and the real run 0 bytes plus its completion marker.
- No new listening socket appears, and the control listener is caught.
- Notices survive bundling, if the host bundles.

## Tier 2 — fitness: S3 to S7, S9, S10

Each runs in a `--network none` container from `ready`, and only after Tier 1 passes.

### S3 — Does import produce a usable, private Y.Doc?

**Method.** Implement a spike adapter over the engine and pass it to the harness (setup step 1),
with an edit that shifts annotated spans.

**Pass.**
- **Stability.** Run `refreshAllRanges` before each capture. `gen2` then deep-equals `gen1`, with
  imported comments grouped by Word author and body text (setup step 1's capture fields), never
  matched by id or sort order. The shifting edit re-mints ids through `importAnnotationId`, so
  an id match would rest on an S6 fact. Same-author, same-body comments are common ("typo",
  "?", or the `"Unknown"` default author), so **within each group the multiset of anchor texts
  must be equal** between `gen1` and `gen2`. Any difference, in a group or in the set of
  groups, is a FAIL; there is no tie case. A zero-edit round trip proves nothing here.
- **Duplicates, measured through the real open path.** The harness skips `loadAndMerge`, so it
  cannot see a ghost. So also open each fixture through `openFromDisk`, via setup step 1's
  override: cold, again after a restart, and with `force: true`. A duplicate is a record beyond
  the file's own count in an (author, body, anchor text) multiset, as above; `commentId` is
  recorded alongside but not relied on, since its stability is an S6 fact. A fixture counts as
  **free of #1754 classes** when the legacy and spike imports give equal `extractText()`.
  - On other fixtures, duplicates are a **measurement** for the comment-identity spec: the spike
    adapter carries no identity design, so they are expected.
  - **On #1754-free fixtures they are a pass criterion:** any duplicate is a FAIL. If no
    #1754-free fixture holds a comment, this criterion is NOT RUN.
- **Parity.** Every capability the legacy adapter passes still passes. This is necessary but not
  sufficient; S9 covers what the corpus lacks.
- **Links.** Hrefs are compared directly, because the harness tree records mark keys only.
- **No unregistered marks.** No mark or node the client schema does not register reaches the
  Y.Doc (#1152: one deletes the whole paragraph). Test a fixture with an unmapped mark and assert
  the paragraph survives a real Collaboration sync, as in
  `tests/client/editor-schema-marks.test.ts`.
- **Sanitizers.** `search-ms:`, `ms-msdt:`, `file:` and UNC targets, in links and in images, are
  all neutralised by the href allowlist and `sanitizeImageSrc`.
- **Privacy shape.** Every imported Word comment is:
  - `type: "note"`, `audience: "private"`, `author: "import"`;
  - carrying a populated `importSource.author`;
  - with replies that carry `importAuthor`.

  No channel event fires, and none appears in `tandem_getAnnotations` or `tandem_checkInbox`
  (ADR-052).
- **Anchoring.** For each imported comment, `extractText(doc).slice(range.from, range.to)` equals
  the text of its commented range as the engine reads it, and the record has a `relRange`. The
  harness's `anchorText` and `fullyAnchored` capture fields are these two facts. This is what makes "one
  parser" (Decision 4) checkable, and it catches offsets computed in `parse` that no longer
  match the doc `apply` built.
- **Newly visible content.** Record what now reaches the Y.Doc that mammoth dropped, such as
  hidden `w:vanish` text and field-code text. Each one is mapped deliberately or dropped
  deliberately, because anything in the Y.Doc reaches Claude.

### S4 — Do offsets land on the right characters?

The bridge maps a flat `extractText()` offset to an engine address. **It must agree with
`resolveToElement` (`src/shared/positions/ydoc.ts`) for every offset, in both roles.** That
function sends an offset on a block-separator `\n` to the *end* of block *i*, for `from` and for
`to`. A bridge that disagrees would put an exported comment one block away from its CRDT anchor.

**Method.**
- **Sentinel.** For every fixture and every offset *k*, insert a sentinel through the engine at
  the mapped address, save, and re-import. The sentinel must appear at *k* in `extractText()`.
- **Outside witness.** Read both files with the independent reader (ADR-052 Decision 1) and
  diff them.
  - The only hunk must be the sentinel.
  - Its body `w:p` ordinal must equal the document-order ordinal of the textblock that
    `resolveToTextblock` returns for *k* (ADR-052 Decision 1). This runs only where, before the
    insert, the reader's paragraph count equals the textblock count and the text leading up to
    the paragraph agrees **after the reading table's normalisations** (heading prefixes removed
    from `extractText()`'s side, and each class the reader skips removed from both). Elsewhere
    the ordinal check is NOT RUN for that offset. **But a disagreement in leading text or
    paragraph count that no row of the reading table explains is a FAIL, not NOT RUN**: it is
    the engine consistently skipping something, which is what this witness exists to catch. If
    the check did not run on at least one offset in every coverage class below, S4 as a whole
    is NOT RUN, not PASS. Record the NOT RUN rate per fixture. The normalisation is not fully
    independent of the engine: knowing which `extractText()` characters came from a class the
    reader skips relies on the engine's import.
  - Inside paragraphs made only of plain runs, the reader's *n* characters on each side of it
    must equal `extractText()`'s characters around *k*.

  This catches an engine that consistently skips something (hidden text, say) and lands every
  sentinel in a self-consistent but wrong place. The reader is never compared with
  `extractText()` beyond this: it has no heading prefixes, and it skips deletions, moves and
  field instructions by design. Its per-element reading table is written down before S4 starts.
- **Refusal.** The bridge refuses exactly where `validateRange` refuses: inside a heading prefix,
  at a `to` equal to a prefix's first character, and at an offset in the middle of a surrogate
  pair.
- **Coverage:**
  - the #1754 classes (tabs, breaks, symbols, empty paragraphs, page breaks);
  - hardBreaks and footnote refs;
  - table cells and list items (nested blocks are also `\n`-separated);
  - surrogate pairs at both edges of a range.

**Pass.** Every sentinel lands and passes the witness, and every refusal matches. "Mostly" is a
fail.

### S5 — Is the save a correct splice?

**The diff** (ADR-052 Decision 3).
- **Input.** One synchronous snapshot per save: the comment set, the body serialization and the
  dirty-version marker together. It is compared against a fresh engine reading of the on-disk
  bytes, taken after the import's own mapping and sanitizing, once the file hash is confirmed.
- **Block identity.** Record whether blocks are matched by `w14:paraId`, by an engine id or by a
  flat-text diff. If an id is kept as a Tiptap node attribute, check first that ProseMirror
  copies attributes on a paragraph split, and that the client schema drops attributes it does
  not register.

**Fixed edits,** on the GenOffice fixtures plus the corpus:
- insert mid-paragraph;
- delete across a run boundary;
- replace a paragraph;
- add a paragraph, and delete one;
- change a heading level;
- edit a list item;
- edit a table cell;
- edit a paragraph that also holds hidden text, a field, a mark import dropped, and a link import
  blanked. Count the `w:vanish` runs, field instructions and hyperlink relationships in that
  paragraph before and after.

**Random sequences** (property-based):
- mixing split, merge, undo, concurrent MCP and browser edits, and a reload between import and
  save;
- including edits that move annotated spans.

The oracle has three parts:
- the re-import's `extractText()` equals the snapshot's;
- the block trees match;
- after the real reopen path (`reanchorAnnotations`), every annotation that is not an imported
  Word comment has an `anchorText` equal to its text in the snapshot, and none comes back
  `degraded`. Imported comments are judged by S3's per-group multiset of anchor texts against
  the snapshot. Records beyond the snapshot's count for an exact (author, body, anchor text)
  triple are duplicates: they are set aside and recorded for S6. After that, any difference in
  a group's multiset is a FAIL. A lost comment cannot hide behind a duplicate of its
  neighbour, because the lost one's anchor text is then missing from the multiset.

`storedRangeStillMatches` is **not** the oracle. It returns true when there is no
`textSnapshot`, and imported comments have none.

Concurrency during a save, and saves after reloads and session restores, need the real save path,
so they are acceptance criteria of implementation step 2 (Output), not spike questions.

**Pass.**
- Every fixed edit can be expressed, and every random sequence meets the oracle.
- Every untouched zip entry is byte-identical. List the `docProps` / `dcterms:modified`
  exceptions, which the GenOffice spike found churn by design.
- The `w:ind`, `w:shd` and `w:rFonts` counts do not drop, including inside edited paragraphs,
  and the four preserved-content counts are unchanged.
- An inexpressible splice refuses rather than regenerates.
- **Human step:** Bryan opens every output in Word on Windows. An "unreadable content" prompt
  fails the file. macOS and Linux Word are NOT RUN.

### S6 — Comments: measure what the identity design needs

The comment-identity mechanism is not designed here. ADR-052 Decision 4 sets its invariants and
defers the design to a spec written from these measurements. S6 gathers the facts that spec
needs, and gives it a baseline to be judged against.

**Where things stand today.**
- Replies are imported (#1000) but exported flattened into the parent's body.
- Resolved state is not imported.
- The export rule: user-authored notes, highlights, `{comment, private}` and non-pending
  comments are never exported. Imports round-trip through `isImportRoundtrip`, which requires
  `importSource.author`.

**Measure — engine facts.** Two sources only: the documented API, and the XML inside the files
the engine reads and writes, compared from outside (rule 3). Nothing is learned from the
engine's code or undocumented behaviour. A fact neither source shows is recorded NOT RUN rather
than inferred.
- For each id class, does the engine report a comment's `w:id` exactly as it appears in the
  file, and write it back unchanged? The classes: ordinary, negative, non-numeric (`c-9182`),
  non-canonical, int32 + 1, at-cap (32 characters or more), and a comment with no `w14:paraId`.
- Does the engine expose `w16cid:durableId` (from `commentsIds.xml`) and `w14:paraId`, and does
  it keep them across a splice?
- Does it read reply threads (`commentsExtended.xml`) and resolved state (`w15:done`)? Can it
  write both?
- Does a splice that removes a `w:comment` also remove its range markers, its reference run, and
  its `commentsExtended` / `commentsIds` entries?

**Measure — Word facts.** Human step, Bryan on Windows:
- Open a commented fixture in Word and save it. Compare every `w:id`, `w14:paraId` and
  `w16cid:durableId` before and after.
- Delete one comment in Word, add a new one, and save. Is the deleted comment's `w:id` reused?

**Baseline the invariants on today's pipeline.** Run each of ADR-052 Decision 4's invariants
against the **legacy** adapter, on every open path the ADR lists except the engine flip, through
setup step 1's override. Record which already hold and which already fail: #1954 is a known failure of invariant
1 on a cold open. The spec must not regress any that hold today.

**Map the naive spike adapter against the same invariants.** It carries no identity design, so
it will fail some. Record which, and on which open paths and id classes. That list is the spec's
input, and none of it is a spike failure.

**Pass** (the spike's own criteria, which are independent of the identity design):
- **Import parity** with `injectCommentsAsAnnotations` on `reviewer-comments.docx`: authors,
  dates, replies, and resolved state in its own field (never `status`). Ranges match too, except
  those that move in a #1754 class. Each moved range is checked against S3's anchoring criterion,
  never on its own.
- **Export, on a first save only.** Replies can be written as real threaded replies, and resolved
  state from its field. The export rule holds exactly. What later saves do to comments already
  written is identity behaviour, so it belongs to the map above, not here.
- **Privacy.** S3's privacy-shape criterion holds on every open path.
- **Measurements.** Every engine fact and Word fact above is recorded, with the raw file excerpt
  kept locally. Any fact that could not be measured is NOT RUN, and the spec cannot rest on it.

### S7 — Tracked changes

**Pass.**
- **`tandem_applyChanges` parity.** Each accepted suggestion becomes a real `w:ins` / `w:del` with
  author and date at the suggestion's range. It is gated by `snapshotContradicts` and the
  exact-text precondition. `src/server/mcp/docx-apply.ts` still contains no `rearmWatch`.
- **`resolveWordComments`.** The right Word comment is marked done, including for truncated ids.
  On the watcher reload, `w15:done` maps into the resolved field, not `status`, with no event
  emitted.
- **The reload after apply.** Let the watcher re-import, then assert every annotation's anchor
  and `degraded` state. How the engine renders the markup it just wrote changes the flat text.
- **Revisions already in the file.** Record which kinds the engine shows, which it accepts
  silently (paragraph level? table level? moves?), and whether it *reports* them. Whatever it
  accepts silently stays covered by `docx-lost-features.ts`.

### S9 — What the Y.Doc does not model

**Pass.** Headers, footers, footnotes, endnotes, images, section breaks and styles survive an
edit-and-save untouched, each from a fixture that actually contains it. Footnote refs still land
on the right text.

### S10 — The safety net

**Pass.**
- For a splice save, `docx-verify.ts` enforces the ADR-052 rule. The re-import's `extractText()`
  equals the save's snapshot, and the block tree matches.
- The independent reader's hunk-string sequence equals the one the same diff algorithm produces
  over `extractText()` before and after (ADR-052 Decision 1).
- **Positive controls:** inject a dropped span, a duplicated span and a shifted span into a save.
  Both checks must block each one.
- A splice save over `MAX_VERIFY_BYTES` (25 MB) still gets the exact-text check, or refuses.
- The lost-features scan runs during verify (it is `scanLostFeatures: false` today).
- `doc-backup.ts` and the `tandem_applyChanges` backup sidecar behave as today.
- Record the time cost of the double import on the largest fixture.

## Tier 3 — S2 and S8: does anything leave the machine? (S2 is a kill gate)

Tier 3 can run as soon as Tier 1 passes; it does not wait for Tier 2.

### The lab

Every mechanism here was tried in Docker Desktop during review, without any engine code, and
the lab scripts live in `scripts/spikes/superdoc/lab/`.

- **Network.** `docker network create --internal --ipv6=false --subnet 192.0.2.0/24
  --gateway 192.0.2.254 spike-net`. Docker takes the gateway address for itself, so it is moved
  off `192.0.2.1`.
- **The sink**, a container at `192.0.2.1` on `spike-net`, with `NET_ADMIN`. It runs `dnsmasq`
  answering every name with `192.0.2.1` and logging every query, accepts TCP on every port (an
  `iptables` REDIRECT to one logging listener), and runs `tcpdump` writing every packet it
  receives.
- **The subject**, the spike container from `ready`, on `spike-net` with `--dns 192.0.2.1` and
  `--sysctl net.ipv6.conf.all.disable_ipv6=1`, so it emits no IPv6 neighbour-discovery traffic.
  Its main process is `sleep infinity`, and every job runs in it with `docker exec`. That keeps
  its network namespace alive through the five-minute tail; if a job were the main process, its
  exit would tear the namespace down and kill any detached child, and the tail would see nothing.
- **A helper** shares the subject's network namespace (`--network container:<subject>`, with
  `NET_ADMIN`; the subject itself gets no extra capability). An internal network drops packets
  for addresses outside its subnet, so a default route alone delivers nothing. The helper
  therefore DNATs every outbound packet on `eth0` to the sink
  (`iptables -t nat -A OUTPUT -o eth0 ! -d 192.0.2.1 -j DNAT --to-destination 192.0.2.1`; the
  `-o eth0` keeps loopback out of it). It also runs `tcpdump -i any`, recording every packet the
  subject sends, and `conntrack -E`, which records the **original** destination of each flow:
  after the DNAT, both captures show only `192.0.2.1`.
- **In-process view:** a `diagnostics_channel` subscriber on `net.client.socket`, loaded through
  `NODE_OPTIONS=--require=<absolute path>`. `--require` reaches `eval` workers too, which
  `--import` does not. It covers `net` and global `fetch`, not DNS, UDP, host B's binary or a Node
  child spawned with its own environment. Each preload prints a hello line with its PID.
- **Process view:** a `ps` poll inside the subject every 250 ms for the whole window, so every
  process that ran is listed, and every Node process must have printed a hello line.

**Four witnesses must agree:** the subject-side capture (every attempt), the conntrack log (where
each attempt was going), the sink's capture and DNS log (what arrived), and the in-process view.
There are no operating-system services inside the container, and IPv6 is off, so the
**expected-events list** is limited to ARP and the Docker resolver's forwarding of the subject's
own DNS queries: any IP packet from the subject that is not a control, and not the forward of a
query the subject made, counts against the run.

### Calibration (setup step 7, before any engine code)

A **decoy** script runs in the lab and does, in turn: a TCP connect to a literal IP outside the
subnet (`203.0.113.5`), a `fetch` to a real domain name, a UDP send, a `dns.lookup` of a name, a
literal-IPv6 connect (which must fail locally), a native non-Node process that connects (`curl`),
a Node child spawned with `NODE_OPTIONS` scrubbed, a detached child that connects after its
parent exits, and a connect delayed by four minutes.

| Action | Subject capture | Sink | In-process |
|---|---|---|---|
| TCP to a literal IP | packet | connection | socket seen |
| `fetch` to a name | DNS + packet | DNS query + connection | socket seen |
| UDP send | packet | packet | not covered |
| `dns.lookup` of a name | DNS packet | DNS query | not covered |
| Literal IPv6 connect | nothing | nothing | error only |
| Native process connects | packet | connection | not covered |
| Node child, `NODE_OPTIONS` scrubbed | packet | connection | **no hello line**, which the process view must flag |
| Detached child, after parent exits | packet | connection, inside the tail | — |
| Delayed connect | packet | connection, inside the tail | — |

Every row must be seen as the table says. A **quiet** script that imports nothing and exits must
produce no packet at all over a 30-minute window. Until both hold, the lab is fixed and
calibration re-run, and no engine code runs in it.

### S2 runs

**Positive controls inside every window:** a Node `fetch` to a name, a `dns.lookup` of a name, and
a TCP connect to a literal IP. In runs 2 to 6, each must appear in every witness its row requires,
or the run is void. Run 1 has its own rule below.

**Runs, in this order:**
1. `--network none`. The controls must fail locally, and the subject capture must be empty. This
   shows the engine works with no network at all.
2. `npm rebuild` in the lab, to see whether install scripts reach for the network.
3. Telemetry off.
4. Telemetry at its default, to learn what the pin test must prevent.
5. A production-shaped licence key and configuration, if SuperDoc has issued a key.
6. With each **documented** environment variable that affects telemetry.

Runs 3 to 6 each cover the Tier 1 round-trip, the S8 hostile files, and a document using a font
that is not installed. Capture continues for five minutes after the run exits. Captures and logs
go to the output directory, then to `private/superdoc-spike/`.

**Pass.**
- Runs 2 and 3: no packet from the subject beyond the controls, and no `diagnostics_channel`
  socket beyond the controls.
- Run 1's outputs are byte-identical to run 3's, apart from `docProps/core.xml` and
  `docProps/app.xml`, which carry save timestamps.
- The report says whether a licence key is needed and whether it is checked offline.

Any unexplained packet is a stop. State what this cannot rule out: Windows-only routes (see
Isolation), checks triggered by time or run count, and code paths the corpus never reaches.

### S8 — Hostile input

In the lab, with every external and UNC target in the files pointed at `192.0.2.1`. Run each case
with Tandem's size gate in front of the engine, then with it bypassed:
- a zip bomb;
- the GenOffice 400 KB OOM fixture;
- malformed XML;
- tables nested 1,000 deep;
- external image links, OLE objects, UNC hyperlinks and an `attachedTemplate`;
- a Claude edit to a `HYPERLINK` or `INCLUDEPICTURE` field instruction that points outward.

**Pass.**
- With the gate in front, memory stays bounded and every case fails closed with a reason.
- The sidecar survives, and other open tabs keep their unsaved edits (#1310).
- External targets already in the file survive unchanged, and are listed for `docs/security.md`.
- A Claude edit cannot create one.
- No packet leaves the subject beyond the controls.

## Output

- **Tracked:** `docs/spikes/superdoc-engine-spike.md`, holding GO / NO-GO / NOT RUN per question.
  Anything more waits for Bryan to say what may be published.
- **Local:** everything else, in `private/superdoc-spike/`, including the comment-identity spec
  (ADR-052 Decision 4), which rests on S6's engine facts.
- **Human steps owed by Bryan:** opening S5's outputs in Word on Windows, and S6's Word facts.
- **An implementation PR sequence,** each step behind `DOCX_ENGINE`:
  1. adapter and import, with the session engine tag;
  2. the splice save and the new verify. Until step 3, a splice save refuses, with a reason,
     whenever the file contains any `w:comment` or the document holds any comment record.
     **Acceptance criteria that the spike cannot test**, because they need the real save path:
     - inject a browser edit and an MCP edit at every `await` inside the save: the file matches
       the snapshot, the document stays dirty, and the next save includes the late edit;
     - every place that sets the file hash is listed, and each is tested;
     - a save after a watcher reload succeeds, and so does one after a same-engine dirty restore,
       using the hash the restore set from disk;
     - a file changed on disk after open is refused through the external-conflict path;
     - a session built by the other engine, restored clean, re-parses, takes an edit and saves
       with untouched zip entries byte-identical; restored dirty or conflicted, it raises the
       conflict or refuses with a reason;
  3. comments, after the comment-identity spec has been written from S6's measurements and
     reviewed on its own;
  4. tracked changes;
  5. flip the default and file the dated deletion issue;
  6. one minor later, delete the legacy pipeline.

  The spike may reorder these, and must say why.
- **Still Bryan's:** the ADR-052 licence checklist, against the written terms. No implementation
  PR merges until it is ticked.
