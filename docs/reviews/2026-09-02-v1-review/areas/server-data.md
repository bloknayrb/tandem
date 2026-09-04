# Area: Server data (file I/O, sessions, markdown and docx)

**Raw:** [`../raw/findings-server-data.txt`](../raw/findings-server-data.txt) (Fable, resumed, 5 calls)
and [`../raw/gapfill-E.txt`](../raw/gapfill-E.txt) (Opus, docx/markdown experiments).
**Manifest:** [`../raw/manifests/server-data.md`](../raw/manifests/server-data.md).
**Tracks:** [A](../tracks/A-stop-the-bleeding.md) for the watcher, session key and corrupt-state
items; [D](../tracks/D-word-and-markdown.md) for everything that touches the markdown or docx
pipelines; Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** every High re-run by the orchestrator from
[`../experiments/`](../experiments/README.md); three Mediums read only.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/server/file-watcher.ts:64-69`; `index.ts:349` | `fs.watch` is inode-bound; after the first rename-replace, including Tandem's own `atomicWrite`, it emits `rename, rename` then nothing. No save path re-arms it (only `suppressNextChange`). External edits go undetected and the mtime guard (`document-service.ts:383`) then refuses every save with no banner. | [ran] | **FIXED.** Reproduced on Linux (`watch-rename.mjs`) AND on Windows, where the shape is different and the bug is the same: an external tmp+rename delivers `rename, rename` and NO `change`, so the `:69` early return made an atomic external save invisible there too — while the handle itself survives (`ReadDirectoryChangesW` on the parent), so Windows needs no re-arm. Fix: `rename` schedules the debounce; delivery `stat`s the path and re-arms in place on POSIX; `rearmWatch` is exported and called in an inner `finally` at the five document-write sites. Evidence per platform: `tests/server/file-watcher-real-fs.test.ts` (local run = Windows, ubuntu `check` = Linux); macOS is UNRUN and given the Linux treatment on a reading of libuv's FSEvents backend, stated as unverified. | [#1749](https://github.com/bloknayrb/tandem/issues/1749) |
| H | `src/server/session/manager.ts:29-31,105`; `autosave.ts:26-34`; `document-service.ts:502,509` | `sessionKey = encodeURIComponent(path)` hits ENAMETOOLONG at ~85 non-ASCII chars; the autosave loop has no per-document try/catch so one document kills session autosave for all; `saveSession` throws before `SAVED_AT_VERSION` is written, so every later save reads "modified externally". | [ran] | **FIXED.** Reproduced with `exp4.ts` — a 75-character Cyrillic path yields a 295-byte legacy key and the write fails; a 48-character CJK path yields 234 bytes. After: 64 bytes, both write. All three faults addressed: `sessionKey` hashes disk paths via `docHash` (uploads keep the legacy key, because hashing collapses every scratchpad to one name) with a read-once migration; both session loops gained a per-document try/catch plus one deduped notification; and `saveSession` moved LAST in `saveDocumentToDisk`, in its own try/catch with a best-effort `deleteSession`, so a session failure can no longer un-stamp a successful disk write. Evidence is Windows-local plus ubuntu `check`. | [#1750](https://github.com/bloknayrb/tandem/issues/1750) |
| H | `src/server/file-io/mdast-ydoc.ts:886-893,714-720,651` | Marks inside frontmatter, footnote definitions, HTML blocks and code blocks serialize as literal `<bold>` XML via `Y.XmlText.toString()`; reachable server-side through a cross-block `tandem_edit`. | [ran] | Reproduced (`exp2.ts`) | [#1751](https://github.com/bloknayrb/tandem/issues/1751) |
| H | `src/server/positions.ts:110,189` | `validateRange` / `anchoredRange` accept mid-surrogate offsets; the edit writes U+FFFD on both sides. Extends the bounds finding in the MCP area. | [ran] | Reproduced (`exp2.ts`, `exp8.ts`) | [#1752](https://github.com/bloknayrb/tandem/issues/1752) |
| H | `src/server/file-io/markdown.ts:136-160` | `[[wikilinks]]` and `![[embeds]]` saved as `\[[…]]`; user backslash escapes stripped on save. | [ran] | Reproduced (`exp5.ts`) | [#1753](https://github.com/bloknayrb/tandem/issues/1753), [decision A](../decisions.md) |
| H | `src/server/file-io/docx-walker.ts:164,168,200-205,215,267-269` + `docx-apply.ts:522`; `docx.ts:47` | Flat-text contract broken against mammoth: `w:tab`, `w:br`, `w:sym` make `applyTrackedChanges` throw "Flat text mismatch"; one `\n` per `w:p` while mammoth drops empty paragraphs (+1 per blank, cumulative); `w:br type="page"` counted as 1 while mammoth emits nothing (−1, spills across blocks); footnote refs and headings in cells mis-anchor. The wrong range is written back on save. | [ran] | Reproduced (`e1-docx.ts` cases 1, 2b; `exp6.ts`, `exp7.ts`). Footnote/heading-in-cell shapes not in the re-run output. | [#1754](https://github.com/bloknayrb/tandem/issues/1754), [decision B](../decisions.md) |
| H | `src/server/file-io/docx-html.ts:325,573-633`; `docx-lost-features.ts:199` | Body inline images dropped on import with no banner; export overwrites the original image-less. `docx-roundtrip-fidelity.test.ts:253` already names this "breaks". | [ran] | Reproduced (`exp4.ts`) | [#1755](https://github.com/bloknayrb/tandem/issues/1755) |
| M | `mdast-ydoc.ts:433-434` | `file:` and `data:image/svg+xml` image sources replaced by alt text on save. | [ran] | Reproduced (`exp4.ts`) | [#1755](https://github.com/bloknayrb/tandem/issues/1755) |
| M | `mdast-ydoc.ts:219-221`, `:265-268` | Inline image splits its paragraph into three blocks and loosens list items; fence meta string dropped. | [read] | Agent-reported | [#1799](https://github.com/bloknayrb/tandem/issues/1799) |
| M | `documents/open.ts:995-1094` (`maybeRestoreSession`, with the `restoreYDoc` call, the recovery block and the empty-fragment fall-through); `session/manager.ts:235-260` (`loadSessionWithPath`), `:417-466` (`quarantineSession`); `mcp/document-service.ts:1778-1801` (`restoreOpenDocuments`, unchanged) | A corrupt `ydocState` throws on restore and is never quarantined; the document is unopenable by every path. | [ran] | **FIXED** (`fix/quarantine-corrupt-ydocstate-1800`, closes #1800). The `restoreYDoc` call is caught, the file quarantined to `<name>.json.corrupt.<ts>` (mtime touched so the 30d GC runs from the quarantine), partial state evicted on the same doc (incl. the fifth map, `Y_MAP_AUTHORSHIP`), the migration-loser fallback cloned once from a scratch doc with re-minted authorship anchors and re-anchored annotation ranges, then disk. Unparseable JSON quarantines (no longer unlinks) from `loadSessionWithPath`, `loadSession`'s old `unlink` branch, and the `listSessionFilePaths` boot sweep. Evidence: round-15 probe before/after (`openFromDisk` with a corrupt `ydocState`: 5 shapes THREW → all RESOLVED with disk content, 1 quarantine, 1 toast) + `tests/server/session-restore.test.ts` (#1800 suite). Follow-up (two non-throwing shapes not covered: wrong-document update restores wrong content as success; annotations-only update reaches the store with a ghost entry — plus the session-record-should-win-over-envelope refinement): text in the PR body, to be filed at push time. | [#1800](https://github.com/bloknayrb/tandem/issues/1800) |
| M | `documents/populate.ts:~330-345` | Force-open and source-view commit call `store.clear()`, which unlinks the on-disk annotation envelope including personal notes, with no backup. | [read] | Source-confirmed | [#1813](https://github.com/bloknayrb/tandem/issues/1813), [decision C](../decisions.md) |
| L | `index.ts:349-364`; `document-model.ts:721`; others | `atomicWrite` temp leak on `writeFile` failure and mode/hardlink loss; `tandem_edit` inherits link/rawMarkdown marks; BOM dropped; unescaped `\|` in a code span splits cells; setext hard break lost on save; mtime guard vs share clock skew `[inferred]`; sessionKey case-sensitive on NTFS/APFS `[inferred]`. | mixed | Agent-reported | [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Cross-checks done before filing

- #1693 (w:id ghost predicate, write-seam census) and #1632 (UI accept gate on lost targets) were
  read: neither covers the empty-paragraph or page-break drift, so #1754 is new.
- `w:tab` was the reviewer's original suspect for the drift and is refuted (case 2c of `e1-docx.ts`
  matches); the table is in [refuted.md](../refuted.md).

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`mcp-tools.md:5,65,255-256` and `SKILL.md:22` say "character offsets" (they are UTF-16 code units);
CLAUDE.md's force-open sentence omits the envelope unlink; `gotchas.md:154` NTFS-centric;
`docx-walker.ts:4` states a contract the code does not meet; `docx-export.ts:20-22` image claim
false; `reaper.ts:47`; `manager.ts:120` log text; ADR-042 normalization set incomplete;
`README.md:42,102` on `.html`.

## Verified fine

Offset round-trip property; line endings byte-exact; the 107-construct corpus
(`experiments/rt.ts`) is idempotent; store, tombstone, lock and rename-recovery paths; reaper
confinement; escaped table pipes; hard break inside a heading (one flat char).
