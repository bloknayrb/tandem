<script lang="ts">
import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
import type { OpenTab } from "../types.js";

interface Props {
  tab: OpenTab;
  isActive: boolean;
  onswitch: (id: string) => void;
  onclose: (id: string) => void;
  draggable: boolean;
  ondragstart: (e: DragEvent, id: string) => void;
  ondragover: (e: DragEvent, id: string) => void;
  ondrop: (e: DragEvent, id: string) => void;
  ondragend: () => void;
  ondragleave: () => void;
  dropIndicator: "left" | "right" | null;
  onkeydown: (e: KeyboardEvent, id: string) => void;
}

const {
  tab,
  isActive,
  onswitch,
  onclose,
  draggable,
  ondragstart,
  ondragover,
  ondrop,
  ondragend,
  ondragleave,
  dropIndicator,
  onkeydown,
}: Props = $props();

const FORMAT_LABELS: Record<string, string> = {
  md: "MD",
  txt: "TXT",
  html: "HTML",
  docx: "DOCX",
};

const FORMAT_COLORS: Record<string, string> = {
  md: "var(--tandem-accent)",
  txt: "var(--tandem-fg-faint)",
  html: "var(--tandem-info-fg)",
  docx: "var(--tandem-suggestion-fg-strong)",
};

// ---- useTabDirty logic inlined (hooks can't be imported into Svelte) ----
let dirty = $state(false);
// These don't drive UI; plain let keeps them non-reactive
let editCount = 0;
let baseline: number | null = null;

$effect(() => {
  // Track tab.ydoc and tab.readOnly
  const { ydoc, readOnly } = tab;

  if (readOnly) {
    dirty = false;
    return;
  }

  const fragment = ydoc.getXmlFragment("default");
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);

  let armed = false;
  const armTimer = setTimeout(() => {
    armed = true;
    baseline = (meta.get(Y_MAP_SAVED_AT_VERSION) as number) ?? 0;
    editCount = 0;
    dirty = false;
  }, 500);

  const onFragmentChange = () => {
    if (!armed) return;
    editCount++;
    dirty = true;
  };
  fragment.observeDeep(onFragmentChange);

  const onMetaChange = () => {
    if (!armed) return;
    const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
    if (saved !== undefined && saved !== baseline) {
      baseline = saved;
      editCount = 0;
      dirty = false;
    }
  };
  meta.observe(onMetaChange);

  return () => {
    clearTimeout(armTimer);
    fragment.unobserveDeep(onFragmentChange);
    meta.unobserve(onMetaChange);
  };
});

// Derived styles
const tabStyle = $derived(
  [
    "display: flex",
    "align-items: center",
    "gap: 8px",
    "padding: 0 12px",
    "height: 100%",
    "font-size: var(--tandem-text-sm)",
    "cursor: pointer",
    `background: ${isActive ? "var(--tandem-surface)" : "transparent"}`,
    `color: ${isActive ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}`,
    "border-top: 0",
    `border-bottom: ${isActive ? "2px solid var(--tandem-accent)" : "2px solid transparent"}`,
    `border-left: ${dropIndicator === "left" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}`,
    `border-right: ${dropIndicator === "right" ? "2px solid var(--tandem-accent)" : "2px solid transparent"}`,
    "margin-bottom: -1px",
    "user-select: none",
    "white-space: nowrap",
    "transition: background 0.15s, color 0.15s, border-color 0.15s",
    "flex-shrink: 0",
  ].join("; "),
);

let closeBtn: HTMLButtonElement | undefined = $state();

function handleMouseEnterClose() {
  if (closeBtn) closeBtn.style.color = "var(--tandem-error)";
}
function handleMouseLeaveClose() {
  if (closeBtn) closeBtn.style.color = "var(--tandem-fg-muted)";
}
</script>

<!--
  The WAI-ARIA APG closable tabs pattern places the close button inside role="tab".
  axe's nested-interactive rule fires on this pattern; it is suppressed in the a11y spec
  with justification (see tests/e2e/accessibility.spec.ts).
-->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  data-testid={`tab-${tab.id}`}
  data-active={isActive}
  role="tab"
  tabindex={0}
  aria-selected={isActive}
  aria-label={tab.fileName}
  {draggable}
  style={tabStyle}
  onclick={() => onswitch(tab.id)}
  ondragstart={(e) => ondragstart(e, tab.id)}
  ondragover={(e) => ondragover(e, tab.id)}
  ondrop={(e) => ondrop(e, tab.id)}
  ondragend={ondragend}
  ondragleave={ondragleave}
  onkeydown={(e) => onkeydown(e, tab.id)}
>
  <!-- Stable slot: always in layout, hidden when clean to prevent tab-width shift -->
  <span
    data-testid={`unsaved-indicator-${tab.id}`}
    style={`color: var(--tandem-warning); font-size: 10px; visibility: ${dirty ? "visible" : "hidden"};`}
    aria-hidden={!dirty}
  >
    ●
  </span>

  <!-- Format badge: decorative pill; file name is the accessible label via aria-label on the tab -->
  <span
    data-testid={`tab-format-badge-${tab.id}`}
    aria-label={`Format: ${tab.format}`}
    style={`font-family: var(--tandem-font-mono); font-size: 9px; font-weight: 600; letter-spacing: 0.03em; color: ${FORMAT_COLORS[tab.format] ?? "var(--tandem-fg-faint)"}; background: transparent; padding: 1px 4px; border: 1px solid ${FORMAT_COLORS[tab.format] ?? "var(--tandem-fg-faint)"}; border-radius: var(--tandem-r-pill); opacity: ${isActive ? 1 : 0.6}; white-space: nowrap;`}
  >
    {FORMAT_LABELS[tab.format] ?? tab.format.toUpperCase()}
  </span>

  <span
    data-testid={`tab-name-${tab.id}`}
    title={tab.filePath}
    style={`font-weight: ${isActive ? 500 : 400}; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`}
  >
    {tab.fileName}
  </span>

  {#if tab.readOnly}
    <span
      style="font-family: var(--tandem-font-mono); font-size: var(--tandem-text-2xs); color: var(--tandem-warning-fg-strong); background: var(--tandem-warning-bg); border: 1px solid var(--tandem-warning-border); padding: 0 4px; border-radius: var(--tandem-r-pill);"
    >
      RO
    </span>
  {/if}

  <button
    bind:this={closeBtn}
    onclick={(e) => {
      e.stopPropagation();
      onclose(tab.id);
    }}
    ondragover={(e) => {
      e.stopPropagation();
      e.preventDefault();
    }}
    ondrop={(e) => {
      e.stopPropagation();
      e.preventDefault();
    }}
    onmouseenter={handleMouseEnterClose}
    onmouseleave={handleMouseLeaveClose}
    style="background: none; border: none; cursor: pointer; font-size: var(--tandem-text-md); line-height: 1; color: var(--tandem-fg-muted); padding: 0 2px; border-radius: var(--tandem-r-1);"
    title="Close document"
    aria-label={`Close ${tab.fileName}`}
  >
    ×
  </button>
</div>
