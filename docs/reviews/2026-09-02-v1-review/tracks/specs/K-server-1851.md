# K-server — #1851 Nothing reads `ToolErrorCodeSchema`; use it to type `mcpError`'s code

Branch `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851`. **Closes #1851.** This is the first commit of the K-server group; `K-server-1823.md` lands on top of it. Ledger row: `docs/plans/2026-09-06-open-issues-sweep.md`, wave 9 "K-server". Probe: a census of the codes `mcpError` is called with in `src/server`. Count the single-line `mcpError("X"` literals, then the multi-line calls whose code is on the following line.

## Problem

`ToolErrorCodeSchema` (`src/shared/types.ts:58-70`, measured on `c830e1aa`) lists 11 codes. Its only reader is `ToolError.code` (`:393`), and `ToolError`/`ToolResponse` are only used as return-type casts in four E2E files: `batch-promote.spec.ts`, `helpers.ts`, `inbox-pull-path.spec.ts` and `slash-command-menu.spec.ts`. `mcpError(code: string, …)` (`src/server/mcp/response.ts:77-79`) never consults it.

The census finds about 35 distinct literal codes. The schema is missing `ACCEPT_REFUSED`, `BACKUP_FAILED`, `BAD_REQUEST`, `CONFLICT`, `DEPRECATED`, `EMPTY_CONVERSION`, `EMPTY_DOCUMENT`, `EXTERNAL_CONFLICT`, `FILE_MODIFIED`, `FILE_TOO_LARGE`, `INTERNAL_ERROR`, `INVALID_NAME`, `INVALID_PATH`, `LICENSE_REQUIRED`, `NOT_OWNED`, `NO_SUGGESTIONS`, `OPEN_FAILED`, `READ_ONLY`, `RELOAD_IN_PROGRESS`, `SEARCH_BUSY`, `SOURCE_MISSING` and `ANNOTATION_NOT_PENDING`.

Only two call sites pass a code that is not a literal:
- `annotations.ts:1039` passes `describeReplyWriteRefusal(result).code`. That is `ReplyRefusalCode` (`annotations/lifecycle.ts:323-327`), a closed subset, so it already fits.
- `document.ts:1574` passes `result.errorCode ?? "RENAME_FAILED"`, where `RenameResult.errorCode` is typed `string`. Its catches (`document-service.ts:1424-1434` and `:1667-1674`) return the **raw errno** (`code ?? "UNKNOWN"`), so `tandem_rename` can send `EACCES`, `EXDEV` or `UNKNOWN` as an MCP error code. `docs/mcp-tools.md:530` lists none of those.

**`renameDocument`'s semantic codes**, measured in `document-service.ts` and `file-io/filename-safety.ts`:
`NOT_FOUND`, `READ_ONLY`, `NOT_RENAMABLE`, `INVALID_NAME` (via `validateRenameFilename`), `EXTENSION_MISMATCH`, `INVALID_PATH` (two sites), `PATH_REJECTED`, `ALREADY_EXISTS` and `RENAME_IN_PROGRESS`.

Four of them (`NOT_FOUND`, `READ_ONLY`, `INVALID_NAME`, `INVALID_PATH`) are in the completed schema only because other tools pass them as literals. Nothing in the type system ties `renameDocument`'s vocabulary to the schema, so the test below does.

## Fix

The issue's option 1, **wire it in**. The emitted vocabulary becomes a compile-time type, so adding a new code forces a schema edit.

- **`src/shared/types.ts`.** Complete `ToolErrorCodeSchema` to the vocabulary that compiles: every literal passed to `mcpError`, plus the `renameDocument` codes not already present (`NOT_RENAMABLE`, `EXTENSION_MISMATCH`, `ALREADY_EXISTS`, `RENAME_IN_PROGRESS`, `PATH_REJECTED`, `RENAME_FAILED`). Keep them sorted. Export `type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>` and use it for `ToolError.code`. `ANNOTATION_NOT_PENDING` stays in this commit; the #1823 commit removes it together with its last producer, and adds `VERIFY_BLOCKED` with its first.
- **`src/server/mcp/response.ts`.** Change the signature to `mcpError(code: ToolErrorCode, message, details?)`, with a type-only import from `../../shared/types.js`.
- **`src/server/mcp/document.ts:1574` (`tandem_rename`): narrow, never cast.**
  - Call `const parsed = ToolErrorCodeSchema.safeParse(result.errorCode)`.
  - On success, emit `parsed.data`.
  - Otherwise emit `mcpError("RENAME_FAILED", reason, { errorCode: result.errorCode })`. That `details.errorCode` shape is `tandem_save`'s (`document.ts:1416-1421`).
  - This is the schema's first runtime reader, which is why it stays a zod enum rather than becoming a bare union.
  - `K-server-1823.md` §C puts the `EACCES`/`EBUSY`/`EPERM` arms in front of this parse.
- **Nowhere uses `as ToolErrorCode`.** A cast is exactly how the schema drifted. If `npm run typecheck` shows another non-literal site, narrow it the same way.
- **Runtime behaviour changes only at the rename site:** an unlisted errno now arrives as `RENAME_FAILED` with the errno in `details`. `docs/mcp-tools.md`'s `RENAME_FAILED` row (`:69`) already describes that code as "carrying no more specific code", so only the `tandem_rename` Errors line (`:530`) gains `RENAME_FAILED`.
- No client, channel, monitor or skill code imports the schema, so no skill bump is needed for this issue.

## Tests

1. **`tests/server/response.test.ts`.**
   - `:43`, `:48` and `:54` pass `"SOME_CODE"` / `"ERR"`, which no longer typecheck. Replace them with a real code (`"INVALID_ARGUMENT"`).
   - Add one `it("types its code as ToolErrorCode", …)`.
     - It asserts `expectTypeOf(mcpError).parameter(0).toEqualTypeOf<ToolErrorCode>()`. That is a positive typecheck pin, and `scan-zero-assert.mjs` recognises it as an assertion.
     - In the same block, put `// @ts-expect-error — not a ToolErrorCode` directly above `mcpError("NOT_A_CODE", "x")`. The call is otherwise well-formed (two string arguments), so the only type error on that line is the code.
   - Both checks live in `typecheck:tests`, not vitest. If `code: string` survives, the `expectTypeOf` fails and the directive goes unused (TS2578).
2. **`tests/server/mcp-wire-codes-mocked.test.ts`** (new; shared with #1823 §C). Copy the setup of `tests/server/convert-error-mapping.test.ts`: `vi.mock("../../src/server/mcp/document-service.js", async (importOriginal) => ({ ...(await importOriginal()), renameDocument }))`, then import `document.js` dynamically.
   - `{status:"error", errorCode:"EXDEV", reason}` must produce `RENAME_FAILED` with `details.errorCode === "EXDEV"`. This kills a cast or pass-through, which would put `EXDEV` on the wire. `UNKNOWN` gets the same row.
   - **An `it.each` over every semantic code `renameDocument` returns** (`NOT_FOUND`, `READ_ONLY`, `NOT_RENAMABLE`, `INVALID_NAME`, `EXTENSION_MISMATCH`, `INVALID_PATH`, `PATH_REJECTED`, `ALREADY_EXISTS`, `RENAME_IN_PROGRESS`). Each must pass through unchanged. This kills a blanket `RENAME_FAILED`, and it catches any of those codes later dropping out of the schema, which would otherwise demote it to `RENAME_FAILED` silently.

**Mutations (named-red, restore from a file copy):**
- Put `code: string` back in `response.ts`: test 1 fails `typecheck:tests` (the `expectTypeOf` mismatch and TS2578).
- Replace the `safeParse` with `result.errorCode ?? "RENAME_FAILED"`: test 2's `EXDEV` row turns red. TypeScript also refuses to compile that line, so do the mutation with a local `as` to watch the runtime test turn red.
- Delete `PATH_REJECTED` from `ToolErrorCodeSchema` (and its only literal use, if one exists): test 2's `PATH_REJECTED` row turns red.

## Done when

`mcpError` takes `ToolErrorCode`. The schema matches the compiled vocabulary. `tandem_rename` narrows its code. Tests 1–2 are green and every mutation was observed. `npm run typecheck` and `typecheck:tests` are clean.

## Not in scope

- Runtime validation inside `mcpError` (the type is the gate).
- A docs-vs-schema sweep test.
- The `/api` label vocabulary in `routes/_shared.ts`. `routes/rename.ts` sends `result.errorCode` raw (EXDEV/EACCES/UNKNOWN) **by design**: its docblock (`:13-19`) says the rename codes deliberately do not flow through `errorCodeToLabel`, and `RENAME_GENERIC_MESSAGE` is the documented fallback. It is that surface's vocabulary, not a deferral, so no issue is filed.
- Narrowing `RenameResult.errorCode` to a union. Its errno catches make it an open string by construction. Closing it would need a separate errno field threaded through `document-service.ts` and `routes/rename.ts`, which is outside this group. The `it.each` above covers the same drift at runtime.

## Review corrections (round 1)

**Adopted:**
1. **Rename code set:** `renameDocument`'s nine semantic codes are enumerated, and test 2 is an `it.each` over all of them, with a `PATH_REJECTED` schema-removal mutation.
2. **Test 1:** `@ts-expect-error` now sits inside an `it` that also asserts `expectTypeOf(mcpError).parameter(0).toEqualTypeOf<ToolErrorCode>()`, so the block is not zero-assert and the line has only one type error.
3. **`routes/rename.ts` raw errno:** the bullet now says it is the `/api` vocabulary by design (docblock `:13-19`), not an unfiled deferral.
4. **`ToolResponse` casts:** corrected to four E2E files, named.

**Not adopted:**
- Narrowing `RenameResult.errorCode` to a union (offered as an alternative). The errno catches (`document-service.ts:1424-1434`, `:1667-1674`) make it an open string by construction. The `it.each` catches the same drift without reshaping `renameDocument`'s return type and its `/api` consumer.
