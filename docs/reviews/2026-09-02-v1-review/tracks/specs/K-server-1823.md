# K-server — #1823 MCP surface: one wire code per condition, honest offsets and messages

Branch `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851`. **Refs #1823 only; the issue stays open.** Its server-runtime section is a later K-server PR, and its server-data bullets went to D1 (#1924). This spec lands after `K-server-1851.md`. Ledger rows: `areas/server-mcp.md:26`, `areas/crdt.md:23`, `areas/skill-plugin.md:27`. Probes: `experiments/probe-tools.mts` cases H7 and H62, and `crdt-verify.ts` §F. §F is now unreachable because the script crashes at §C, where #1848 refuses the zero-length range it builds, so it was re-measured inline on `c830e1aa`.

## Problem — every MCP-surface bullet, audited on `c830e1aa`

| # | Bullet | Status | Evidence |
|---|---|---|---|
| 1 | `tandem_comment` accepts a range past end | fixed-already | #1848 (`ffef634e`) |
| 2 | `tandem_getContext` accepts inverted/negative ranges | fixed-already | #1848 |
| 3 | `getTextContent({section})` returns no base offset | **fixed-here §H** | H62: `{"text":"## Costs\nCost body text","section":"Costs"}` |
| 4 | Several wire codes for one condition | **fixed-here §A–E** | below |
| 5 | `tandem_open` accepts a relative path | **fixed-here §F** | `documents/open.ts:688` calls `path.resolve` with no `isAbsolute` check |
| 6 | `tandem_status` with an unknown `documentId` says "No document open" | **fixed-here §G** | H7: the warning is "No document open" while `h7` is open |
| 7 | Read-only refusals say "(.docx)" | fixed-already | #1858 (#1798, `449adf58`): `readOnlyToolMessage` (`document.ts:99`); pinned by `html-read-only.test.ts` (`not.toContain(".docx")`) |
| 8 | Fractional `from`/`to` accepted | fixed-already | #1848 (`.int()` on the three live tools) |
| 9 | Refresh `kind` discarded | fixed-already | #1916 (`7989261d`): `annotations.ts:488` emits `anchor: "degraded" \| "failed"`. `updated` and `repaired` are success verdicts, and `output-schemas.ts` declares only the two degradation verdicts on purpose. Nothing left to do. |
| 10 | Zero-length ranges accepted | fixed-already | #1848; pinned in `range-bounds-validation.test.ts` (`reason: "empty"`); `docs/mcp-tools.md:302` |
| 11 | `to` equal to the first character of a heading prefix → `HEADING_OVERLAP`, undocumented | code pinned (`positions.test.ts`, "keeps the exclusive-end asymmetry") and documented in `docs/architecture.md:656` and CLAUDE.md; **`docs/mcp-tools.md` is silent → fixed-here §I** | |
| 12 | `flatOffsetToRelPos` ±1 hardBreak drift | **reproduced, left → #2001** | no-edit refresh: `{8,12}`→`{9,12}` (`updated`); list `{3,7}`→`{4,7}`. Changing the anchoring contract needs its own `crdt-reviewer` pass. |
| 13 | `OutlinePanel.svelte` uses stale `range.from` | **left → #2002** | `src/client/components/OutlinePanel.svelte:159`. A client change, and this group runs no E2E. |

## Fix

Rule for every wire code: converge on the code that `routes/_shared.ts#errorCodeToLabel` and the `docs/mcp-tools.md` table already give the condition. **Every rename below is client-visible.** Consumers were grepped in `skills/tandem/SKILL.md`, `src/client`, `src/channel`, `src/monitor` and `tests/e2e`. The only hit is SKILL.md's promise of `FORMAT_ERROR` for read-only (§B). The PR body names each rename as a change to a documented contract.

- **A. Not pending → `ANNOTATION_RESOLVED`.** In `annotations.ts:552-556` (`tandem_resolveAnnotation`, `not-pending` arm), switch the code; the message is unchanged. `editAnnotation` (`:676-680`), `describeReplyWriteRefusal` (`lifecycle.ts:362-366`) and `/api` (`_shared.ts:234`) already emit `ANNOTATION_RESOLVED`. Drop `ANNOTATION_NOT_PENDING` from `ToolErrorCodeSchema`; that removal is compile-checked. In `docs/mcp-tools.md`, merge rows `:72-73` into one.
- **B. Read-only → `READ_ONLY`** for `tandem_edit` (`document.ts:694-699`), `tandem_editList` (`:1094-1095`) and `tandem_appendContent` (`:1233-1237`). Messages stay as they are. Their real format refusals stay `FORMAT_ERROR`, and that is what makes the two conditions distinguishable. `applyChanges`, `restoreBackup`, `rename`, `/api` and the client's `saveSkippedMessage` already use `READ_ONLY`. Docs: rows `:47` and `:59`, plus `:293`, `:342`, `:380`. `skills/tandem/SKILL.md` `:29` and `:189` move `FORMAT_ERROR` to `READ_ONLY`: add a `READ_ONLY` bullet and keep `FORMAT_ERROR` for format refusals. **Bump `version:` to the next integer after `origin/master` at rebase (22 → 23 today), and update the literal in `tests/skill-instruction-contract.test.ts:113` in the same commit.**
- **C. Errnos → the `/api` mapping.** `EACCES` → `PERMISSION_DENIED`; `EBUSY`/`EPERM` → `FILE_LOCKED`.
  - `tandem_save` (`document.ts:1415-1421`): `EACCES` currently answers `FILE_LOCKED` and `EBUSY` falls through to `FORMAT_ERROR`. Keep `details.errorCode` and keep the `FORMAT_ERROR` fallback for everything else.
  - `tandem_applyChanges` (`docx-apply.ts:525-526`): split `EACCES` out.
  - `tandem_rename` (`document.ts:1574`): add the three errno arms before #1851's `safeParse`.
  - `tandem_open` (`:539-546`) already matches. `convert.ts`'s throw-site `PERMISSION_DENIED` classification stays as it is.
  - Docs `:57`, `:440`, `:885`. While editing `:440`, check whether `VERIFY_BLOCKED` really reaches `tandem_save` as a top-level code. `document.ts` contains no such literal, so it may only appear as `details.errorCode` under `FORMAT_ERROR`. Write down what driving it shows; do not assume either way.
- **D. Rejected or unusable path → `INVALID_PATH`.**
  - `tandem_open`: the `INVALID_PATH` arm (`document.ts:533-534`) currently emits `FILE_NOT_FOUND`.
  - `tandem_applyChanges`: `docx-apply.ts:505` currently emits `FORMAT_ERROR`. That covers a UNC `backupPath` and the upload-source refusal at `:159-163`, which then matches `convert`'s upload → `INVALID_PATH` (A8).
  - `tandem_restoreBackup`: split `:617-619` so `INVALID_PATH` → `INVALID_PATH` while `UNSUPPORTED_FORMAT` stays `FORMAT_ERROR`. Change the list-mode upload refusal at `:567-571` to `INVALID_PATH`, so list mode and restore agree on the same condition.
  - Do not touch `documents/reload-family.ts` (PR #2000 owns it); only handlers change. Docs `:45`, `:140`, `:885`, `:893-894`, `:931`.
- **E. `applyChanges` with a missing backup directory → `FILE_NOT_FOUND`.** The core already throws it (`docx-apply.ts:348-352`), but the handler has no arm, so it rethrows and becomes `INTERNAL_ERROR`. Add `if (e.code === "FILE_NOT_FOUND") return mcpError("FILE_NOT_FOUND", e.message)`. This matches `convert` and `exportAnnotations`. Docs `:885`.
- **F. `tandem_open` refuses a relative path.** In the handler, before `openFromDisk`, add `if (!path.isAbsolute(filePath)) return mcpError("INVALID_PATH", "filePath must be an absolute path.")`. It is a pure string check with no filesystem call. **This is not containment and does not decide #1666.** `resolveAndValidatePath` is left alone, so `POST /api/open`, session restore and startup opens are unchanged. Their callers already send absolute paths: the Tauri `validate_open_candidate` asserts `is_absolute` (`open_candidate.rs`), and the client's `openServerPath` sends server-emitted paths. A grep of `tandem_open` `filePath` arguments in `tests/server` and `tests/e2e` showed 191 `path.join(tmpDir, …)` and a handful of variables, none of them visibly relative. That grep was a sample, so the full suite run is what confirms it. On POSIX, `\\server\share` counts as relative, so it still answers `INVALID_PATH`: same code, different message. Docs `:140`.
- **G. `tandem_status` write with an unknown id.** At `document.ts:1455-1459`, when `documentId` is truthy, the warning becomes `` `Document ${documentId} is not open — status not broadcast to editor.` `` (the precedent is `convert`'s "Document X is not open."). The no-id case is unchanged and stays pinned by `mcp-output-schemas.test.ts:279`.
- **H. The section read returns `offset`.** `getSection` (`document.ts:255`) also returns the top-level `index` of the heading it matched. The handler takes the `collectBlocks(r.doc)` heading block whose `path` is `[index]` and computes `offset = block.from - headingPrefix(level).length` (a top-level heading block's `from` is past its prefix, `document-model.ts:440`). Return `{ text, filePath, section, offset }`. Add `offset: z.number().int().optional()` to `getTextContentOutputShape` (`output-schemas.ts:186-191`); the SDK rejects an undeclared field. In the description (`document.ts:581-587`), say that a section read's offsets are relative to `offset`. Update the docs return block and notes (`:190-229`). **Critical Rule 5:** `extractText` only.
- **I. Heading asymmetry in docs.** Extend `docs/mcp-tools.md:95` with one sentence: `to` equal to the first character of a heading prefix is refused even though `to` is exclusive. Example: on `"para\n## Head\nnext"`, `[0,5)` is refused and `[0,4)` is accepted. No code change.

## Tests

`tests/server/mcp-wire-codes.test.ts` (new) drives the real tools through an in-memory client (the `setupMcpClient` shape from `mcp-tool-integration.test.ts`, plus `registerApplyTools`). It is one `it.each` table, and each row asserts `code` exactly.
- **A:** all three tools on a dismissed annotation → `ANNOTATION_RESOLVED`. Kills a fix that leaves `resolve` on the old code.
- **B:** the three mutators on `readOnly` → `READ_ONLY`. **Twins:** `appendContent` on a writable `.txt` and `editList` on a writable `.txt` → `FORMAT_ERROR`, which kills a blanket `FORMAT_ERROR`→`READ_ONLY`.
- **D/F:**
  - `tandem_open` on `\\\\server\\share\\x.md` → `INVALID_PATH`.
  - `tandem_open` on `"relative/x.md"` → `INVALID_PATH`; the message mentions "absolute" and `getOpenDocs().size` does not change.
  - **Twin:** a missing absolute path → `FILE_NOT_FOUND`, which kills folding ENOENT into `INVALID_PATH`.
  - `applyChanges`: UNC `backupPath` → `INVALID_PATH`; upload source → `INVALID_PATH`; `readOnly` → `READ_ONLY`; a `.md` → `FORMAT_ERROR` (twin).
  - `restoreBackup` list mode on an upload → `INVALID_PATH`.
- **E:** a real `.docx` with one accepted suggestion (lift the fixture from `docx-apply.test.ts`'s "write guards" describe) and `backupPath` in a missing directory → `FILE_NOT_FOUND`, **not** `INTERNAL_ERROR`.
- **G:** doc `a` open, status with `documentId: "nope"` → the warning contains `nope` and not "No document open".
- **H:** for three fixtures (a second section after content, a section holding a list, a document opening with a heading), `extractText(doc).slice(offset, offset + text.length) === text`. This kills `offset = block.from` (off by the prefix length) and any count that skips separators.

`tests/server/mcp-wire-codes-mocked.test.ts` (created by #1851) covers the errno rows (C), using the `convert-error-mapping.test.ts` pattern with `importOriginal` spreads.
- `openFromDisk` rejecting `EACCES`/`EBUSY`/`EPERM`: this pins what already matches.
- `saveDocumentToDisk` returning `EACCES` → `PERMISSION_DENIED`, `EBUSY`/`EPERM` → `FILE_LOCKED`, and `ENOSPC` → `FORMAT_ERROR`. The `ENOSPC` row is an over-fold negative.
- `renameDocument` with `EACCES` → `PERMISSION_DENIED`.
- `file-io/index.js#atomicWriteBuffer` rejecting `EACCES` under the E fixture → `PERMISSION_DENIED`, and rejecting `EPERM` → `FILE_LOCKED`.

Existing literals to update: `resolve-annotation.test.ts:107,129,150`; the read-only `appendContent` case in `mcp-tool-integration.test.ts` (~`:1818`); `restore-backup.test.ts:955`; `skill-instruction-contract.test.ts:113`.

**Mutations (restore from a file copy):**
- A: put the old code back at `annotations.ts:554` → the A row goes red.
- B: put `FORMAT_ERROR` back in `tandem_edit` → B goes red.
- C: put `FILE_LOCKED` back for `EACCES` in save → C goes red.
- D: put `FORMAT_ERROR` back at `docx-apply.ts:505` → D goes red.
- E: delete the new arm → E goes red.
- F: delete `isAbsolute` → F goes red.
- G: put the old warning back → G goes red.
- H: drop `- prefixLen` → H goes red.

## Done when

Rows 3–6 and 11 are fixed and pinned, 12 and 13 point at #2001/#2002, and every mutation has been seen red. `typecheck`, `typecheck:tests` and the touched suites pass. The PR body carries this audit table and the list of renames, and says `Refs #1823`. **CI:** everything here is Node-only. Ubuntu `check` runs the vitest and typecheck legs, and a local Windows run is the only Windows evidence. POSIX `path.isAbsolute` semantics are exercised by CI, not locally.

## Not in scope

#1823's server-runtime and server-data sections; root confinement (#1666); the `/api` labels; #2001; #2002.
