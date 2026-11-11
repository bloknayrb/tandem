/**
 * Which ownership mode each MCP tool is in (#2358, ADR-054; ownership design §5.1).
 *
 * Every registered tool is in exactly one row. `tests/server/ownership-tool-modes.test.ts`
 * pins this table against the tools actually registered and against a literal
 * copy of the design's table, so a new tool fails until someone places it, and
 * a tool cannot be moved to a weaker mode without a reviewed diff.
 *
 * - `write`: checked in the document's operation queue; claims an unowned
 *   document; a non-owner gets `NOT_DOC_OWNER`.
 * - `take`: `tandem_open`'s take rule (ownership design §4.2).
 * - `reply`: `tandem_reply`, whose acceptance rules (ownership design §7.3) are PR 2's. **Not
 *   enforced by PR 1c**: until PR 2 a session refused a write can still answer
 *   in chat.
 * - `owner-only`: never claims; refused on a document another record holds (ownership design §5.6).
 * - `status`: write-mode `tandem_status` (ownership design §5.2): the text is global, a focus on
 *   another record's document is ignored.
 * - `read`: open to everyone, never claims.
 *
 * `tandem_restoreBackup` is `write`; its list mode (no `backup`) is a read and
 * takes no check. `tandem_checkInbox` is `read` here and scoped in PR 2 (ownership design §6).
 * The design's table also names deprecated `flag` / `suggest` stubs: no such
 * tools are registered, so they have no row. `tandem_applyChanges` and
 * `tandem_convertToMarkdown` are registered only where `.docx` is on.
 */
export type ToolMode = "write" | "take" | "reply" | "owner-only" | "status" | "read";

export interface ToolModeEntry {
  readonly mode: ToolMode;
  /** The ownership PR that enforces this row. */
  readonly enforcedIn: "1c" | "2";
}

const w: ToolModeEntry = { mode: "write", enforcedIn: "1c" };
const r: ToolModeEntry = { mode: "read", enforcedIn: "1c" };

export const TOOL_MODES: Readonly<Record<string, ToolModeEntry>> = {
  tandem_edit: w,
  tandem_appendContent: w,
  tandem_editList: w,
  tandem_applyChanges: w,
  tandem_restoreBackup: w,
  tandem_save: w,
  tandem_rename: w,
  tandem_close: w,
  tandem_convertToMarkdown: w,
  tandem_comment: w,
  tandem_resolveAnnotation: w,
  tandem_removeAnnotation: w,
  tandem_editAnnotation: w,
  tandem_annotationReply: w,
  tandem_open: { mode: "take", enforcedIn: "1c" },
  tandem_scratchpad: { mode: "take", enforcedIn: "1c" },
  tandem_reply: { mode: "reply", enforcedIn: "2" },
  tandem_switchDocument: { mode: "owner-only", enforcedIn: "1c" },
  tandem_status: { mode: "status", enforcedIn: "1c" },
  tandem_getTextContent: r,
  tandem_getOutline: r,
  tandem_getContext: r,
  tandem_getAnnotations: r,
  tandem_listDocuments: r,
  tandem_search: r,
  tandem_resolveRange: r,
  tandem_getActivity: r,
  tandem_exportAnnotations: r,
  tandem_diagnostics: r,
  tandem_checkInbox: { mode: "read", enforcedIn: "2" },
};
