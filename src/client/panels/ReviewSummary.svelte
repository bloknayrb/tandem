<script lang="ts">
interface Props {
  accepted: number;
  dismissed: number;
  total: number;
  onDismiss: () => void;
}

let { accepted, dismissed, total, onDismiss }: Props = $props();

const acceptRate = $derived(total > 0 ? Math.round((accepted / total) * 100) : 0);
const emoji = $derived(acceptRate >= 80 ? "✅" : acceptRate >= 50 ? "📋" : "🔍");

let doneBtn: HTMLButtonElement | null = $state(null);
let prevFocus: Element | null = null;

$effect(() => {
  prevFocus = document.activeElement;
  doneBtn?.focus();
  return () => {
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) {
      prevFocus.focus();
    }
  };
});
</script>

<div
  role="presentation"
  style="position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); z-index: 1000;"
  onclick={onDismiss}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Review Complete"
    tabindex="-1"
    style="background: var(--tandem-surface); border-radius: 12px; padding: 32px 40px; max-width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); text-align: center;"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onDismiss(); }
      if (e.key === "Tab") e.preventDefault();
    }}
  >
    <div style="font-size: 48px; margin-bottom: 8px;">{emoji}</div>
    <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: 600; color: var(--tandem-fg);">
      Review Complete
    </h2>
    <p style="margin: 0 0 20px; color: var(--tandem-fg-muted); font-size: 14px;">
      All annotations have been resolved.
    </p>
    <div style="display: flex; justify-content: center; gap: 24px; margin-bottom: 20px;">
      <div>
        <div style="font-size: 28px; font-weight: 700; color: var(--tandem-success);">{accepted}</div>
        <div style="font-size: 12px; color: var(--tandem-fg-muted);">Accepted</div>
      </div>
      <div style="width: 1px; background: var(--tandem-border);"></div>
      <div>
        <div style="font-size: 28px; font-weight: 700; color: var(--tandem-error);">{dismissed}</div>
        <div style="font-size: 12px; color: var(--tandem-fg-muted);">Dismissed</div>
      </div>
      <div style="width: 1px; background: var(--tandem-border);"></div>
      <div>
        <div style="font-size: 28px; font-weight: 700; color: var(--tandem-accent);">{acceptRate}%</div>
        <div style="font-size: 12px; color: var(--tandem-fg-muted);">Accept rate</div>
      </div>
    </div>
    <button
      bind:this={doneBtn}
      onclick={onDismiss}
      style="padding: 8px 24px; font-size: 14px; font-weight: 500; border: none; border-radius: 6px; background: var(--tandem-accent); color: var(--tandem-accent-fg); cursor: pointer;"
    >
      Done
    </button>
  </div>
</div>
