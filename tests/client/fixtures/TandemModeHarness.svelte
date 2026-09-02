<script lang="ts">
import type * as Y from "yjs";
import { createTandemModeBroadcast } from "../../../src/client/hooks/useTandemModeBroadcast.svelte";
import type { TandemMode } from "../../../src/shared/types";

let {
  doc,
  synced,
  dwellMs = 1000,
}: {
  /** null models the pre-bootstrap window, where `bootstrapYdoc` is still null. */
  doc: Y.Doc | null;
  synced: boolean;
  dwellMs?: number;
} = $props();

// The hook owns its own Y.Map observer, so this fixture deliberately exposes no
// way to inject a "room value". A prop would let a spec assert against a state
// production cannot reach — the detector derives the room value FROM the map —
// and the code would then be defending against the fixture. Specs drive remote
// changes by applying a real Yjs update from a second doc.
const modeState = createTandemModeBroadcast(
  () => doc,
  () => dwellMs,
  () => synced,
);

export function setMode(mode: TandemMode) {
  modeState.setTandemMode(mode);
}
</script>

<output data-testid="mode">{modeState.tandemMode}</output>
