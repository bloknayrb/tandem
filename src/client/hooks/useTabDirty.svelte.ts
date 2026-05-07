import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
import type { OpenTab } from "../types.js";

export interface TabDirtyState {
  readonly dirty: boolean;
}

/**
 * Svelte 5 port of `useTabDirty`.
 *
 * Returns true if the tab's document has unsaved content changes.
 * Accepts a getter for `tab` so callers with `$state` values propagate
 * reactively. Adds `keysChanged` filtering on the meta observer (missing
 * from the original React version).
 */
export function createTabDirty(getTab: () => OpenTab | undefined): TabDirtyState {
  let dirty = $state(false);

  $effect(() => {
    const tab = getTab();

    if (!tab || tab.readOnly) {
      dirty = false;
      return;
    }

    const { ydoc } = tab;
    const fragment = ydoc.getXmlFragment("default");
    const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);

    let armed = false;
    let baseline: number | null = null;

    const armTimer = setTimeout(() => {
      armed = true;
      baseline = (meta.get(Y_MAP_SAVED_AT_VERSION) as number) ?? 0;
      dirty = false;
    }, 500);

    const onFragmentChange = () => {
      if (!armed) return;
      dirty = true;
    };
    fragment.observeDeep(onFragmentChange);

    const onMetaChange = (event: import("yjs").YMapEvent<unknown>) => {
      // keysChanged guard: only act on savedAtVersion changes
      if (!event.keysChanged.has(Y_MAP_SAVED_AT_VERSION)) return;
      if (!armed) return;
      const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
      if (saved !== undefined && saved !== baseline) {
        baseline = saved;
        dirty = false;
      }
    };
    meta.observe(onMetaChange);

    return () => {
      clearTimeout(armTimer);
      fragment.unobserveDeep(onFragmentChange);
      meta.unobserve(onMetaChange);
    };
  });

  return {
    get dirty() {
      return dirty;
    },
  };
}
