<script lang="ts">
import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
import { tabExit } from "../panels/cardMotion.js";
import type { OpenTab } from "../types.js";

interface Props {
  tab: OpenTab;
  isActive: boolean;
  onswitch: (id: string) => void;
  onclose: (id: string) => void;
  onpointerdown: (e: PointerEvent, id: string) => void;
  dropIndicator: "left" | "right" | null;
  onkeydown: (e: KeyboardEvent, id: string) => void;
  /** App reduce-motion setting; threaded from DocumentTabs (s3, #798). */
  reduceMotion?: boolean;
}

const {
  tab,
  isActive,
  onswitch,
  onclose,
  onpointerdown,
  dropIndicator,
  onkeydown,
  reduceMotion = false,
}: Props = $props();

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

// Derived styles. v7 floating chrome (Wave 4b minimal): drop the rectangular
// tab + accent-underline pattern in favor of a soft pill. Active tab gets a
// surface fill + subtle border; inactive tabs stay transparent. Drop-indicator
// borders are kept on left/right only (vertical wedges) — bottom underline
// removed since the pill no longer reads as a "tab attached to a strip".
const tabStyle = $derived(
  [
    "display: flex",
    "align-items: center",
    "gap: 6px",
    "padding: 0 10px 0 12px",
    "height: 26px",
    "font-size: var(--tandem-text-sm)",
    "cursor: pointer",
    `background: ${isActive ? "var(--tandem-surface)" : "transparent"}`,
    `color: ${isActive ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}`,
    `border: 1px solid ${isActive ? "var(--tandem-border)" : "transparent"}`,
    `border-left: ${dropIndicator === "left" ? "2px solid var(--tandem-accent)" : isActive ? "1px solid var(--tandem-border)" : "2px solid transparent"}`,
    `border-right: ${dropIndicator === "right" ? "2px solid var(--tandem-accent)" : isActive ? "1px solid var(--tandem-border)" : "2px solid transparent"}`,
    "border-radius: var(--tandem-r-pill)",
    `box-shadow: ${isActive ? "var(--tandem-shadow-1)" : "0 1px 3px rgba(0, 0, 0, 0.08)"}`,
    "user-select: none",
    "touch-action: none",
    "white-space: nowrap",
    "transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s",
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
  style={tabStyle}
  out:tabExit={{ reduceMotion }}
  onclick={() => onswitch(tab.id)}
  onpointerdown={(e) => onpointerdown(e, tab.id)}
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

  <span
    data-testid={`tab-name-${tab.id}`}
    title={tab.filePath}
    style={`font-weight: ${isActive ? 500 : 400}; min-width: 80px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`}
  >
    {tab.fileName}
  </span>

  {#if tab.readOnly}
    <span
      class="tab-ro-badge"
      aria-label="Read-only"
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
    onpointerdown={(e) => e.stopPropagation()}
    onmouseenter={handleMouseEnterClose}
    onmouseleave={handleMouseLeaveClose}
    style="background: none; border: none; cursor: pointer; font-size: var(--tandem-text-md); line-height: 1; color: var(--tandem-fg-muted); padding: 0 2px; border-radius: var(--tandem-r-1);"
    title="Close document"
    aria-label={`Close ${tab.fileName}`}
  >
    ×
  </button>
</div>

<style>
  .tab-ro-badge {
    font-family: var(--tandem-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tandem-fg-faint);
    background: color-mix(in srgb, var(--tandem-fg) 5%, transparent);
    padding: 1px 5px;
    border-radius: var(--tandem-r-1);
    flex-shrink: 0;
  }
</style>
