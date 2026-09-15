# K-server — #1851 Nothing reads `ToolErrorCodeSchema`; use it to type `mcpError`'s code

Branch `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851`. **Closes #1851.** This is the first commit of the K-server group; `K-server-1823.md` lands on top of it. Ledger row: `docs/plans/2026-09-06-open-issues-sweep.md`, wave 9 "K-server". Probe: a census of the codes `mcpError` is called with in `src/server`. Count the single-line `mcpError("X"` literals, then the multi-line calls whose code is on the following line.

## Problem

`ToolErrorCodeSchema` (`src/shared/types.ts:58-70`, measured on `c830e1aa`) lists 11 codes. Its only reader is `ToolError.code` (`:393`), and `ToolError`/`ToolResponse` are only used as return-type casts in three E2E files. `mcpError(code: string, …)` (`src/server/mcp/response.ts:77-79`) never consults it. The census finds about 35 distinct literal codes. The schema is missing `ACCEPT_REFUSED`, `BACKUP_FAILED`, `BAD_REQUEST`, `CONFLICT`, `DEPRECATED`, `EMPTY_CONVERSION`, `EMPTY_DOCUMENT`, `EXTERNAL_CONFLICT`, `FILE_MODIFIED`, `FILE_TOO_LARGE`, `INTERNAL_ERROR`, `INVALID_NAME`, `INVALID_PATH`, `LICENSE_REQUIRED`, `NOT_OWNED`, `NO_SUGGESTIONS`, `OPEN_FAILED`, `READ_ONLY`, `RELOAD_IN_PROGRESS`, `SEARCH_BUSY`, `SOURCE_MISSING` and `ANNOTATION_NOT_PENDING`.

Only two call sites pass a code that is not a literal:
- `annotations.ts:1039` passes `describeReplyWriteRefusal(result).code`. That is `ReplyRefusalCode` (`annotations/lifecycle.ts:323-327`), a closed subset, so it already fits.
- `document.ts:1574` passes `result.errorCode ?? "RENAME_FAILED"`, where `RenameResult.errorCode` is typed `string`. Its outer catch (`document-service.ts:1424-1434`) returns the **raw errno** (`code ?? "UNKNOWN"`), so `tandem_rename` can send `EACCES`, `EXDEV` or `UNKNOWN` as an MCP error code. `docs/mcp-tools.md:530` lists none of those.

## Fix

The issue's option 1, **wire it in**. The emitted vocabulary becomes a compile-time type, so adding a new code forces a schema edit.

- `src/shared/types.ts`: complete `ToolErrorCodeSchema` to the vocabulary that compiles. That is every literal passed to `mcpError`, plus the semantic codes `renameDocument` returns: `NOT_RENAMABLE`, `EXTENSION_MISMATCH`, `ALREADY_EXISTS`, `RENAME_IN_PROGRESS`, `PATH_REJECTED`, `RENAME_FAILED`. Keep them sorted. Export `type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>` and use it for `ToolError.code`. `ANNOTATION_NOT_PENDING` stays in this commit; the #1823 commit removes it together with its last producer.
- `src/server/mcp/response.ts`: change the signature to `mcpError(code: ToolErrorCode, message, details?)`, with a type-only import from `../../shared/types.js`.
- `src/server/mcp/document.ts:1574` (`tandem_rename`): **narrow, never cast.** `const parsed = ToolErrorCodeSchema.safeParse(result.errorCode)`. On success, emit `parsed.data`. Otherwise emit `mcpError("RENAME_FAILED", reason, { errorCode: result.errorCode })`. That `details.errorCode` shape is `tandem_save`'s (`document.ts:1416-1421`). This is the schema's first runtime reader, which is why it stays a zod enum rather than becoming a bare union. `K-server-1823.md` §C puts the `EACCES`/`EBUSY`/`EPERM` arms in front of this parse.
- **Nowhere uses `as ToolErrorCode`.** A cast is exactly how the schema drifted. If `npm run typecheck` shows another non-literal site, narrow it the same way.
- Runtime behaviour does not change except at the rename site: an unlisted errno now arrives as `RENAME_FAILED` with the errno in `details`. `docs/mcp-tools.md`'s `RENAME_FAILED` row (`:69`) already describes that code as "carrying no more specific code", so only the `tandem_rename` Errors line (`:530`) gains `RENAME_FAILED`.
- No client, channel, monitor or skill code imports the schema, so no skill bump is needed for this issue.

## Tests

1. `tests/server/response.test.ts`: `:43`, `:48` and `:54` pass `"SOME_CODE"` / `"ERR"`, which no longer typecheck. Replace them with real codes (`"INVALID_ARGUMENT"`). Add `// @ts-expect-error — not a ToolErrorCode` above `mcpError("NOT_A_CODE", "x")`. This check lives in `typecheck:tests`, not vitest. If `code: string` survives, the directive goes unused and fails with TS2578.
2. `tests/server/mcp-wire-codes-mocked.test.ts` (new; shared with #1823 §C). Copy the setup of `tests/server/convert-error-mapping.test.ts`: `vi.mock("../../src/server/mcp/document-service.js", async (importOriginal) => ({ ...(await importOriginal()), renameDocument }))`, then import `document.js` dynamically.
   - `{status:"error", errorCode:"EXDEV", reason}` must produce `RENAME_FAILED` with `details.errorCode === "EXDEV"`. This kills a cast or pass-through, which would put `EXDEV` on the wire.
   - `errorCode:"ALREADY_EXISTS"` must produce `ALREADY_EXISTS`. This kills a blanket `RENAME_FAILED`, which would lose the semantic code.

**Mutations (named-red, restore from a file copy):**
- Put `code: string` back in `response.ts`: test 1 fails `typecheck:tests` with TS2578.
- Replace the `safeParse` with `result.errorCode ?? "RENAME_FAILED"`: test 2's `EXDEV` row turns red. (TypeScript also refuses to compile that line, so do the mutation with a local `as` to watch the runtime test turn red.)

## Done when

`mcpError` takes `ToolErrorCode`. The schema matches the compiled vocabulary. `tandem_rename` narrows its code. Tests 1–2 are green and both mutations were observed. `npm run typecheck` and `typecheck:tests` are clean.

## Not in scope

- Runtime validation inside `mcpError` (the type is the gate).
- A docs-vs-schema sweep test.
- The `/api` label vocabulary in `routes/_shared.ts`.
- `routes/rename.ts`'s raw `errorCode` on the HTTP surface.
