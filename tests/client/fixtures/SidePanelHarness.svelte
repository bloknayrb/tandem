<script lang="ts">
/**
 * #1824 item G test harness.
 *
 * `@testing-library/svelte`'s `rerender()` packs every prop into ONE
 * `$state.raw` container and replaces it wholesale on each call
 * (`@testing-library/svelte-core/src/props.svelte.js`), so ANY prop
 * changing — even to the same value — invalidates every effect that reads
 * ANY prop, including one that reads only `documentId`. That is a testing
 * artifact, not production behaviour: real Svelte markup passes each prop
 * as its own fine-grained binding, so a parent re-render that leaves
 * `documentId` unwritten never invalidates an effect that reads only it.
 *
 * This wrapper reproduces that real shape — `documentId` and an unrelated
 * `bumpCount` live as SEPARATE `$state` fields, and `<SidePanel>` is
 * mounted through real markup — so a spec can distinguish "an unrelated
 * re-render happened" from "documentId actually changed", the way
 * production App.svelte does.
 */
import { untrack } from "svelte";
import type * as Y from "yjs";
import type { Annotation } from "../../../src/shared/types";
import SidePanel from "../../../src/client/panels/SidePanel.svelte";
import type { UseAnnotationReviewReturn } from "../../../src/client/panels/useAnnotationReview.svelte";

let {
  ydoc,
  review,
  initialDocumentId,
}: {
  ydoc: Y.Doc;
  review: UseAnnotationReviewReturn;
  initialDocumentId: string;
} = $props();

// Hydrated ONCE from the prop — deliberately decoupled from it afterward,
// since `setDocumentId` (the fixture's own exported setter) is the only
// intended way to change it from a test. `untrack` quiets svelte-check's
// state_referenced_locally warning while pinning that intent.
let documentId = $state(untrack(() => initialDocumentId));
// Bumped to force an unrelated re-render (mirrors App.svelte recomputing
// `annotations` on every store change, #1772's own docblock) WITHOUT
// touching documentId.
let bumpCount = $state(0);

export function setDocumentId(id: string) {
  documentId = id;
}
export function bumpUnrelated() {
  bumpCount++;
}

const annotations = $derived.by((): Annotation[] => {
  void bumpCount; // dependency only — forces a fresh array on each bump
  return [];
});
</script>

<SidePanel
  {annotations}
  editor={null}
  {ydoc}
  {documentId}
  activeAnnotationId={null}
  onActiveAnnotationChange={() => {}}
  {review}
/>
