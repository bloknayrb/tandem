# K-server — #1851 Nothing reads `ToolErrorCodeSchema`; use it to type `mcpError`'s code

Branch `fix/server-lows-mcp-surface-one-wire-code-per-condition-honest-offsets-and-messages-and-the-unused-error-code-schema-1851`. **Closes #1851.** First commit of the K-server group; `K-server-1823.md` lands on top of it.

## Problem (measured on `c830e1aa`)

- `ToolErrorCodeSchema` (`src/shared/types.ts:58-70`) lists 11 codes. Its only reader is `ToolError.code` in the same file. `ToolError`/`ToolResponse` appear only as return-type casts in E2E helpers.
- `mcpError(code: string, …)` (`src/server/mcp/response.ts:77-80`) never consults it.
- The literal codes passed to `mcpError` in `src/server` number about 35, so the schema is far behind. Count single-line `mcpError("X"` and multi-line calls whose code is on the next line.
- One call site passes an open string: `tandem_rename` (`src/server/mcp/document.ts:1574`) sends `result.errorCode ?? "RENAME_FAILED"`. `RenameResult.errorCode` carries a raw errno from `renameDocument`'s catches, so `EXDEV`, `EACCES` or `UNKNOWN` can reach the wire as an MCP code. `docs/mcp-tools.md:530` lists none of those.

## Fix — the issue's option 1, wire it in

- **`src/shared/types.ts`.**
  - Complete `ToolErrorCodeSchema`, sorted, to every literal passed to `mcpError`.
  - Add `renameDocument`'s semantic codes that are still missing: `NOT_RENAMABLE`, `EXTENSION_MISMATCH`, `ALREADY_EXISTS`, `RENAME_IN_PROGRESS`, `PATH_REJECTED`, `RENAME_FAILED`. Enumerate them from `document-service.ts` and `file-io/filename-safety.ts` at implementation time.
  - Export `type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>` and use it for `ToolError.code`.
  - `ANNOTATION_NOT_PENDING` stays in this commit. The #1823 commit removes it together with its last producer.
- **`src/server/mcp/response.ts`.** `mcpError(code: ToolErrorCode, message, details?)`, with a type-only import.
- **`tandem_rename` (`document.ts:1574`): narrow, never cast.** If `ToolErrorCodeSchema.safeParse(result.errorCode)` succeeds, emit `parsed.data`. Otherwise emit `mcpError("RENAME_FAILED", reason, { errorCode: result.errorCode })`, the same `details.errorCode` shape `tandem_save` uses. This is the schema's first runtime reader, which is why it stays a zod enum.
- **No `as ToolErrorCode` anywhere.** If `npm run typecheck` shows another non-literal site, narrow it the same way.
- **Docs.** Add `RENAME_FAILED` to the `tandem_rename` Errors line (`docs/mcp-tools.md:530`). The `RENAME_FAILED` table row already describes it as the catch-all.
- **Runtime change:** only an unlisted rename errno changes, arriving as `RENAME_FAILED` with the errno in `details.errorCode`. No client, channel, monitor or skill code imports the schema.

## Tests

1. **`tests/server/response.test.ts`.**
   - Replace the invalid codes it passes (`"SOME_CODE"`, `"ERR"`) with `"INVALID_ARGUMENT"`.
   - Add `it("types its code as ToolErrorCode")`. It asserts `expectTypeOf(mcpError).parameter(0).toEqualTypeOf<ToolErrorCode>()`, followed by `// @ts-expect-error` above `mcpError("NOT_A_CODE", "x")`. Both are checked by `typecheck:tests`.
2. **`tests/server/mcp-wire-codes-mocked.test.ts`** (new; #1823 §C adds rows).
   - Setup follows `tests/server/convert-error-mapping.test.ts`: `vi.mock` `document-service.js` with an `importOriginal` spread that overrides `renameDocument`.
   - `errorCode: "EXDEV"` must produce code `RENAME_FAILED` with `details.errorCode === "EXDEV"`.
   - `errorCode: "ALREADY_EXISTS"` must produce code `ALREADY_EXISTS`. This kills a blanket `RENAME_FAILED`.

**Mutations** (restore from a file copy):
- Put `code: string` back in `response.ts`: test 1 fails `typecheck:tests`.
- Replace the `safeParse` with a pass-through, using a local `as` so it compiles: the `EXDEV` row goes red.

## Done when

`mcpError` takes `ToolErrorCode`, the schema matches the compiled vocabulary, `tandem_rename` narrows, tests 1–2 pass, both mutations were seen red, and `typecheck` plus `typecheck:tests` are clean. CI: Node-only; ubuntu `check` runs typecheck and vitest.

## Not in scope

- Runtime validation inside `mcpError` (the type is the gate).
- The `/api` rename labels. `routes/rename.ts` sends the raw errno by design, as its docblock says.
- Narrowing `RenameResult.errorCode` to a union. Its errno catches make it an open string.

## Review corrections (scope cut)

- **Removed: the `it.each` over all nine `renameDocument` semantic codes, and the `PATH_REJECTED` schema-removal mutation.** That was a drift guard the issue did not ask for. One pass-through row still kills a blanket `RENAME_FAILED`. Whether the schema lists every rename code is checked when the schema is completed.
- **Removed: adding `VERIFY_BLOCKED` to the schema.** That fix is cut from #1823's spec and filed as #2004.
- Dropped the round-1 corrections log; it described mechanisms that are now gone.
