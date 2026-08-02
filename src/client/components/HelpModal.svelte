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
  // trip the global Escape-to-deselect handler (App.svelte), which is a
  // bubble-phase window listener — capture runs first regardless of registration
  // order, so stopPropagation here keeps Escape from ever reaching it.
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
  <div role="presentation" class="modal-backdrop" onclick={onClose} data-testid="help-modal">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-modal-title"
      tabindex="-1"
      bind:this={dialogEl}
      class="shortcut-modal"
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
      <header class="modal-header">
        <h2 id="shortcut-modal-title">
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
      </header>

      <!-- Scrollable regions need keyboard focus so Page Up/Down works without
           routing focus through the fixed header/footer. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="modal-content tandem-scroll-fade-y"
        data-testid="help-modal-content"
        role="region"
        aria-label="Shortcut categories"
        tabindex="0"
        use:scrollFade={"y"}
      >
        <div class="shortcut-sections">
          {#each registryShortcutSections as section (section.title)}
            <section class="shortcut-section">
              <h3>{section.title}</h3>
              <div class="shortcut-rows">
                {#each section.rows as row (row.description)}
                  <span class="shortcut-keys"><kbd>{row.keys}</kbd></span>
                  <span class="shortcut-description">{row.description}</span>
                {/each}
              </div>
            </section>
          {/each}

          <!-- Static shortcuts not yet in the action registry -->
          <section class="shortcut-section">
            <h3>Other</h3>
            <div class="shortcut-rows">
              {#each STATIC_SHORTCUT_ROWS as row (row.description)}
                <span class="shortcut-keys"><kbd>{row.keys}</kbd></span>
                <span class="shortcut-description">{row.description}</span>
              {/each}
            </div>
          </section>
        </div>
      </div>

      <footer class="modal-footer">
        Press
        <kbd>?</kbd>,
        <kbd>Ctrl+/</kbd>,
        or
        <kbd>Esc</kbd>
        to close
      </footer>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--tandem-z-above-titlebar);
  }

  .shortcut-modal {
    width: min(760px, 92vw);
    max-height: min(82vh, 720px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background-color: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    box-shadow: var(--tandem-shadow-3);
  }

  .modal-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tandem-space-4);
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--tandem-border);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--tandem-fg);
  }

  .modal-content {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 24px 24px;
  }

  .modal-content:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: -3px;
  }

  .shortcut-sections {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 22px 32px;
    align-items: start;
  }

  .shortcut-section {
    min-width: 0;
  }

  .shortcut-section h3 {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--tandem-fg-subtle);
  }

  .shortcut-rows {
    display: grid;
    grid-template-columns: minmax(112px, max-content) minmax(0, 1fr);
    gap: 7px 12px;
    align-items: center;
  }

  .shortcut-keys {
    font-size: 12px;
    font-family: var(--tandem-font-mono);
    white-space: nowrap;
  }

  .shortcut-keys kbd {
    display: inline-block;
    padding: 1px 6px;
    font: inherit;
    background: var(--tandem-surface-muted);
    border: 1px solid var(--tandem-border-strong);
    border-bottom-width: 2px;
    border-radius: var(--tandem-r-2);
    color: var(--tandem-fg);
    line-height: 1.5;
  }

  .shortcut-description {
    min-width: 0;
    font-size: 13px;
    color: var(--tandem-fg-muted);
  }

  .modal-footer {
    flex: 0 0 auto;
    padding: 10px 24px 12px;
    border-top: 1px solid var(--tandem-border);
    font-size: 11px;
    color: var(--tandem-fg-subtle);
    text-align: center;
    background: var(--tandem-surface);
  }

  .modal-footer kbd {
    font-size: 11px;
    padding: 1px 4px;
    background: var(--tandem-surface-muted);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-1);
    color: var(--tandem-fg-subtle);
  }

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

  @media (max-width: 680px) {
    .shortcut-modal {
      width: min(94vw, 520px);
      max-height: 88vh;
    }
    .modal-header,
    .modal-content,
    .modal-footer {
      padding-left: 16px;
      padding-right: 16px;
    }
    .shortcut-sections {
      grid-template-columns: minmax(0, 1fr);
      gap: 20px;
    }
  }
</style>
