import { useEffect, useState } from "react";
import {
  Y_MAP_CONTENT_VERSION,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import type { OpenTab } from "../types.js";

/** Returns true if the tab's document has unsaved content changes. */
export function useTabDirty(tab: OpenTab): boolean {
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const meta = tab.ydoc.getMap(Y_MAP_DOCUMENT_META);

    function check() {
      const content = meta.get(Y_MAP_CONTENT_VERSION) as number | undefined;
      const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
      setDirty(content !== undefined && saved !== undefined && content !== saved);
    }

    check();
    meta.observe(check);
    return () => meta.unobserve(check);
  }, [tab.ydoc]);

  return dirty;
}
