import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOrCreateDocument } from "../yjs/provider.js";
import { getCurrentDoc, extractText } from "./document.js";
import {
  mcpSuccess,
  mcpError,
  noDocumentError,
  escapeRegex,
  getErrorMessage,
  withErrorBoundary,
} from "./response.js";

/** Get full text from the current document's Y.Doc */
function getFullText(docName: string): string {
  const doc = getOrCreateDocument(docName);
  return extractText(doc);
}

export interface SearchMatch {
  from: number;
  to: number;
  text: string;
}

/** Search for text in a document. Pure logic extracted for testability. */
export function searchText(
  fullText: string,
  query: string,
  useRegex?: boolean,
): { matches: SearchMatch[]; error?: string } {
  const matches: SearchMatch[] = [];
  try {
    const pattern = useRegex ? new RegExp(query, "gi") : new RegExp(escapeRegex(query), "gi");
    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({ from: match.index, to: match.index + match[0].length, text: match[0] });
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
): { from: number; to: number; text: string } | { error: string; totalCount: number } {
  const regex = new RegExp(escapeRegex(pattern), "g");
  let match;
  let count = 0;
  while ((match = regex.exec(fullText)) !== null) {
    count++;
    if (count === occurrence) {
      return { from: match.index, to: match.index + match[0].length, text: match[0] };
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
  from: number,
  to: number,
  windowSize: number = 500,
) {
  const contextStart = Math.max(0, from - windowSize);
  const contextEnd = Math.min(fullText.length, to + windowSize);
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
      const awarenessMap = doc.getMap("awareness");
      awarenessMap.set("claude", {
        status: text,
        timestamp: Date.now(),
        active: true,
        focusParagraph: focusParagraph ?? null,
      });
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
    withErrorBoundary("tandem_getContext", async ({ from, to, windowSize = 500, documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const fullText = getFullText(current.docName);
      return mcpSuccess(extractContext(fullText, from, to, windowSize));
    }),
  );
}
