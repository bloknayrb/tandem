<script lang="ts">
import type { ComponentProps } from "svelte";
import type * as Y from "yjs";
import SourceView from "../../../src/client/editor/SourceView.svelte";

// Derived from `SourceView`'s own callback signature rather than re-declared:
// a hand-copied command shape drifts silently (#1614).
type SourceCommands = NonNullable<
  Parameters<ComponentProps<typeof SourceView>["onCommandsChange"]>[1]
>;

interface Props {
  documentId: string;
  ydoc: Y.Doc;
}

const { documentId, ydoc }: Props = $props();
let commandsByDocument = $state(new Map<string, SourceCommands>());

function updateCommands(id: string, commands: SourceCommands | null): void {
  const next = new Map(commandsByDocument);
  if (commands) next.set(id, commands);
  else next.delete(id);
  commandsByDocument = next;
}
</script>

<span data-testid="source-command-count">{commandsByDocument.size}</span>
<SourceView
  {documentId}
  {ydoc}
  onDraftChange={() => {}}
  onSave={async () => true}
  onCommandsChange={updateCommands}
  onExit={() => {}}
/>
