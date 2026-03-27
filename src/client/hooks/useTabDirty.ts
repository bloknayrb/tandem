import { useEffect, useRef, useState } from "react";
import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
import type { OpenTab } from "../types.js";

/**
 * Returns true if the tab's document has unsaved content changes.
 *
 * Tracks edits client-side by observing the Y.Doc's XmlFragment("default").
 * Arms after a 500ms delay to ignore initial sync changes.
 * Resets when savedAtVersion changes (set by server on tandem_save).
 *
 * Read-only tabs always return false (editor is non-editable).
 */
export function useTabDirty(tab: OpenTab): boolean {
  const [dirty, setDirty] = useState(false);
  const editCountRef = useRef(0);
  const baselineRef = useRef<number | null>(null);

  useEffect(() => {
    if (tab.readOnly) {
      setDirty(false);
      return;
    }

    const { ydoc } = tab;
    const fragment = ydoc.getXmlFragment("default");
    const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);

    // Let initial sync settle before tracking
    let armed = false;
    const armTimer = setTimeout(() => {
      armed = true;
      baselineRef.current = (meta.get(Y_MAP_SAVED_AT_VERSION) as number) ?? 0;
      editCountRef.current = 0;
      setDirty(false);
    }, 500);

    // Track content edits
    const onFragmentChange = () => {
      if (!armed) return;
      editCountRef.current++;
      setDirty(true);
    };
    fragment.observeDeep(onFragmentChange);

    // Watch for save events (server sets savedAtVersion after tandem_save)
    const onMetaChange = () => {
      if (!armed) return;
      const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
      if (saved !== undefined && saved !== baselineRef.current) {
        baselineRef.current = saved;
        editCountRef.current = 0;
        setDirty(false);
      }
    };
    meta.observe(onMetaChange);

    return () => {
      clearTimeout(armTimer);
      fragment.unobserveDeep(onFragmentChange);
      meta.unobserve(onMetaChange);
    };
  }, [tab.ydoc, tab.readOnly]);

  return dirty;
}
