import type { DocListEntry } from "../types";

/** Filter a document list to only docs not already represented in tabs or pending creation. */
export function deduplicateDocList(
  docList: DocListEntry[],
  existingIds: Set<string>,
  pendingIds: Set<string>,
): DocListEntry[] {
  return docList.filter((d) => !existingIds.has(d.id) && !pendingIds.has(d.id));
}
