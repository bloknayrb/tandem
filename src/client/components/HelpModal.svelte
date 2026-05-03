<script lang="ts">
interface ShortcutRow {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: "Editor",
    rows: [
      { keys: ["Ctrl", "B"], description: "Bold" },
      { keys: ["Ctrl", "I"], description: "Italic" },
      { keys: ["Ctrl", "Z"], description: "Undo" },
      { keys: ["Ctrl", "Y"], description: "Redo" },
      { keys: ["Ctrl", "S"], description: "Save document" },
    ],
  },
  {
    title: "Review Mode",
    rows: [
      { keys: ["Tab"], description: "Next annotation" },
      { keys: ["Shift", "Tab"], description: "Previous annotation" },
      { keys: ["Y"], description: "Accept annotation" },
      { keys: ["N"], description: "Reject annotation" },
      { keys: ["Z"], description: "Undo last accept/reject" },
      { keys: ["E"], description: "Examine (scroll & exit)" },
      { keys: ["Escape"], description: "Exit review mode" },
    ],
  },
  {
    title: "Chat",
    rows: [{ keys: ["Enter"], description: "Send message" }],
  },
  {
    title: "Tabs",
    rows: [
      { keys: ["Ctrl", "Tab"], description: "Next tab" },
      { keys: ["Ctrl", "Shift", "Tab"], description: "Previous tab" },
      { keys: ["Alt", "←"], description: "Move tab left" },
      { keys: ["Alt", "→"], description: "Move tab right" },
    ],
  },
  {
    title: "General",
    rows: [{ keys: ["?"], description: "Show / hide this help" }],
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

let { open, onClose }: Props = $props();

$effect(() => {
  if (!open) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});
</script>

{#if open}
  <div
    role="presentation"
    style="position: fixed; inset: 0; background-color: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 1000;"
    onclick={onClose}
    data-testid="help-modal"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
      tabindex="-1"
      style="background-color: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); padding: 24px 28px 20px; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto; position: relative;"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div
        style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;"
      >
        <h2 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--tandem-fg);">
          Keyboard Shortcuts
        </h2>
        <button
          type="button"
          onclick={onClose}
          aria-label="Close help"
          data-testid="help-modal-close"
          style="background: none; border: none; cursor: pointer; font-size: 18px; color: var(--tandem-fg-muted); line-height: 1; padding: 2px 6px; border-radius: 4px;"
        >
          ✕
        </button>
      </div>

      {#each SECTIONS as section (section.title)}
        <div style="margin-bottom: 18px;">
          <div
            style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--tandem-fg-subtle); margin-bottom: 6px;"
          >
            {section.title}
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <tbody>
              {#each section.rows as row (row.description)}
                <tr>
                  <td style="padding-bottom: 5px; padding-right: 16px; white-space: nowrap; vertical-align: middle; width: 1%;">
                    <span style="display: flex; gap: 4px; align-items: center;">
                      {#each row.keys as key, i (key)}
                        <span>
                          <kbd
                            style="display: inline-block; padding: 1px 6px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border-strong); border-bottom: 2px solid var(--tandem-border-strong); border-radius: 4px; color: var(--tandem-fg); line-height: 1.5;"
                          >
                            {key}
                          </kbd>
                          {#if i < row.keys.length - 1}
                            <span style="color: var(--tandem-fg-subtle); font-size: 11px; margin: 0 2px;">
                              +
                            </span>
                          {/if}
                        </span>
                      {/each}
                    </span>
                  </td>
                  <td style="padding-bottom: 5px; font-size: 13px; color: var(--tandem-fg-muted); vertical-align: middle;">
                    {row.description}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/each}

      <div
        style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--tandem-border); font-size: 11px; color: var(--tandem-fg-subtle); text-align: center;"
      >
        Press
        <kbd style="font-size: 11px; padding: 1px 4px; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border); border-radius: 3px; color: var(--tandem-fg-subtle);">
          ?
        </kbd>
        or
        <kbd style="font-size: 11px; padding: 1px 4px; background: var(--tandem-surface-muted); border: 1px solid var(--tandem-border); border-radius: 3px; color: var(--tandem-fg-subtle);">
          Esc
        </kbd>
        to close
      </div>
    </div>
  </div>
{/if}
