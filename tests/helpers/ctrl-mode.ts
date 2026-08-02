import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_MODE, Y_MAP_USER_AWARENESS } from "../../src/shared/constants.js";

/**
 * Write (or clear) the Solo/Tandem mode key in CTRL_ROOM — the single thing
 * `server/mode.ts#readModeState` reads.
 *
 * Needed because the push path fails CLOSED on an ABSENT key: absence is
 * "indeterminate" ("we may have been in Solo and no longer know"), and both the
 * `pushEvent` privacy hold and `shouldForwardExternally` test for `"tandem"`,
 * not for `!== "solo"`. A test that wants events to flow must therefore say so,
 * which is also what production looks like — a connected client broadcasts its
 * mode into CTRL_ROOM the moment the ctrl Y.Doc exists
 * (`client/hooks/useTandemModeBroadcast.svelte.ts`).
 *
 * Resolves the ctrl doc through `getOrCreateDocument` on every call, so it works
 * unchanged in files that `vi.mock` the provider to hand back a per-test doc.
 *
 * Pass `null` to DELETE the key — that is the indeterminate state itself, and is
 * distinct from writing `"tandem"`.
 */
export function setCtrlMode(mode: "solo" | "tandem" | null): void {
  const awareness = getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_USER_AWARENESS);
  if (mode === null) awareness.delete(Y_MAP_MODE);
  else awareness.set(Y_MAP_MODE, mode);
}
