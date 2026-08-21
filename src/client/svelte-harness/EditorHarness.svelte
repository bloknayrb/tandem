<script lang="ts">
import { HocuspocusProvider } from "@hocuspocus/provider";
import { onDestroy } from "svelte";
import * as Y from "yjs";
import Editor from "../editor/Editor.svelte";
import { WS_URL } from "../utils/backend-ports";

// Fresh Y.Doc + a no-op-ish provider for harness rendering. The provider
// will attempt to connect; failure is fine — we only need the object so
// the CollaborationCursor extension constructs without throwing. (It carries
// no generation token, so a live server would auth-reject it — also fine;
// expect that line of console noise when a dev server is running.)
const ydoc = new Y.Doc();
const provider = new HocuspocusProvider({
  url: WS_URL,
  name: "harness-doc",
  document: ydoc,
});
// Disconnect immediately — the harness does not need a live connection,
// we only need a constructed provider so CollaborationCursor wires up.
provider.disconnect();

onDestroy(() => {
  provider.destroy();
  ydoc.destroy();
});
</script>

<div style="padding: 16px;">
  <h2 style="margin: 0 0 12px 0;">Editor harness</h2>
  <Editor {ydoc} {provider} readOnly={false} />
</div>
