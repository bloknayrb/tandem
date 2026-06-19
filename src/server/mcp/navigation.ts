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

export interface SearchMatch {
  from: FlatOffset;
  to: FlatOffset;
  text: string;
}

/** Search for text in a document. Pure logic extracted for testability. */
export function searchText(
  fullText: string,
  query: string,
  useRegex?: boolean,
): { matches: SearchMatch[]; error?: string } {
  const MAX_MATCHES = 10_000;
  const matches: SearchMatch[] = [];
  try {
    const pattern = useRegex ? new RegExp(query, "gi") : new RegExp(escapeRegex(query), "gi");
    let match;
    const start = Date.now();
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({
        from: toFlatOffset(match.index),
        to: toFlatOffset(match.index + match[0].length),
        text: match[0],
      });
      if (matches.length >= MAX_MATCHES) {
        return { matches, error: `Search capped at ${MAX_MATCHES} matches` };
      }
      // Guard against catastrophic backtracking — bail after 2s
      if (Date.now() - start > 2000) {
        return { matches, error: "Search timed out — simplify the regex pattern" };
      }
      // Prevent infinite loops on zero-length matches
      if (match[0].length === 0) pattern.lastIndex++;
    }
  } catch (err) {
    return { matches: [], error: `Invalid regex: ${getErrorMessage(err)}` };
  }
  return { matches };
}

/** Find the nth occurrence of a pattern. Pure logic extracted for testability. */
export function findOccurrence(
  fullText: string,
  pattern: string,
  occurrence: number = 1,
): { from: FlatOffset; to: FlatOffset; text: string } | { error: string; totalCount: number } {
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
        query: z.string().describe("Search query (supports regex)"),
        regex: z.boolean().optional().describe("Treat query as regex"),
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
        const result = searchText(fullText, query, regex);
        if (result.error) return mcpError("FORMAT_ERROR", result.error);
        return mcpStructured({ matches: result.matches, count: result.matches.length });
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
