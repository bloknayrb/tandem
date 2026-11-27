/**
 * A counter that says "a document's backups may have changed" (ADR-057, PR 2).
 *
 * The kept-edits banner re-reads `GET /api/backups` whenever it moves. Bumped
 * from event handlers and async continuations only — a notify-stream message,
 * the stream reopening after a drop (notices sent while it was down are not
 * replayed to `onStreamNotice`), the window becoming visible again, and the
 * Version history's own restores — never from a Tiptap handler or inside a
 * reaction (`state_unsafe_mutation`).
 *
 * An object, not an exported `$state` number: a module cannot export a
 * reassigned rune binding.
 */

const revision = $state({ value: 0 });

/** The current revision. Read it inside an `$effect` to re-run on every bump. */
export function backupsRevision(): number {
  return revision.value;
}

/** Say that some document's backups may have changed. */
export function bumpBackupsRevision(): void {
  revision.value++;
}
