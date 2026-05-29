<script lang="ts">
import { untrack } from "svelte";
import { REGISTRY_TO_SHORTCUT_ID, type RemappableShortcutId } from "../actions/keybindings.js";
import { ACTION_GROUPS, getActionsMap } from "../actions/registry.svelte.js";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { STATIC_SHORTCUT_ROWS } from "../actions/static-shortcuts.js";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Effective (override ?? default) formatted labels per remappable id.
   * Rows whose registry id maps through `REGISTRY_TO_SHORTCUT_ID` display the
   * effective combo so the catalog reflects user remaps. */
  effectiveShortcutLabels?: Map<RemappableShortcutId, string>;
}

let { open, onClose, effectiveShortcutLabels }: Props = $props();

// Registry-derived sections — same source as Settings → Shortcuts tab. Rows
// for remappable actions reflect the user's effective binding.
const registryShortcutSections = $derived.by(() => {
  const actionsMap = getActionsMap();
  const labels = effectiveShortcutLabels;
  const byGroup = new Map<string, Array<{ keys: string; description: string }>>();
  for (const action of actionsMap.values()) {
    if (!action.shortcut) continue;
    const remappableId = REGISTRY_TO_SHORTCUT_ID[action.id];
    const keys = (remappableId && labels?.get(remappableId)) || action.shortcut;
    const rows = byGroup.get(action.group) ?? [];
    rows.push({ keys, description: action.label });
    byGroup.set(action.group, rows);
  }
  return ACTION_GROUPS.map((g) => ({
    title: g.charAt(0).toUpperCase() + g.slice(1),
    rows: byGroup.get(g) ?? [],
  })).filter((s) => s.rows.length > 0);
});
let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;

$effect(() => {
  if (!open) return;
  // untrack: dialogEl must not be a dep — bind:this setting it would re-run the
  // effect, causing cleanup to restore prevFocus mid-open, then re-open to wrong element.
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  const onFocusIn = (e: FocusEvent) => {
    if (el && !el.contains(e.target as Node)) el.focus();
  };
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
});

$effect(() => {
  if (!open) return;
  // Capture phase + stopPropagation so closing the modal with Escape doesn't also
  // trip the global Escape-to-deselect handler (App.svelte), which is a same-phase
  // window listener registered earlier.
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  window.addEventListener("keydown", handler, { capture: true });
  return () => window.removeEventListener("keydown", handler, { capture: true });
});
</script>

{#if open}
  <div
    role="presentation"
    style="position: fixed; inset: 0; background: color-mix(in srgb, var(--tandem-bg) 70%, transparent); display: flex; align-items: center; justify-content: center; z-index: var(--tandem-z-above-titlebar);"
    onclick={onClose}
    data-testid="help-modal"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
      tabindex="-1"
      bind:this={dialogEl}
      class="tandem-scroll-fade-y"
      use:scrollFade={"y"}
      style="background-color: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-5); box-shadow: var(--tandem-shadow-3); padding: 24px 28px 20px; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto; position: relative;"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        if (e.key === "Escape") {
          onClose();
          return;
        }
        e.stopPropagation();
        if (e.key === "Tab" && dialogEl) {
          const focusable = Array.from(
            dialogEl.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          ).filter(el => !el.closest('[hidden]'));
          if (focusable.length === 0) { e.preventDefault(); return; }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div
        style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;"
      >
        <h2 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--tandem-fg);">
          Keyboard Shortcuts
        </h2>
        <button
          type="button"
          class="modal-close"
          onclick={onClose}
          aria-label="Close help"
          data-testid="help-modal-close"
        >
          ✕
        </button>
      </div>

      {#each registryShortcutSections as section (section.title)}
        <div style="margin-bottom: 18px;">
          <div
            style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--tandem-fg-subtle); margin-bottom: 6px;"
          >
            {section.title}
          </div>
          <div style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;">
            {#each section.rows as row (row.description)}
              <span style="font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace; white-space: nowrap;">
                <kbd style="display: inline-block; padding: 1px 6px; font-size: 12px; font-family: inherit; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom: 2px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); color: var(--tandem-fg); line-height: 1.5;">{row.keys}</kbd>
              </span>
              <span style="font-size: 13px; color: var(--tandem-fg-muted);">{row.description}</span>
            {/each}
          </div>
        </div>
      {/each}

      <!-- Static shortcuts not yet in the action registry -->
      <div style="margin-bottom: 18px;">
        <div
          style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--tandem-fg-subtle); margin-bottom: 6px;"
        >
          Other
        </div>
        <div style="display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; align-items: center;">
          {#each STATIC_SHORTCUT_ROWS as row (row.description)}
            <span style="font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace; white-space: nowrap;">
              <kbd style="display: inline-block; padding: 1px 6px; font-size: 12px; font-family: inherit; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom: 2px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); color: var(--tandem-fg); line-height: 1.5;">{row.keys}</kbd>
            </span>
            <span style="font-size: 13px; color: var(--tandem-fg-muted);">{row.description}</span>
          {/each}
        </div>
      </div>

      <div
        style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--tandem-border); font-size: 11px; color: var(--tandem-fg-subtle); text-align: center;"
      >
        Press
        <kbd style="font-size: 11px; padding: 1px 4px; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); color: var(--tandem-fg-subtle);">?</kbd>,
        <kbd style="font-size: 11px; padding: 1px 4px; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); color: var(--tandem-fg-subtle);">Ctrl+/</kbd>,
        or
        <kbd style="font-size: 11px; padding: 1px 4px; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); color: var(--tandem-fg-subtle);">Esc</kbd>
        to close
      </div>
    </div>
  </div>
{/if}

<style>
  /* Close button — mirrors SettingsModal.svelte's `.settings-modal-close` recipe
     (28×28, transparent border, fg-subtle on surface-sunk hover) so the modal
     family reads as one. Lives in a <style> block (not inline) because :hover /
     :focus-visible can't be expressed in style="..." attributes. */
  .modal-close {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--tandem-fg-subtle);
    font-size: 18px;
    line-height: 1;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: var(--tandem-r-2);
  }
  .modal-close:hover,
  .modal-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }
</style>
