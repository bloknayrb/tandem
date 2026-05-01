<script lang="ts">
  import type { Component } from "svelte";
  import { registry } from "./registry.js";

  const params = new URLSearchParams(window.location.search);
  const componentName = params.get("component");

  let status = $state<"idle" | "loading" | "loaded" | "not-found" | "error">("idle");
  let LoadedComponent = $state<Component | null>(null);

  $effect(() => {
    if (!componentName) {
      status = "idle";
      return;
    }

    const loader = registry[componentName];
    if (!loader) {
      status = "not-found";
      return;
    }

    status = "loading";
    loader()
      .then((mod) => {
        LoadedComponent = mod.default;
        status = "loaded";
      })
      .catch(() => {
        status = "error";
      });
  });
</script>

{#if status === "idle"}
  <div class="message">
    <h1>Svelte Harness</h1>
    <p>Harness ready — no components registered yet.</p>
    <p class="hint">Use <code>?component=Name</code> to render a registered component.</p>
  </div>
{:else if status === "not-found"}
  <div class="message error">
    <h1>Component not found</h1>
    <p>No component named <strong>{componentName}</strong> in the registry.</p>
  </div>
{:else if status === "loading"}
  <div class="message">
    <p>Loading <strong>{componentName}</strong>…</p>
  </div>
{:else if status === "error"}
  <div class="message error">
    <h1>Load error</h1>
    <p>Failed to load <strong>{componentName}</strong>. Check the browser console.</p>
  </div>
{:else if status === "loaded" && LoadedComponent}
  <LoadedComponent />
{/if}

<style>
  .message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 0.75rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #374151;
    text-align: center;
    padding: 2rem;
  }

  .message h1 {
    font-size: 1.5rem;
    font-weight: 600;
  }

  .message p {
    font-size: 1rem;
    color: #6b7280;
  }

  .message.error h1 {
    color: #dc2626;
  }

  .hint {
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  code {
    background: #f3f4f6;
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    font-size: 0.875em;
  }
</style>
