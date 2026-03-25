import type * as Y from "yjs";

/**
 * Format-specific content adapter.
 *
 * Adapters convert between raw file content and Y.Doc state.
 * File I/O (reading/writing to disk) stays in the MCP layer —
 * adapters only see content, never paths.
 */
export interface FormatAdapter {
  /** Populate a Y.Doc from raw file content */
  load(doc: Y.Doc, content: string | Buffer): void | Promise<void>;

  /**
   * Serialize a Y.Doc back to file content.
   * Returns null for read-only formats (e.g. .docx).
   */
  save(doc: Y.Doc): string | null;

  /** Whether this format supports saving back to disk */
  readonly canSave: boolean;
}
