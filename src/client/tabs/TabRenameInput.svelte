<script lang="ts">
import { untrack } from "svelte";

// Inline tab-rename editor (#1017). Mounted ONLY while a tab is being renamed
// (behind `{#if isRenaming}` in TabItem), which is why a fresh `$state(initial)`
// seed and a `use:` focus action work cleanly here: the component is constructed
// at edit-start, so `value` is seeded synchronously and the action focuses the
// real input node the moment it renders. (A plain effect/onMount inside the
// always-mounted TabItem would miss the conditionally-rendered node — see the
// #1017 Svelte review.)

interface Props {
  initial: string;
  testId: string;
  oncommit: (value: string) => void;
  oncancel: () => void;
}
const { initial, testId, oncommit, oncancel }: Props = $props();

// Seed once from the prop. `untrack` documents the intent and silences the
// `state_referenced_locally` warning: this component is remounted per edit
// (behind {#if isRenaming}), so capturing `initial` at construction IS the
// contract — there is no later `initial` change to track within one edit.
let value = $state(untrack(() => initial));

// Plain (non-reactive) latch: Enter/Escape flip the parent state, the input then
// unmounts, and its trailing `blur` would fire a SECOND finish() — commit then
// cancel. `done` swallows the second call so the first one wins. The component is
// short-lived (remounted per edit), so the latch needs no reset.
let done = false;

function finish(commit: boolean) {
  if (done) return;
  done = true;
  const next = value.trim();
  if (commit && next.length > 0 && next !== initial) {
    oncommit(next);
  } else {
    oncancel();
  }
}

// Focus the input and select the filename STEM (everything before the final dot),
// leaving the extension — the common case is editing the name, not the type.
function focusSelectStem(node: HTMLInputElement) {
  node.focus();
  const dot = initial.lastIndexOf(".");
  node.setSelectionRange(0, dot > 0 ? dot : initial.length);
}

function onKeydown(e: KeyboardEvent) {
  // Stop every key from bubbling to the tab's onkeydown (arrow reorder) and the
  // app-level keydown dispatcher while editing.
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    finish(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    finish(false);
  }
}
</script>

<input
  bind:value
  use:focusSelectStem
  data-testid={testId}
  type="text"
  spellcheck="false"
  autocomplete="off"
  aria-label="Rename file"
  onkeydown={onKeydown}
  onblur={() => finish(false)}
  onpointerdown={(e) => e.stopPropagation()}
  onclick={(e) => e.stopPropagation()}
  ondblclick={(e) => e.stopPropagation()}
  style="min-width: 80px; max-width: 160px; font-size: var(--tandem-text-sm); padding: 0 4px; height: 20px; border: 1px solid var(--tandem-accent); border-radius: var(--tandem-r-1); background: var(--tandem-bg); color: var(--tandem-fg); outline: none;"
/>
