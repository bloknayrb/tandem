<script lang="ts">
interface Props {
  annotationId: string;
  text: string | undefined;
}

let { annotationId, text }: Props = $props();

const display = $derived(text ? (text.length > 80 ? text.slice(0, 77) + "..." : text) : "");
</script>

{#if text}
  <div
    data-testid="annotation-snippet-{annotationId}"
    style="padding: 4px 8px; margin-bottom: 6px; border-left: 3px solid var(--tandem-border-strong); color: var(--tandem-fg-muted); font-size: 12px; font-style: italic; background-color: var(--tandem-surface-muted); border-radius: var(--tandem-r-1);"
  >
    {display}
  </div>
{/if}
