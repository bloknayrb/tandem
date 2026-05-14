<script lang="ts">
import * as Y from "yjs";
import SidePanel from "../panels/SidePanel.svelte";
import { useAnnotationReview } from "../panels/useAnnotationReview.svelte";

interface Props {
  storeReadOnly: boolean;
}

let { storeReadOnly = $bindable(false) }: Props = $props();

// A real Y.Doc is required — SidePanel's observers don't tolerate null.
const ydoc = new Y.Doc();

// SidePanel now expects a `review` prop (lifted out of the panel itself).
// For this harness all the review getters are inert.
const review = useAnnotationReview({
  getYdoc: () => ydoc,
  getEditor: () => null,
  getAnnotations: () => [],
  onActiveAnnotationChange: () => {},
  getScrollBehavior: () => "auto",
});
</script>

<SidePanel
  annotations={[]}
  editor={null}
  {ydoc}
  activeAnnotationId={null}
  onActiveAnnotationChange={() => {}}
  {storeReadOnly}
  {review}
/>
