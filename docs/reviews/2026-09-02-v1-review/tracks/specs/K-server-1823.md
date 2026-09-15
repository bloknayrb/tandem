# K-server — #1823 MCP surface: one wire code per condition, honest offsets and messages

Branch `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851`. **Refs #1823 only; the issue stays open.** Its server-runtime section is a later K-server PR, and its server-data bullets went to D1 (#1924). This spec lands after `K-server-1851.md`. Ledger rows: `areas/server-mcp.md:26`, `areas/crdt.md:23`, `areas/skill-plugin.md:27`. Probes: `experiments/probe-tools.mts` cases H7 and H62, and `crdt-verify.ts` §F. §F is now unreachable because the script crashes at §C, where #1848 refuses the zero-length range it builds, so it was re-measured inline on `c830e1aa`.

## Problem — every MCP-surface bullet, audited on `c830e1aa`

| # | Bullet | Status | Evidence |
|---|---|---|---|
| 1 | `tandem_comment` accepts a range past end | fixed-already | #1848 (`ffef634e`) |
| 2 | `tandem_getContext` accepts inverted/negative ranges | fixed-already | #1848 |
| 3 | `getTextContent({section})` returns no base offset | **fixed-here §H** | H62: `{"text":"## Costs\nCost body text","section":"Costs"}`. The review also found that `getSection` re-matches a same-named sub-heading and cuts the section short (§H). |
| 4 | Several wire codes for one condition | **fixed-here §A–E** | below |
| 5 | `tandem_open` accepts a relative path | **fixed-here §F** | `documents/open.ts` `resolveAndValidatePath` calls `path.resolve(filePath)` with no `isAbsolute` check |
| 6 | `tandem_status` with an unknown `documentId` says "No document open" | **fixed-here §G** | H7: the warning is "No document open" while `h7` is open |
| 7 | Read-only refusals say "(.docx)" | fixed-already | #1858 (#1798, `449adf58`): `readOnlyToolMessage` (`document.ts:99`); pinned by `html-read-only.test.ts` (`not.toContain(".docx")`) |
| 8 | Fractional `from`/`to` accepted | fixed-already | #1848 (`.int()` on the three live tools) |
| 9 | Refresh `kind` discarded | fixed-already | #1916 (`7989261d`): `annotations.ts:488` emits `anchor: "degraded" \| "failed"`. `updated` and `repaired` are success verdicts, and `output-schemas.ts` declares only the two degradation verdicts on purpose. Nothing left to do. |
| 10 | Zero-length ranges accepted | fixed-already | #1848; pinned in `range-bounds-validation.test.ts` (`reason: "empty"`); `docs/mcp-tools.md:302` |
| 11 | `to` equal to the first character of a heading prefix is refused, undocumented | code pinned (`positions.test.ts`, "keeps the exclusive-end asymmetry") and documented in `docs/architecture.md:656` and CLAUDE.md. Internally `validateRange` answers `HEADING_OVERLAP`; the handler maps that to the wire code `INVALID_RANGE` (`document.ts:814-817`), and no `mcpError` call emits `HEADING_OVERLAP`. **`docs/mcp-tools.md` is silent → fixed-here §I** | |
| 12 | `flatOffsetToRelPos` ±1 hardBreak drift | **reproduced; happens once, is written back on the first read, and is bounded to one separator character → left, #2001 (OPEN)** | A no-edit refresh turns `{8,12}` into `{9,12}` with kind `updated`, and `refreshRange` writes the new range into the Y.Map. The next read is `ok`. The list case is `{3,7}`→`{4,7}`. So a stored `from` that sits on a separator changes on its first read, with no edit. It is not display-only. Changing the anchoring contract needs its own `crdt-reviewer` pass. |
| 13 | `OutlinePanel.svelte` uses stale `range.from` | **left → #2002 (OPEN)** | `src/client/components/OutlinePanel.svelte:159`. A client change, and this group runs no E2E. |

## Fix

Rule for every wire code: converge on the code that `routes/_shared.ts#errorCodeToLabel` and the `docs/mcp-tools.md` table already give the condition. **Every rename below is client-visible.** Consumers were grepped in `skills/tandem/SKILL.md`, `src/client`, `src/channel`, `src/monitor` and `tests/e2e`:
- **SKILL.md** promises `FORMAT_ERROR` for read-only (`:29`, `:189`) and lists uploads under `FORMAT_ERROR` for `tandem_applyChanges` (`:189`). §B rewrites both.
- **`src/client`** also matches: `hooks/yjsSync.svelte.ts:50-60` `RENAME_SEMANTIC_ERROR_CODES` lists `READ_ONLY`/`INVALID_PATH`, and `actions/builtin.svelte.ts:570` matches `case "READ_ONLY"`. Both read the `/api` label vocabulary (`routes/_shared.ts`), not the MCP codes renamed here. That vocabulary is out of scope and does not change.

The PR body names each rename as a change to a documented contract.

- **A. Not pending → `ANNOTATION_RESOLVED`.** In `annotations.ts:552-556` (`tandem_resolveAnnotation`, `not-pending` arm), switch the code; the message is unchanged. `editAnnotation` (`:676-680`), `describeReplyWriteRefusal` (`lifecycle.ts:362-366`) and `/api` (`_shared.ts:234`) already emit `ANNOTATION_RESOLVED`. Drop `ANNOTATION_NOT_PENDING` from `ToolErrorCodeSchema`; that removal is compile-checked. In `docs/mcp-tools.md`, merge the `ANNOTATION_NOT_PENDING` and `ANNOTATION_RESOLVED` rows into one. The privacy (`invalid-note`) and ownership (`not-owned`) arms keep their order and codes.
- **B. Read-only → `READ_ONLY`** for `tandem_edit` (`document.ts:694-699`), `tandem_editList` (`:1094-1095`) and `tandem_appendContent` (`:1233-1237`). Messages stay as they are. Their real format refusals stay `FORMAT_ERROR`, and that is what makes the two conditions distinguishable. `applyChanges`, `restoreBackup`, `rename`, `/api` and the client's `saveSkippedMessage` already use `READ_ONLY`.
  - Docs: the `FORMAT_ERROR` and `READ_ONLY` table rows (both currently say the content mutators answer `FORMAT_ERROR`), plus `:293`, `:342`, `:380`.
  - **`skills/tandem/SKILL.md`:**
    - `:29`: "`tandem_edit` returns `FORMAT_ERROR`" becomes `READ_ONLY`.
    - `:189` (`FORMAT_ERROR` bullet): drop the read-only sentence, and rewrite "by `tandem_applyChanges` on anything that isn't a `.docx` opened from disk" as "by `tandem_applyChanges` on a non-`.docx` document".
    - Add a **`READ_ONLY`** bullet: the document is read-only (an upload, an explicit `readOnly` flag, or an `.html`); use annotations instead.
    - Add an **`INVALID_PATH`** bullet: the path is relative, UNC or otherwise refused, or `tandem_applyChanges` / `tandem_restoreBackup` was aimed at an upload or scratchpad, which has no file on disk.
  - **Bump `version:` to the next integer after `origin/master` at rebase (22 → 23 today), and update the literal in `tests/skill-instruction-contract.test.ts:113` in the same commit.** The launch flags say `skill=false`, but this group edits the shipped skill, so the orchestrator should treat `skill` as true. If it stays false, the PR body says the skill edit had no dedicated skill review.
- **C. Errnos → the `/api` mapping.** `EACCES` → `PERMISSION_DENIED`; `EBUSY`/`EPERM` → `FILE_LOCKED`.
  - `tandem_save` (`document.ts:1415-1421`): `EACCES` currently answers `FILE_LOCKED` and `EBUSY` falls through to `FORMAT_ERROR`. Keep `details.errorCode` and keep the `FORMAT_ERROR` fallback for everything else.
  - **`tandem_save` and `VERIFY_BLOCKED`.** `docs/mcp-tools.md:440` promises `VERIFY_BLOCKED` as a top-level code. In the code, `saveDocumentToDisk` returns `{status:"error", errorCode:"VERIFY_BLOCKED"}` (`document-service.ts:479-480`), and the handler has no such arm, so the wire carries `FORMAT_ERROR` with `details.errorCode: "VERIFY_BLOCKED"`. Converge on the docs: add `if (result.errorCode === "VERIFY_BLOCKED") return mcpError("VERIFY_BLOCKED", reason, { errorCode })` ahead of the fallback, and add `VERIFY_BLOCKED` to `ToolErrorCodeSchema`. No consumer matches `VERIFY_BLOCKED` in SKILL.md, `src/client`, `src/channel`, `src/monitor`, `tests/e2e` or `_shared.ts`. The mocked row below pins it.
  - `tandem_applyChanges` (`docx-apply.ts:525-526`): split `EACCES` out.
  - `tandem_rename` (`document.ts:1574`): add the three errno arms before #1851's `safeParse`. Docs: add `PERMISSION_DENIED` and `FILE_LOCKED` to the `tandem_rename` Errors line (`:530`); #1851 adds `RENAME_FAILED` there.
  - `tandem_open` (`:539-546`) already matches. `convert.ts`'s throw-site `PERMISSION_DENIED` classification stays as it is.
  - Docs `:57`, `:440`, `:885`.
- **D. Rejected or unusable path → `INVALID_PATH`.**
  - `tandem_open`: the `INVALID_PATH` arm (`document.ts:533-534`) currently emits `FILE_NOT_FOUND`.
  - `tandem_applyChanges`: `docx-apply.ts:505` currently emits `FORMAT_ERROR`. That covers a UNC `backupPath` and the upload-source refusal at `:159-163`, which then matches `convert`'s upload → `INVALID_PATH` (A8). After B and D, a `.docx` upload answers `INVALID_PATH`, a read-only `.docx` answers `READ_ONLY`, and only a non-`.docx` answers `FORMAT_ERROR`.
  - `tandem_restoreBackup`: split `:617-619` so `INVALID_PATH` → `INVALID_PATH` while `UNSUPPORTED_FORMAT` stays `FORMAT_ERROR`. Change the list-mode upload refusal at `:567-571` to `INVALID_PATH`, so list mode and restore agree on the same condition. The two restore-mode throws are `reload-family.ts:349-353` (source is not a file → `INVALID_PATH`) and `:355-362` (format outside `RESTORE_FORMATS` → `UNSUPPORTED_FORMAT`). Both run before the `readOnly` check, and the handler has no earlier refusal in restore mode.
  - **Rewrite the two comments that justify the old mapping:**
    - `docx-apply.ts:507-513`, which says "Reusing INVALID_PATH would map to FORMAT_ERROR here". It should now say `BACKUP_SYMLINK` and `INVALID_PATH` share a wire code on purpose, and that it stays a distinct internal code so it is never collapsed onto `BACKUP_FAILED`.
    - `docx-apply.ts:611-613`: only `UNSUPPORTED_FORMAT` is a format error.
  - Do not touch `documents/reload-family.ts` (PR #2000 owns it); only handlers change.
  - Docs `:45` (the `FILE_NOT_FOUND` row drops "or is a UNC path"), `:140`, `:885`, `:893-894`, `:931`.
- **E. `applyChanges` with a missing backup directory → `FILE_NOT_FOUND`.** The core already throws it (`docx-apply.ts:348-352`), but the handler has no arm, so it rethrows and becomes `INTERNAL_ERROR`. Add `if (e.code === "FILE_NOT_FOUND") return mcpError("FILE_NOT_FOUND", e.message)`. This matches `convert` and `exportAnnotations`. Docs `:885`.
- **F. `tandem_open` refuses a relative path.** In the handler, before `openFromDisk`, add `if (!path.isAbsolute(filePath)) return mcpError("INVALID_PATH", "filePath must be an absolute path.")`. It is a pure string check with no filesystem call.
  - **This is not containment and does not decide #1666.** `resolveAndValidatePath` is left alone, so `POST /api/open`, session restore and startup opens are unchanged.
  - Those callers already send absolute paths. The Tauri `validate_open_candidate` asserts `is_absolute` (`open_candidate.rs`), and the client's `openServerPath` sends server-emitted paths.
  - A grep of `tandem_open` `filePath` arguments in `tests/server` and `tests/e2e` showed 191 `path.join(tmpDir, …)` and a handful of variables, none of them visibly relative. That grep was a sample, so the full suite run is what confirms it.
  - **Platform split.** `path.isAbsolute` reads the backslash UNC spelling `\\server\share\x.md` as relative on POSIX (so F answers) and as absolute on win32 (so `assertSafePathPrefix` in `resolveAndValidatePath` answers, reaching the D arm). The forward-slash spelling `//server/share/x.md` is absolute on both platforms. `rejectUnsafeWindowsPrefix` normalises `/` to `\` before checking (`windows-path-safety.ts:72`) and refuses it as bare UNC (`:81-83`). `assertSafePathPrefix(filePath)` runs on the raw input before any filesystem call (`open.ts:686`), so that spelling reaches the D arm on both platforms.
  - Docs `:140`.
- **G. `tandem_status` write with an unknown id.** At `document.ts:1455-1459`, when `documentId` is truthy, the warning becomes `` `Document ${documentId} is not open — status not broadcast to editor.` `` (the precedent is `convert`'s "Document X is not open."). The no-id case is unchanged and stays pinned by `mcp-output-schemas.test.ts:279`.
- **H. The section read returns `offset`, and `getSection` stops re-matching.**
  - **Guard the match.** `getSection` (`document.ts:255-299`) runs its name-match branch even when `inSection` is already true. A later sub-heading with the same name matches again and resets `sectionLevel`, which also cuts the section short. Measured on the worktree: for `## Costs / intro / ### Costs / detail / ### Sub / more / ## Next`, it returns `"## Costs\nintro\n### Costs\ndetail"` and drops `### Sub` and `more`.
    - Change the condition to `!inSection && text.trim().toLowerCase() === …`. A same-named sub-heading then falls through to the in-section branch and is pushed as a heading.
    - Record `index = i` exactly once, inside that guarded branch, and return `{ found: true, text, index }`.
    - `local-model/tools.ts:340` (`read_section`) also calls `getSection`. The `index` field is additive for it, but the guard changes what it returns in this layout, which is the same fix. The local-model path ships dark (`BYO_MODELS_ENABLED = false`).
    - The existing `getSection` tests (`tests/server/document-tools.test.ts:70-94`) assert `.found` and `.text`, not `toEqual`, so the extra field breaks none of them.
  - **Offset.** The handler takes the `collectBlocks(r.doc)` heading block whose `path` is `[index]` and computes `offset = block.from - headingPrefix(level).length`. A top-level heading block's `from` is past its prefix, `document-model.ts:455-461`.
    - `collectBlocks` and `getSection` agree on the walk. Both skip non-`XmlElement` nodes, both flatten heading text in a length-preserving way (`flattenHeadingText`), both let a zero-text top-level node consume a separator (`document-model.ts:436-438`), and `path[0]` is the same fragment index as `getSection`'s `i`.
    - Return `{ text, filePath, section, offset }`. Add `offset: z.number().int().optional()` to `getTextContentOutputShape` (`output-schemas.ts:186-191`); the SDK rejects an undeclared field.
    - In the description (`document.ts:581-587`), say that a section read's offsets are relative to `offset`. Update the docs return block and notes (`:190-229`).
    - **Critical Rule 5:** `extractText` only.
- **I. Heading asymmetry in docs.** Extend `docs/mcp-tools.md:95`, and phrase it for every range tool that refuses heading overlap, not `tandem_edit` alone: `positions.ts:638-653` ORs the endpoint term in unconditionally, and only the interior term is gated on `rejectHeadingInterior`. Wording: "This applies to every range-taking tool that refuses heading overlap (`tandem_edit`, `tandem_comment`, suggestions): a `to` equal to the first character of a heading prefix is rejected with `INVALID_RANGE`, even though `to` is exclusive. On `"para\n## Head\nnext"`, `[0,5)` is refused and `[0,4)` is accepted." The example matches `tests/server/positions.test.ts:172-199`. The interior-term distinction stays in CLAUDE.md Rule 6 and `architecture.md`. No code change.

## Tests

`tests/server/mcp-wire-codes.test.ts` (new) drives the real tools through an in-memory client (the `setupMcpClient` shape from `mcp-tool-integration.test.ts`, plus `registerApplyTools`). It is one `it.each` table, and each row asserts `code` exactly.
- **A:** the fixture is a **`author: "claude"` comment with `audience: "outbound"`, status `dismissed`**. Any other author answers `NOT_OWNED` from edit and reply, and a note or private comment answers `INVALID_ARGUMENT`. All three tools on it → `ANNOTATION_RESOLVED`. That kills a fix that leaves `resolve` on the old code. **Twin:** a dismissed `note` still answers `INVALID_ARGUMENT` from all three, which pins that the rename did not reorder the privacy guard.
- **B:** the three mutators on `readOnly` → `READ_ONLY`. **Twins:** `appendContent` on a writable `.txt` and `editList` on a writable `.txt` → `FORMAT_ERROR`, which kills a blanket `FORMAT_ERROR`→`READ_ONLY`.
- **D/F:**
  - **`tandem_open` on `//server/share/x.md` → `INVALID_PATH`; the message contains `UNC` and does not contain `absolute`.** This path is absolute on POSIX and win32, so it gets past F and reaches the `document.ts:533` arm on **both** ubuntu `check` and the local Windows run. It is the row that pins the D rename on the required CI leg.
  - `tandem_open` on `\\\\server\\share\\x.md` → `INVALID_PATH`, asserting `code` only. On ubuntu CI this takes the F branch, and on the local Windows run the `assertSafePathPrefix` branch, so neither run alone covers both. The PR body says so.
  - **`tandem_open` on a relative path to a file that exists** → `INVALID_PATH`; the message mentions "absolute" and `getOpenDocs().size` does not change. Build it as `path.relative(process.cwd(), tmpFile)` over a real `.md` in the test's temp dir, and first `expect(path.isAbsolute(rel)).toBe(false)`, so a cross-drive layout, where `path.relative` returns an absolute path, fails loudly instead of testing nothing. Without F this open **succeeds**, so the size assertion goes red, not just the code.
  - **Twin:** a missing absolute path → `FILE_NOT_FOUND`, which kills folding ENOENT into `INVALID_PATH`.
  - `applyChanges`: UNC `backupPath` → `INVALID_PATH`; upload source → `INVALID_PATH`; `readOnly` → `READ_ONLY`; a `.md` → `FORMAT_ERROR` (twin).
  - `restoreBackup` list mode on an upload → `INVALID_PATH`.
  - **`restoreBackup({backup: "x"})` on an `upload` doc → `INVALID_PATH`** (restore mode, `reload-family.ts:349-353`).
  - **Twin: `restoreBackup({backup: "x"})` on a writable, `source: "file"` `.html` doc → `FORMAT_ERROR`** (`:355-362`). This kills folding `UNSUPPORTED_FORMAT` into `INVALID_PATH`.
- **E:** a real `.docx` with one accepted suggestion (lift the fixture from `docx-apply.test.ts`'s "write guards" describe) and `backupPath` in a missing directory → `FILE_NOT_FOUND`, **not** `INTERNAL_ERROR`.
- **G:** doc `a` open, status with `documentId: "nope"` → the warning contains `nope` and not "No document open".
- **H:** every fixture asserts `extractText(doc).slice(offset, offset + text.length) === text`.
  1. A second section after content.
  2. A section holding a list.
  3. A document opening with a heading.
  4. **Same-named sub-heading:** `## Costs / intro / ### Costs / detail / ### Sub / more / ## Next`. Assert `offset === 0` and that `text` contains `more`.
  5. **Decoy text:** paragraphs `"## Costs"` and `"Cost body text"` before the real `## Costs` heading and its `"Cost body text"`. Assert `offset` equals the real heading's start, and not `extractText(doc).indexOf(text)`. This kills an `indexOf` derivation that passes fixtures 1–3.
  6. **Zero-text separator:** `paragraph, horizontalRule, ## Section, body`.
  7. **Flattened heading:** a section whose own heading text contains a literal newline.

  Fixtures 1–3 kill `offset = block.from` (off by the prefix length) and any count that skips separators.

`tests/server/mcp-wire-codes-mocked.test.ts` (created by #1851) covers the errno rows (C), using the `convert-error-mapping.test.ts` pattern with `importOriginal` spreads.
- `openFromDisk` rejecting `EACCES`/`EBUSY`/`EPERM`: this pins what already matches.
- `saveDocumentToDisk` returning `EACCES` → `PERMISSION_DENIED`, `EBUSY`/`EPERM` → `FILE_LOCKED`, and `ENOSPC` → `FORMAT_ERROR`. The `ENOSPC` row is an over-fold negative.
- **`saveDocumentToDisk` returning `errorCode: "VERIFY_BLOCKED"` → code `VERIFY_BLOCKED`, with `details.errorCode === "VERIFY_BLOCKED"`.**
- `renameDocument` with `EACCES` → `PERMISSION_DENIED`, **`EBUSY` → `FILE_LOCKED`, and `EPERM` → `FILE_LOCKED`**.
- `file-io/index.js#atomicWriteBuffer` rows use the E `.docx` document **with a backup directory that exists** (the default sidecar location). With a missing backup directory the core throws `FILE_NOT_FOUND` at `docx-apply.ts:348-352`, before the only `atomicWriteBuffer` call at `:428`. Rejecting `EACCES` → `PERMISSION_DENIED` is the row that tells old from new. Rejecting `EPERM` → `FILE_LOCKED` pins existing behaviour (`:525`).

**Existing literals to update** (every `toBe("FORMAT_ERROR" | "FILE_LOCKED" | "FILE_NOT_FOUND" | "ANNOTATION_NOT_PENDING")` in `tests/server` was grepped against each changed arm):
- `resolve-annotation.test.ts:107,129,150` → `ANNOTATION_RESOLVED`.
- `mcp-tool-integration.test.ts:1818` (read-only `.docx` `appendContent`) → `READ_ONLY`.
- `restore-backup.test.ts:955` (list mode on an upload) → `INVALID_PATH`.
- `skill-instruction-contract.test.ts:113`.

These stay as they are, because their arms do not change:
- `mcp-tool-integration.test.ts:319` (`convert` on `.md`).
- `mcp-tool-integration.test.ts:1413` and `:1428` (`tandem_search` query too long).
- `mcp-tool-integration.test.ts:1837` (`appendContent` on non-Markdown).
- `mcp-tool-integration.test.ts:262` (`convert` missing `outputPath` directory).

No `FILE_LOCKED` or `ANNOTATION_NOT_PENDING` assertion exists elsewhere in `tests/server` or `tests/e2e`.

**Mutations (restore from a file copy):**
- A: put the old code back at `annotations.ts:554` → the A resolve row goes red.
- B: put `FORMAT_ERROR` back in `tandem_edit` → B goes red.
- C:
  - put `FILE_LOCKED` back for `EACCES` in save → the save `EACCES` row goes red;
  - delete the `VERIFY_BLOCKED` arm → the `VERIFY_BLOCKED` row goes red;
  - drop the rename `EBUSY` arm → the rename `EBUSY` row goes red.
- D:
  - put `FORMAT_ERROR` back at `docx-apply.ts:505` → the applyChanges upload row goes red;
  - **put `FILE_NOT_FOUND` back at the `tandem_open` `INVALID_PATH` arm (`document.ts:534`) → the `//server/share/x.md` row goes red** (on ubuntu CI as well as Windows);
  - **restore the combined `:617` arm → the restore-mode upload row goes red.**
- E: delete the new arm → E goes red.
- F: delete `isAbsolute` → the relative-path row goes red, on both its code and its size assertion.
- G: put the old warning back → G goes red.
- H:
  - drop `- prefixLen` → fixtures 1–3 go red;
  - **remove the `!inSection` guard → fixture 4 goes red;**
  - **swap in `indexOf` → fixture 5 goes red.**

## Files touched

- `src/server/mcp/annotations.ts`
- `src/server/mcp/document.ts`
- `src/server/mcp/docx-apply.ts` (codes and the two comments)
- `src/server/mcp/output-schemas.ts`
- `src/shared/types.ts` (drop `ANNOTATION_NOT_PENDING`, add `VERIFY_BLOCKED`)
- `docs/mcp-tools.md`
- `skills/tandem/SKILL.md`
- `tests/server/{mcp-wire-codes,mcp-wire-codes-mocked,resolve-annotation,mcp-tool-integration,restore-backup}.test.ts`
- `tests/skill-instruction-contract.test.ts`

Not touched: `local-model/tools.ts`, which picks up the `getSection` fix through the call.

## Done when

Rows 3–6 and 11 are fixed and pinned, 12 and 13 point at #2001/#2002, and every mutation has been seen red. `typecheck`, `typecheck:tests` and the touched suites pass.

The PR body carries:
- this audit table and the list of renames;
- a contract-change note that **stdio-mode users keep their old skill after upgrading.** `refreshExistingSkillIfStale` runs only in HTTP mode, so they receive `READ_ONLY` while their skill still says `FORMAT_ERROR`;
- `Refs #1823`.

**CI:** everything here is Node-only. Ubuntu `check` runs the vitest and typecheck legs, and a local Windows run is the only Windows evidence. POSIX `path.isAbsolute` semantics are exercised by CI, not locally. The PR body says which UNC row ran which branch on which leg.

## Not in scope

#1823's server-runtime and server-data sections; root confinement (#1666); the `/api` labels; #2001; #2002.

## Review corrections (round 1)

**Adopted:**
1. **B1:** `getSection` re-matches a same-named sub-heading. §H now guards the match with `!inSection`, records `index` once, adds fixture 4 (slice identity + `text` contains `more`) and a guard-removal mutation, and notes the effect on `local-model/tools.ts:340`. Verified at `document.ts:275-281`.
2. **B2/B4/B5 (one fix):** the backslash UNC row takes F's branch on ubuntu. Added a `//server/share/x.md` row that asserts `INVALID_PATH` and a message containing `UNC` and not `absolute`, plus the mutation "`FILE_NOT_FOUND` back at `document.ts:534`". Verified: `rejectUnsafeWindowsPrefix` normalises `/` (`windows-path-safety.ts:72`), and `assertSafePathPrefix` runs on the raw input first (`open.ts:686`).
3. **B3:** SKILL.md `:189` said `applyChanges` returns `FORMAT_ERROR` on anything but a disk `.docx`. §B now rewrites that clause and adds `READ_ONLY` and `INVALID_PATH` bullets.
4. **B6:** restore-mode split had no row. Added upload-restore → `INVALID_PATH` and `.html` file restore → `FORMAT_ERROR`, plus the mutation that restores the combined `:617` arm. Verified at `reload-family.ts:349-362`.
5. §I names the wire code `INVALID_RANGE`, not `HEADING_OVERLAP` (`document.ts:814-817`). Audit row 11 was also reworded.
6. §I is phrased for every range tool that refuses heading overlap, not `tandem_edit` only (`positions.ts:638-653`).
7. H fixture 6: a zero-text top-level node (horizontalRule) before the section.
8. H fixture 7: a heading containing a literal newline (the flatten path).
9. H fixture 5: decoy literal text, to kill an `indexOf` derivation.
10. Audit row 12 now says the drift is one-time, written back on the first read and bounded to one separator character.
11. §F records that the backslash UNC row takes different branches on ubuntu and Windows; the table asserts `code` only for it, and the PR body says so.
12. The `atomicWriteBuffer` rows use a backup directory that exists. The E fixture throws `FILE_NOT_FOUND` first (`docx-apply.ts:348-352` vs `:428`). EACCES is named as the discriminating row and EPERM as a pin of existing behaviour.
13. The A fixture is stated: a Claude-authored outbound comment, dismissed. A dismissed-note twin still answers `INVALID_ARGUMENT`.
14. The consumer-grep claim is corrected: client hits exist, on the `/api` label vocabulary only.
15. **Skill flag:** the spec says the orchestrator should treat `skill` as true for this group; otherwise the PR body says the skill edit had no dedicated skill review.
16. The `tandem_rename` docs Errors line (`:530`) gains `PERMISSION_DENIED` and `FILE_LOCKED`.
17. The two `docx-apply.ts` comments (`:507-513`, `:611-613`) are rewritten in §D.
18. The literal list is complete: grepped, `:1818` changes, and `:262`, `:319`, `:1413`, `:1428` and `:1837` do not.
19. The PR body notes that stdio-mode users keep the old skill.
20. Rename errno rows now include `EBUSY` and `EPERM`, with a mutation.
21. The relative-path row uses a file that exists, so it reproduces the defect (it opens without F). See not-adopted for how.
22. **`VERIFY_BLOCKED`:** decided rather than left to "write down what driving it shows". The code emits `FORMAT_ERROR` + `details.errorCode`, while the docs promise a top-level `VERIFY_BLOCKED`. §C converges on the docs, with a mocked row and a mutation.

**Not adopted (or adopted with a change):**
- Relative-path row using `README.md` from the repo root. Adopted in substance but not in that form: opening a tracked repo file arms a real watcher and annotation store against the checkout. The row uses `path.relative(process.cwd(), tmpFile)` over a temp file instead, with an `isAbsolute` precondition so a cross-drive layout fails loudly. It still opens successfully without F.
- Changing the orchestrator's `skill` flag. This agent cannot change launch flags. The finding is recorded here and in the PR-body instruction instead.
