<script lang="ts">
import * as Y from "yjs";
import SidePanel from "../panels/SidePanel.svelte";

interface Props {
  storeReadOnly: boolean;
}

let { storeReadOnly = $bindable(false) }: Props = $props();

// A real Y.Doc is required — SidePanel's observers don't tolerate null.
const ydoc = new Y.Doc();
</script>

<SidePanel
  annotations={[]}
  editor={null}
  {ydoc}
  activeAnnotationId={null}
  onActiveAnnotationChange={() => {}}
  {storeReadOnly}
/>
