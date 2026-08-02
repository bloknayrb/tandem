<script lang="ts">
import type * as Y from "yjs";
import SourceView from "../../../src/client/editor/SourceView.svelte";

interface SourceCommands {
  documentId: string;
  save(intent: "save" | "save-as"): Promise<boolean>;
  exit(): Promise<void>;
}

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
