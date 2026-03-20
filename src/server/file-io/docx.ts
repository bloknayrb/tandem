// .docx support - review-only mode by default
// Uses mammoth.js for import (lossy but content-preserving)
// TODO: Implement with worker_threads to avoid blocking the event loop

export async function loadDocx(_filePath: string): Promise<string> {
  throw new Error('DOCX support not yet implemented');
}

export async function exportDocxChanges(_annotations: unknown[]): Promise<string> {
  return '# Changes\n\nNo changes recorded.';
}
