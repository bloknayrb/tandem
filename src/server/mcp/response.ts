/**
 * Shared MCP tool response helpers.
 * Eliminates the 3-line wrapper pattern repeated ~40 times across tool files.
 */

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

/** Wrap a successful response in the MCP content envelope */
export function mcpSuccess<T>(data: T): McpToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: false, data }) }],
  };
}

/** Wrap an error response in the MCP content envelope */
export function mcpError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): McpToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: true, code, message, ...(details && { details }) }) }],
  };
}

/** Standard NO_DOCUMENT error — returned when a tool requires an open document */
export function noDocumentError(): McpToolResult {
  return mcpError('NO_DOCUMENT', 'No document is open. Call tandem_open first.');
}

/** Extract a human-readable message from an unknown error */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Escape a string for use as a literal in a RegExp */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
