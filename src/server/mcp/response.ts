/**
 * Shared MCP tool response helpers.
 * Eliminates the 3-line wrapper pattern repeated ~40 times across tool files.
 */

import type { ToolErrorCode } from "../../shared/types.js";
import { getSubscriberCount } from "../events/queue.js";
import { takeWakeAdvisory } from "./wake-advisory.js";

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  /** MCP structured content — present on tools that declare an outputSchema. */
  structuredContent?: Record<string, unknown>;
  /** MCP-level error marker. Set for error envelopes returned by tools that
   *  declare an outputSchema (the SDK skips output validation for isError
   *  results, so error envelopes don't need structuredContent). */
  isError?: boolean;
};

/** Wrap a successful response in the MCP content envelope */
export function mcpSuccess<T>(data: T): McpToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: false, data }) }],
  };
}

/**
 * Like `mcpSuccess`, but additionally exposes `data` as MCP `structuredContent`
 * for tools that declare an `outputSchema` (typed non-Claude clients validate
 * responses against it). The text envelope is unchanged — `structuredContent`
 * is additive, and both carry the exact same payload.
 */
export function mcpStructured<T extends Record<string, unknown>>(data: T): McpToolResult {
  return {
    ...mcpSuccess(data),
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * Wrap a handler for a tool that declares an `outputSchema`. Any result
 * lacking `structuredContent` (i.e. an `mcpError` envelope, including the
 * `withErrorBoundary` INTERNAL_ERROR fallback) is marked `isError: true` so
 * the SDK's output validation — which requires structuredContent on every
 * non-error result — skips it. The text envelope still carries the
 * `{ error: true, code, message }` JSON that existing clients parse.
 */
export function withStructuredErrors<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<McpToolResult>,
): (args: TArgs) => Promise<McpToolResult> {
  return async (args: TArgs) => {
    const result = await handler(args);
    if (result.structuredContent === undefined) return { ...result, isError: true };
    return result;
  };
}

/**
 * Every envelope `mcpError` has ever produced.
 *
 * A WeakSet rather than a flag on the object: the marker must not be visible to
 * the SDK, to a client, or to `JSON.stringify`. It exists so `withErrorBoundary`
 * can refuse to decorate an error — `LICENSE_REQUIRED` and its siblings are
 * written FOR Claude as their reader, and appending an unrelated advisory to one
 * changes what that message is asking the model to do.
 *
 * `isError` is not a usable substitute: `withStructuredErrors` sets it, but it
 * wraps OUTSIDE `withErrorBoundary`, so at decoration time it is not there yet.
 */
const errorEnvelopes = new WeakSet<McpToolResult>();

/** Is this envelope one `mcpError` built? */
export function isErrorEnvelope(result: McpToolResult): boolean {
  return errorEnvelopes.has(result);
}

/**
 * Wrap an error response in the MCP content envelope. `code` is the typed wire
 * vocabulary (#1851): a code not in `ToolErrorCodeSchema` does not compile, and
 * a non-literal string must be narrowed with `ToolErrorCodeSchema.safeParse`,
 * never cast.
 */
export function mcpError(
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): McpToolResult {
  const result: McpToolResult = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: true, code, message, ...(details && { details }) }),
      },
    ],
  };
  errorEnvelopes.add(result);
  return result;
}

/**
 * The wire code for a lock-or-permission errno, or null for any other (#1823).
 * `tandem_open`, `tandem_save` and `tandem_applyChanges` all answer through it.
 *
 * POSIX reports a permission refusal as `EACCES`. Windows does not: libuv maps
 * `ERROR_ACCESS_DENIED` to `EPERM` and `ERROR_SHARING_VIOLATION` to `EBUSY`, so
 * `EPERM` alone is ambiguous there and the failing syscall is what separates
 * it. Measured on Windows 11 (26200), Node 24, unprivileged:
 *
 * - a directory the caller can read but not write: `EPERM` on `open` (the
 *   atomic write's temp sibling);
 * - a file whose read is denied: `EPERM` on `open`;
 * - a file another program holds open: `EPERM` on the `rename` over it, and
 *   `EBUSY` on a direct `open`;
 * - a file with the read-only attribute: `EPERM` on the `rename` too.
 *
 * So `EPERM` on `open` is always a refusal, never a lock, and answers
 * `PERMISSION_DENIED`. `EPERM` on `rename` is a lock OR a read-only file, and
 * keeps `FILE_LOCKED`. So does an `EPERM` with no syscall, which was the answer
 * before this split.
 */
export function lockOrPermissionCode(err: {
  code?: string;
  syscall?: string;
}): "FILE_LOCKED" | "PERMISSION_DENIED" | null {
  if (err.code === "EACCES") return "PERMISSION_DENIED";
  if (err.code === "EPERM") return err.syscall === "open" ? "PERMISSION_DENIED" : "FILE_LOCKED";
  if (err.code === "EBUSY") return "FILE_LOCKED";
  return null;
}

/** Standard NO_DOCUMENT error — returned when a tool requires an open document */
export function noDocumentError(): McpToolResult {
  return mcpError("NO_DOCUMENT", "No document is open. Call tandem_open first.");
}

/** Extract a human-readable message from an unknown error */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wrap an MCP tool handler with a try/catch that returns a structured error.
 *  Catches unexpected throws so Claude gets a useful error message instead of
 *  a generic SDK-level JSON-RPC error. */
export function withErrorBoundary<TArgs extends Record<string, unknown>>(
  toolName: string,
  handler: (args: TArgs) => Promise<McpToolResult>,
): (args: TArgs) => Promise<McpToolResult> {
  return async (args: TArgs) => {
    try {
      return withWakeAdvisory(await handler(args));
    } catch (err) {
      console.error(`[Tandem] Tool ${toolName} threw:`, err);
      // Not decorated: `mcpError` tags it, and an error envelope is written for
      // Claude as its reader.
      return mcpError("INTERNAL_ERROR", `${toolName} failed: ${getErrorMessage(err)}`);
    }
  };
}

/**
 * Append the wake advisory as a TRAILING text block, when one is owed.
 *
 * Trailing is load-bearing in two directions:
 *
 *  - Four helper call sites index `content[0].text` to parse the envelope, so a
 *    LEADING block would break all of them.
 *  - `structuredContent` is the same object as the envelope's `data`, and seven
 *    tools publish schemas the SDK emits with `additionalProperties: false`.
 *    Putting the advisory there would make a spec-compliant client reject the
 *    call via Ajv. Touching only `content` keeps `structuredContent ≡ data`.
 *
 * The result object is REPLACED rather than mutated, so a caller holding the
 * original (and the WeakSet keyed on it) sees no change.
 */
function withWakeAdvisory(result: McpToolResult): McpToolResult {
  if (isErrorEnvelope(result)) return result;
  const advisory = takeWakeAdvisory(getSubscriberCount());
  if (advisory === null) return result;
  return { ...result, content: [...result.content, { type: "text" as const, text: advisory }] };
}

/** Escape a string for use as a literal in a RegExp */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
