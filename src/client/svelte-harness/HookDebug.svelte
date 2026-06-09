<script lang="ts">
import { onDestroy } from "svelte";
import { createYjsSync } from "../hooks/yjsSync.svelte";

const sync = createYjsSync();

onDestroy(() => {
  sync.destroy();
});

// Build a JSON-safe snapshot of the hook's reactive state.
const snapshot = $derived({
  ready: sync.ready,
  connected: sync.connected,
  connectionStatus: sync.connectionStatus,
  reconnectAttempts: sync.reconnectAttempts,
  disconnectedSince: sync.disconnectedSince,
  serverRestarted: sync.serverRestarted,
  activeTabId: sync.activeTabId,
  tabIds: sync.tabs.map((t) => t.id),
  tabCount: sync.tabs.length,
  annotationCount: sync.annotations.length,
  claudeStatus: sync.claudeStatus,
  claudeActive: sync.claudeActive,
  readOnly: sync.tabs.find((t) => t.id === sync.activeTabId)?.readOnly ?? false,
  hasBootstrapYdoc: sync.bootstrapYdoc !== null,
});
</script>

<div class="debug">
  <h1>yjsSync hook debug</h1>
  <p>
    This view instantiates <code>createYjsSync()</code> and renders its reactive state as JSON.
    Connect the dev server (<code>npm run dev:server</code>) to populate fields beyond defaults.
  </p>
  <pre>{JSON.stringify(snapshot, null, 2)}</pre>
</div>

<style>
  .debug {
    padding: 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  pre {
    background: #f3f4f6;
    padding: 1rem;
    border-radius: 6px;
    font-size: 0.85rem;
    overflow: auto;
  }
  code {
    background: #f3f4f6;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    font-size: 0.875em;
  }
</style>
