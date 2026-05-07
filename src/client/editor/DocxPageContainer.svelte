<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  children: Snippet;
}

const { children }: Props = $props();
</script>

<div class="docx-canvas">
  <div class="docx-sheet">
    {@render children()}
  </div>
</div>

<style>
  .docx-canvas {
    background: var(--tandem-page-bg);
    /* overflow: visible — must NOT create a new scroll ancestor */
    overflow: visible;
    padding: var(--tandem-space-6) var(--tandem-space-4);
    min-height: 100%;
    box-sizing: border-box;
  }

  .docx-sheet {
    position: relative; /* anchor for authorship gutter ::before at left: -14px */
    background: var(--tandem-page-paper);
    box-shadow: var(--tandem-page-shadow);
    max-width: 816px; /* US letter ~8.5in at 96dpi */
    margin: 0 auto;
    padding: var(--tandem-space-7) var(--tandem-space-6);
    box-sizing: border-box;
    min-height: 1056px; /* US letter ~11in at 96dpi */
  }
</style>
