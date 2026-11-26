/**
 * The tool-result fields that report unsaved edits a Claude action discarded
 * after keeping them as a backup (ADR-057, `documents/keep-unsaved.ts`). One
 * shape for `tandem_open force`, `tandem_restoreBackup` and `tandem_close`, so
 * the model learns one way to tell the user and to undo.
 */
export function backupKeptFields(
  kept: { name: string; timestamp: string },
  action: "reload" | "restore" | "close",
): {
  backupKept: { name: string; timestamp: string };
  backupKeptNote: string;
} {
  // JSON-quoted, so whatever a file name carries stays a string literal.
  const restoreCall = `tandem_restoreBackup with backup: ${JSON.stringify(kept.name)}`;
  return {
    backupKept: { name: kept.name, timestamp: kept.timestamp },
    backupKeptNote:
      "The document had unsaved edits, which this discarded. They were kept as a backup first: " +
      "tell the user, and if they want them back, " +
      (action === "close"
        ? `reopen the document with tandem_open, then call ${restoreCall}.`
        : `call ${restoreCall}.`),
  };
}
