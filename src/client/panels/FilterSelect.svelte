<script lang="ts">
  export interface FilterSelectProps {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string }>;
    testId?: string;
  }

  let { value, onChange, options, testId }: FilterSelectProps = $props();
</script>

<select
  data-testid={testId}
  {value}
  onchange={(e) => onChange((e.target as HTMLSelectElement).value)}
  style="padding: 2px 4px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-surface); color: var(--tandem-fg); cursor: pointer; outline: none;"
>
  {#each options as o (o.value)}
    <option value={o.value}>{o.label}</option>
  {/each}
</select>
