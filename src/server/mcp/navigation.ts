import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FlatOffset } from "../../shared/positions/types.js";
import { toFlatOffset } from "../../shared/positions/types.js";
import { getDocumentStore } from "./document-store.js";
import { searchOutputShape } from "./output-schemas.js";
import {
  escapeRegex,
  getErrorMessage,
  mcpError,
  mcpStructured,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
  withStructuredErrors,
} from "./response.js";
import { searchRegexInWorker } from "./search-worker.js";

export interface SearchMatch {
  from: FlatOffset;
  to: FlatOffset;
  text: string;
}

/**
 * Search for LITERAL text in a document. Pure logic extracted for testability.
 *
 * Literal-only by design (#1795). The `useRegex` branch used to live here and
 * compiled the caller's pattern on the main thread, where a catastrophic
 * backtrack froze the whole server — the old 2 s guard ran only BETWEEN
 * matches, so a single pathological `exec` never reached it. Regex search now
 * goes to `searchRegexInWorker`. Keeping the branch here as an exported,
 * unguarded `new RegExp(query)` would leave a loaded gun for the next caller,
 * so the parameter is gone rather than merely unused.
 *
 * `escapeRegex` makes the compiled pattern a plain literal, which can neither
 * backtrack catastrophically nor throw — hence no try/catch and no time guard.
 * `error` stays in the RETURN TYPE (permanently `undefined` on this path) so
 * callers can treat both search paths uniformly.
 */
export function searchText(
  fullText: string,
  query: string,
): { matches: SearchMatch[]; truncated?: "cap" | "timeout"; error?: string } {
  const MAX_MATCHES = 10_000;
  const matches: SearchMatch[] = [];
  const pattern = new RegExp(escapeRegex(query), "gi");
  let match;
  while ((match = pattern.exec(fullText)) !== null) {
    matches.push({
      from: toFlatOffset(match.index),
      to: toFlatOffset(match.index + match[0].length),
      text: match[0],
    });
    if (matches.length >= MAX_MATCHES) return { matches, truncated: "cap" };
    // Prevent infinite loops on zero-length matches
    if (match[0].length === 0) pattern.lastIndex++;
  }
  return { matches };
}

/** Find the nth occurrence of a pattern. Pure logic extracted for testability. */
export function findOccurrence(
  fullText: string,
  pattern: string,
  occurrence: number = 1,
): { from: FlatOffset; to: FlatOffset; text: string } | { error: string; totalCount: number } {
  // An empty pattern compiles to a zero-length-match regex whose `lastIndex`
  // never advances, so `regex.exec` returns forever. With an integer
  // `occurrence` the count still terminates (and yields a degenerate {0,0}
  // span); with a NON-integer `occurrence` (`count` is always integer) it would
  // loop infinitely — a synchronous, un-abortable hang for any caller. Guard it
  // at the boundary so every caller (local-model resolveAnchor AND the
  // tandem_resolveRange MCP route) is safe, matching countOccurrences("")===0.
  if (pattern === "") return { error: 'Text "" not found (empty pattern)', totalCount: 0 };
  const regex = new RegExp(escapeRegex(pattern), "g");
  let match;
  let count = 0;
  while ((match = regex.exec(fullText)) !== null) {
    count++;
    if (count === occurrence) {
      return {
        from: toFlatOffset(match.index),
        to: toFlatOffset(match.index + match[0].length),
        text: match[0],
      };
    }
  }
  return {
    error: `Text "${pattern}" not found (occurrence ${occurrence}, found ${count} total)`,
    totalCount: count,
  };
}

/**
 * Count how many times `pattern` occurs in `fullText`, using the SAME literal
 * (regex-escaped) matching as `findOccurrence` so the count and a subsequent
 * resolve can never disagree. `findOccurrence` only exposes the total on its
 * miss path; callers that need the count on a HIT (e.g. the local-model
 * occurrence-clamp, #1123) use this instead.
 */
export function countOccurrences(fullText: string, pattern: string): number {
  if (pattern === "") return 0;
  const regex = new RegExp(escapeRegex(pattern), "g");
  let count = 0;
  while (regex.exec(fullText) !== null) count++;
  return count;
}

/** Extract context window around a range. Pure logic extracted for testability. */
export function extractContext(
  fullText: string,
  from: FlatOffset,
  to: FlatOffset,
  windowSize: number = 500,
) {
  const contextStart = toFlatOffset(Math.max(0, from - windowSize));
  const contextEnd = toFlatOffset(Math.min(fullText.length, to + windowSize));
  return {
    context: fullText.slice(contextStart, contextEnd),
    selection: fullText.slice(from, to),
    contextRange: { from: contextStart, to: contextEnd },
    selectionRange: { from, to },
  };
}

export function registerNavigationTools(server: McpServer): void {
  server.registerTool(
    "tandem_search",
    {
      description: "Search for text in the document. Returns matching positions.",
      inputSchema: {
        query: z.string().describe("Text to find (literal unless `regex: true`)"),
        regex: z.boolean().default(false).describe("Treat query as regex"),
        documentId: z
          .string()
          .optional()
          .describe("Target document ID (defaults to active document)"),
      },
      outputSchema: searchOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_search", async ({ query, regex, documentId }) => {
        const store = getDocumentStore(documentId);
        if (!store) return noDocumentError();

        const fullText = store.getText();
        let result: { matches: SearchMatch[]; truncated?: "cap" | "timeout"; error?: string };
        if (regex) {
          // The worker rejects with a tagged Error when its queue is full; a
          // bare rejection would reach `withErrorBoundary` and be flattened to
          // INTERNAL_ERROR, which says nothing the caller can act on.
          try {
            result = await searchRegexInWorker(fullText, query);
          } catch (err) {
            if ((err as { code?: string }).code === "SEARCH_BUSY") {
              return mcpError("SEARCH_BUSY", getErrorMessage(err));
            }
            throw err;
          }
        } else {
          result = searchText(fullText, query);
        }
        if (result.error) return mcpError("FORMAT_ERROR", result.error);
        const truncated = result.truncated;
        // A cap or a timeout is a PARTIAL result, never a FORMAT_ERROR: the
        // matches collected so far are real and are returned. The spread must
        // not emit `truncated: undefined` — `structuredContent` is validated
        // with `additionalProperties: false` at the client (#1564).
        const response = mcpStructured({
          matches: result.matches,
          count: result.matches.length,
          ...(truncated ? { truncated: true, reason: truncated } : {}),
        });
        if (!truncated) return response;
        // Appended as an ADDITIONAL text block, never merged into content[0]
        // (four helpers index it) and never put in `data` (that is
        // `structuredContent` verbatim).
        return {
          ...response,
          content: [
            ...response.content,
            {
              type: "text" as const,
              text: `Results are incomplete (${truncated}). Do not use for replace-all; narrow the pattern.`,
            },
          ],
        };
      }),
    ),
  );

  server.tool(
    "tandem_resolveRange",
    "Find text and return a valid range. Safer than raw character offsets under concurrent editing.",
    {
      pattern: z.string().describe("Text to find"),
      occurrence: z.number().optional().describe("Which occurrence (1-based, default 1)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_resolveRange", async ({ pattern, occurrence = 1, documentId }) => {
      const store = getDocumentStore(documentId);
      if (!store) return noDocumentError();

      const fullText = store.getText();
      const result = findOccurrence(fullText, pattern, occurrence);
      if ("error" in result) return mcpError("INVALID_RANGE", result.error);
      return mcpSuccess(result);
    }),
  );

  server.tool(
    "tandem_getContext",
    "Read content around a range without pulling the full document. Reduces token usage.",
    {
      from: z.number().describe("Start position"),
      to: z.number().describe("End position"),
      windowSize: z
        .number()
        .optional()
        .describe("Characters of context before/after (default 500)"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary(
      "tandem_getContext",
      async ({ from: rawFrom, to: rawTo, windowSize = 500, documentId }) => {
        const store = getDocumentStore(documentId);
        if (!store) return noDocumentError();

        const from = toFlatOffset(rawFrom);
        const to = toFlatOffset(rawTo);
        const fullText = store.getText();
        return mcpSuccess(extractContext(fullText, from, to, windowSize));
      },
    ),
  );
}
