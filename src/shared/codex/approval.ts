/**
 * Wire shape of `GET /api/codex/approvals` — the human-in-the-loop gate the
 * approval dialog renders.
 *
 * Lives in `src/shared/` because the server *produces* it and the client
 * *renders* it, and the two had already drifted: the modal declared its own
 * local `Approval` interface carrying only `command`/`cwd`/`reason`, so the
 * file-change fields the broker had been sending — the paths and diffs
 * "Allow for session" hands write access to — were dropped on the floor before
 * they reached a pixel. A user was being asked to grant a standing write
 * permission with the scope of that permission invisible.
 *
 * Semantics live with the producer (`src/server/codex/approval-broker.ts`);
 * this file is the shape both sides agree on, nothing more.
 */

export type CodexFileChangeKind = "add" | "delete" | "update" | "unknown";

/** One file Codex is asking to write, as rendered in the approval dialog. */
export interface CodexFileChangeView {
  /** Control-stripped, single-line, <= MAX_PATH chars. As Codex sent it. */
  path: string;
  kind: CodexFileChangeKind;
  /** Rename target, when Codex supplied one. */
  movePath?: string;
  /** Unified diff (`update`) or the new file's content (`add`). May be absent. */
  diff?: string;
  /** `diff` was cut, or omitted entirely, to stay inside the budget. */
  diffTruncated?: boolean;
  /** Counted from the FULL text before truncation, so they stay honest when `diff` is elided. */
  added?: number;
  removed?: number;
}

export interface CodexApprovalView {
  id: string;
  kind: "command" | "file-change";
  title: string;
  command?: string;
  cwd?: string;
  reason?: string;
  createdAt: number;
  /**
   * May "Allow for session" be offered? `approved_for_session` is a standing
   * write grant, so it is false whenever the request is a file change whose
   * change set we could not read — there is nothing to show the user, and a
   * blind write grant is exactly the thing worth refusing.
   */
  allowForSession: boolean;
  /** file-change only. Empty when Codex sent a shape we could not read. */
  changes?: CodexFileChangeView[];
  /** file-change only. Changes beyond MAX_CHANGES, reported as a count. */
  omittedChanges?: number;
  /**
   * file-change only. The root Codex asked for write access to, when the
   * request carries one. This is the scope "Allow for session" hands over.
   */
  grantRoot?: string;
}
