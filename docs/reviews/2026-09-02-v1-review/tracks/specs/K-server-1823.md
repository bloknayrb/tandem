# K-server — #1823 MCP surface: one wire code per condition, honest offsets and messages

Branch `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851`. **Refs #1823 only; it stays open.** Its server-runtime section is a later PR, and server-data went to D1 (#1924). This spec lands after `K-server-1851.md`.

## Audit of the MCP-surface bullets

Measured on `c830e1aa`, re-checked against `origin/master` `a6e7352f`.

| # | Bullet | Status |
|---|---|---|
| 1 | `tandem_comment` accepts a range past end | fixed-already, #1848 |
| 2 | `tandem_getContext` inverted/negative ranges | fixed-already, #1848 |
| 3 | `getTextContent({section})` offsets vs the description | **fixed-here §H** (the description stops promising it) |
| 4 | Several wire codes for one condition | **fixed-here §A–E** |
| 5 | `tandem_open` accepts a relative path | **fixed-here §F** |
| 6 | `tandem_status` unknown id says "No document open" | **fixed-here §G** |
| 7 | Read-only refusals say "(.docx)" | fixed-already, #1858 (`readOnlyToolMessage`; `html-read-only.test.ts`) |
| 8 | Fractional `from`/`to` | fixed-already, #1848 |
| 9 | Refresh `kind` discarded | fixed-already, #1916 (`anchor: "degraded"` or `"failed"`; `updated`/`repaired` are success verdicts) |
| 10 | Zero-length ranges | fixed-already, #1848 (`reason: "empty"`) |
| 11 | Heading exclusive-end asymmetry undocumented | code pinned in `positions.test.ts`; **`docs/mcp-tools.md` fixed-here §I** |
| 12 | `flatOffsetToRelPos` hardBreak drift | reproduced (`{8,12}` becomes `{9,12}` on a no-edit refresh) → left, **#2001** |
| 13 | `OutlinePanel.svelte` stale `range.from` | left (client change; this group runs no E2E) → **#2002** |

## Fix

Each condition converges on the code already given to it by `docs/mcp-tools.md`'s table and `routes/_shared.ts`. **Every rename is client-visible.** Consumers were grepped:
- `skills/tandem/SKILL.md` (`:29`, `:189`): rewritten in §B.
- `src/client`: matches only the `/api` label vocabulary, which is unchanged.
- `src/channel`, `src/monitor`, `tests/e2e`: none.

The PR body lists each rename as a documented-contract change. It also notes that stdio-mode users keep their old skill, because `refreshExistingSkillIfStale` runs only in HTTP mode.

- **A. Not pending → `ANNOTATION_RESOLVED`.** `tandem_resolveAnnotation`'s not-pending arm (`src/server/mcp/annotations.ts:554`) switches code; edit and reply already emit `ANNOTATION_RESOLVED`. Drop `ANNOTATION_NOT_PENDING` from `ToolErrorCodeSchema`. In `docs/mcp-tools.md:72-73`, merge the two rows.
- **B. Read-only → `READ_ONLY`** for `tandem_edit` (`document.ts:695`), `tandem_editList` (`:1095`) and `tandem_appendContent` (`:1234`). Format refusals stay `FORMAT_ERROR`.
  - Docs: rows `:47` and `:59`, and Errors lines `:293`, `:342`, `:380`.
  - SKILL.md: `:29` says `READ_ONLY`. In `:189`, drop the read-only sentence and rewrite the `applyChanges` clause to "on a non-`.docx` document". Add a `READ_ONLY` bullet, and an `INVALID_PATH` bullet (a relative or UNC path, or `tandem_applyChanges`/`tandem_restoreBackup` on an upload or scratchpad).
  - Bump `version:` 22 → 23 and update both literals in `tests/skill-instruction-contract.test.ts`: the `:113` version and the `:434` `{version, bodyHash}`.
  - The launch flag is `skill=false`, so the PR body says the skill edit had no dedicated skill review.
- **C. `EACCES` → `PERMISSION_DENIED`; `EBUSY`/`EPERM` → `FILE_LOCKED`.**
  - `tandem_save` (`document.ts:1415-1422`) sends `EACCES` to `FILE_LOCKED` today, and `EBUSY` falls to `FORMAT_ERROR`. Keep `details.errorCode` and the `FORMAT_ERROR` fallback.
  - `tandem_applyChanges` (`docx-apply.ts:525-526`): split `EACCES` out.
  - `tandem_open` already matches.
  - Docs `:57`, `:440`, `:885`.
- **D. Rejected or unusable path → `INVALID_PATH`.**
  - `tandem_open`'s `INVALID_PATH` arm (`document.ts:534`) sends `FILE_NOT_FOUND` today.
  - `tandem_applyChanges` at `:505` sends `FORMAT_ERROR` today. That one arm covers both a UNC `backupPath` (`:136-139`) and the upload refusal (`:161`).
  - `tandem_restoreBackup`: change the list-mode upload refusal (`:567-571`). Split `:617-618` so `INVALID_PATH` answers `INVALID_PATH` and `UNSUPPORTED_FORMAT` stays `FORMAT_ERROR`. After that, an upload gets one code across all three tools, the same as `convert`.
  - Rewrite the two comments that justify the old mapping (`docx-apply.ts:507-513`, `:611-613`).
  - Only handlers change; `reload-family.ts` is untouched.
  - Docs `:45`, `:140`, `:885`, `:893-894`, `:931`.
- **E. `applyChanges` missing backup dir → `FILE_NOT_FOUND`.** The core already throws it (`docx-apply.ts:348-352`). The handler has no arm, so it rethrows as `INTERNAL_ERROR`. Add the arm. Docs `:885`.
- **F. `tandem_open` refuses a relative path.** Before `openFromDisk` in the handler: `if (!isFullyQualifiedPath(filePath)) return mcpError("INVALID_PATH", "filePath must be an absolute path.")`.
  - **Not `path.isAbsolute` (PR-review round 1).** On win32 `path.isAbsolute` is true for a drive-less root-relative path (`\docs\a.md`, `/Users/me/a.md`), and `path.resolve` then prefixes the drive of the process cwd. `isFullyQualifiedPath` requires a drive root or a two-separator UNC shape on win32, where the UNC shape is left for `assertSafePathPrefix` to refuse. It takes `platform` as a parameter so the win32 half runs on the ubuntu `check` leg.
  - A string check, not containment; it does not decide #1666.
  - **`docs/security.md` drift is filed as #2005, not fixed here.** Its #1654 bound says `docx-apply.ts` still folds `INVALID_PATH` onto `FORMAT_ERROR`, and §D removes that fold. The file belongs to K-sec-launcher.
  - `resolveAndValidatePath` is untouched, so `/api/open`, restore and startup opens are unchanged. The Tauri caller already asserts `is_absolute`.
  - Docs `:140` and `:115`. Rewrite the `filePath` row at `:115`: a relative path is refused with `INVALID_PATH`, matching the table's own `INVALID_PATH` row. Keep the sentence "There is no root confinement either (#1666, open)", so the edit cannot be read as deciding #1666. Drop the stale `open.ts:678` citation.
- **G. `tandem_status`** (`document.ts:1458`): when `documentId` is given, the warning becomes `` `Document ${documentId} is not open — status not broadcast to editor.` ``. The no-id case is unchanged. An empty-string `documentId` counts as no id (a truthy check, PR-review round 1): `getCurrentDoc("")` returns null without looking it up, so naming it would print `Document  is not open`.
- **H. Section offsets: fix the description, not the return.**
  - The description (`document.ts:581-587`) says offsets "line up exactly" and then offers `section`. Add: "A `section` read returns that section's text only, and its offsets are not document offsets. Read without `section`, or use `tandem_search`/`tandem_resolveRange`, before anchoring."
  - Make the same change in `docs/mcp-tools.md:194` and `:227`.
  - No `offset` field and no `getSection` change. Its same-named sub-heading re-match is filed separately as **#2003**.
- **I. Heading asymmetry in docs.** Extend `docs/mcp-tools.md:95` with this example: on `"para` + newline + `## Head` + newline + `next"`, `[0,5)` is rejected with `INVALID_RANGE` even though `to` is exclusive, and `[0,4)` is accepted. It matches `tests/server/positions.test.ts`.

## Tests

### `tests/server/mcp-wire-codes.test.ts` (new)

Drives real tools with `setupMcpClient` (from `mcp-tool-integration.test.ts`) plus `registerApplyTools`. Each row asserts `code` exactly.

- **B:** `tandem_edit` and `tandem_editList` on a `readOnly` doc → `READ_ONLY`.
- **D, open UNC:** `tandem_open("//server/share/x.md")` → `INVALID_PATH`. The message contains `UNC` and does not contain `absolute`.
  - That spelling is absolute on both POSIX and win32, so it gets past F.
  - `assertSafePathPrefix` (`open.ts:686`) refuses it on the raw input before any fs call, because `rejectUnsafeWindowsPrefix` normalises `/` first.
  - So it reaches `document.ts:534` on ubuntu `check` as well as on Windows.
- **D, applyChanges:** `backupPath: "//server/share/b.docx"` → `INVALID_PATH`; upload source → `INVALID_PATH`.
- **D, restore:**
  - `restoreBackup({backup: "x"})` on an upload → `INVALID_PATH`.
  - Twin: the same call on a writable `source: "file"` `.html` doc → `FORMAT_ERROR`. It kills folding `UNSUPPORTED_FORMAT` into `INVALID_PATH`.
- **E:** a real `.docx` with one accepted suggestion (fixture from `docx-apply.test.ts`), and `backupPath` in a missing directory → `FILE_NOT_FOUND`.
- **F:** `path.relative(process.cwd(), tmpFile)` over a real `.md` in the temp dir.
  - Precondition: `expect(path.isAbsolute(rel)).toBe(false)`.
  - Expect `INVALID_PATH`, with `getOpenDocs().size` unchanged. Without F, the open succeeds.
  - Twin: a missing absolute path → `FILE_NOT_FOUND`.
- **G:** open a doc, then call status with `documentId: "nope"` → the warning contains `nope`.

### `tests/server/mcp-wire-codes-mocked.test.ts` (from #1851), C rows

- `saveDocumentToDisk` returning `EACCES` → `PERMISSION_DENIED`; `EBUSY` → `FILE_LOCKED`; `ENOSPC` → `FORMAT_ERROR`.
- `atomicWriteBuffer` rejecting `EACCES` on the E `.docx`, with the backup dir present → `PERMISSION_DENIED`.

### Existing literals to update

- `resolve-annotation.test.ts:107,129,150` → `ANNOTATION_RESOLVED`. These are A's pins.
- `mcp-tool-integration.test.ts:1818` (read-only `appendContent`) → `READ_ONLY`. `:1837` (non-Markdown) stays `FORMAT_ERROR` and serves as the B twin.
- `restore-backup.test.ts:955` (list mode on an upload) → `INVALID_PATH`.

### Mutations

Restore each from a file copy; each must turn a named row red.

- **A:** old code back at `annotations.ts:554`.
- **B:** `FORMAT_ERROR` back in `tandem_edit`.
- **C:** `FILE_LOCKED` back for `EACCES` in save.
- **D:**
  - `FILE_NOT_FOUND` back at `document.ts:534` → the `//server/share` row.
  - `FORMAT_ERROR` back at `docx-apply.ts:505` → the applyChanges upload row.
  - The combined `:617` arm restored → the restore-mode upload row.
- **E:** delete its arm.
- **F:** delete `isAbsolute` → both the code and the size assertion.
- **G:** old warning back.

## Files touched

`src/server/mcp/{annotations,document,docx-apply}.ts`; `src/shared/types.ts`; `docs/mcp-tools.md`; `skills/tandem/SKILL.md`; `tests/server/{mcp-wire-codes,mcp-wire-codes-mocked,resolve-annotation,mcp-tool-integration,restore-backup}.test.ts`; `tests/skill-instruction-contract.test.ts`.

## Done when

- Rows 3–6 and 11 are fixed and pinned, and every mutation was seen red.
- `typecheck`, `typecheck:tests` and the touched suites pass.
- The PR body carries the audit table, the rename list and `Refs #1823`.
- CI: Node-only. The ubuntu `check` leg runs everything, and the local Windows run is the only Windows evidence.

## Not in scope

#1823's server-runtime and server-data sections; root confinement (#1666); `/api` labels; #2001; #2002; #2003; #2004.

## Review corrections (scope cut)

- **Removed: §H's `offset` return field, the `getSection` `!inSection` guard, and all seven H fixtures.** The issue's complaint is the description's promise, and a description fix closes it, so finding 1 is moot. The re-match bug it found is real (no guard at `document.ts:278`), and is filed as #2003.
- **Removed: the backslash-UNC open row and its platform-split discussion.** Only `//server/share/x.md` remains; it reaches the D arm on both platforms, with the `document.ts:534` mutation. That fixes findings 2, 4 and 5 directly.
- **Kept, trimmed:** the SKILL.md `:189` rewrite plus the `INVALID_PATH` bullet (fixes finding 3), and the restore-mode upload row, its `.html` twin and the `:617` mutation (fix finding 6).
- **Removed: the `VERIFY_BLOCKED` arm.** It is not one of #1823's conditions; filed as #2004.
- **Removed: the `tandem_rename` errno arms and rows.** Rename errnos arrive as `RENAME_FAILED` with `details.errorCode`, via #1851.
- **Removed, because each pinned behaviour this PR does not change or was already pinned:** `openFromDisk` errno rows; `EPERM` rows; the dismissed-note privacy twin; new A table rows (the updated `resolve-annotation` literals pin A); the `.txt` twins (`:1837` already is one).
- Dropped the round-1 corrections log.

## Review corrections (post-cut)

- **§F's docs list gains `docs/mcp-tools.md:115`.** The `filePath` row there says in bold that an absolute path is "**not enforced**" and cites `open.ts:678`; §F makes it enforced. The row is rewritten to say a relative path is refused with `INVALID_PATH`, keeps the #1666 no-confinement sentence, and drops the stale citation. `:140` still carries both the §D and §F changes.
