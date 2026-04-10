import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Y_MAP_AWARENESS } from "../../shared/constants.js";
import type { FlatOffset } from "../../shared/positions/types.js";
import { toFlatOffset } from "../../shared/positions/types.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { extractText, getCurrentDoc } from "./document.js";
import {
  escapeRegex,
  getErrorMessage,
  mcpError,
  mcpSuccess,
  noDocumentError,
  withErrorBoundary,
} from "./response.js";

/** Get full text from the current document's Y.Doc */
function getFullText(docName: string): string {
  const doc = getOrCreateDocument(docName);
  return extractText(doc);
}

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
  server.tool(
    "tandem_search",
    "Search for text in the document. Returns matching positions.",
    {
      query: z.string().describe("Search query (supports regex)"),
      regex: z.boolean().optional().describe("Treat query as regex"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_search", async ({ query, regex, documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const fullText = getFullText(current.docName);
      const result = searchText(fullText, query, regex);
      if (result.error) return mcpError("FORMAT_ERROR", result.error);
      return mcpSuccess({ matches: result.matches, count: result.matches.length });
    }),
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
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const fullText = getFullText(current.docName);
      const result = findOccurrence(fullText, pattern, occurrence);
      if ("error" in result) return mcpError("INVALID_RANGE", result.error);
      return mcpSuccess(result);
    }),
  );

  server.tool(
    "tandem_setStatus",
    'Update Claude status text shown to user (e.g., "Reviewing cost figures..."). Tip: call tandem_checkInbox after completing work to see if the user has responded.',
    {
      text: z.string().describe("Status text"),
      focusParagraph: z.number().optional().describe("Index of paragraph Claude is focusing on"),
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_setStatus", async ({ text, focusParagraph, documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) {
        return mcpSuccess({
          status: text,
          warning: "No document open — status not broadcast to editor.",
        });
      }
      const doc = getOrCreateDocument(current.docName);
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
      doc.transact(
        () =>
          awarenessMap.set("claude", {
            status: text,
            timestamp: Date.now(),
            active: true,
            focusParagraph: focusParagraph ?? null,
          }),
        MCP_ORIGIN,
      );
      return mcpSuccess({ status: text });
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
        const current = getCurrentDoc(documentId);
        if (!current) return noDocumentError();

        const from = toFlatOffset(rawFrom);
        const to = toFlatOffset(rawTo);
        const fullText = getFullText(current.docName);
        return mcpSuccess(extractContext(fullText, from, to, windowSize));
      },
    ),
  );
}
