import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";

export interface DocListEntry {
  id: string;
  filePath: string;
  fileName: string;
  format: string;
  readOnly: boolean;
}

export interface OpenTab extends DocListEntry {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
}
