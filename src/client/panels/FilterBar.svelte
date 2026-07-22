<script lang="ts">
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import ChipGroup, { type ChipOption } from "./ChipGroup.svelte";

export type FilterType = "highlight" | "comment" | "note" | "all" | "with-replacement";
export type FilterAuthor = "all" | "claude" | "user" | "import";
export type FilterStatus = "all" | "pending" | "accepted" | "dismissed";

interface Props {
  filterType: FilterType;
  filterAuthor: FilterAuthor;
  filterStatus: FilterStatus;
  hasFilters: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onSetFilterType: (v: FilterType) => void;
  onSetFilterAuthor: (v: FilterAuthor) => void;
  onSetFilterStatus: (v: FilterStatus) => void;
  onClearFilters: () => void;
}

let {
  filterType,
  filterAuthor,
  filterStatus,
  hasFilters,
  open,
  onToggleOpen,
  onSetFilterType,
  onSetFilterAuthor,
  onSetFilterStatus,
  onClearFilters,
}: Props = $props();

const agentLabel = createAgentLabel();

// A15 (#798): the 3 native <select>s become compact icon-chip groups (REPLACE,
// canon decision 5). Reset chip = text; type/status = inline glyphs; author =
// authorship pips. `with-replacement`/accepted/dismissed glyphs carry their
// status color. Per-chip counts are deferred (would need SidePanel→FilterBar
// plumbing). Card collapse-out is already shipped via `cardExit` (A4/A10).
const typeOptions: ChipOption[] = [
  { value: "all", label: "All types", kind: "text" },
  { value: "highlight", label: "Highlights", kind: "icon", icon: "highlight" },
  { value: "comment", label: "Comments", kind: "icon", icon: "comment" },
  { value: "note", label: "Notes", kind: "icon", icon: "lock" },
  { value: "with-replacement", label: "With replacement", kind: "icon", icon: "sparkle" },
];

// $derived so the Claude chip's accessible name tracks the agent-label setting.
const authorOptions = $derived<ChipOption[]>([
  { value: "all", label: "Anyone", kind: "text" },
  { value: "claude", label: agentLabel.family, kind: "pip", pip: "claude" },
  { value: "user", label: "You", kind: "pip", pip: "user" },
  { value: "import", label: "Imported", kind: "pip", pip: "import" },
]);

const statusOptions: ChipOption[] = [
  { value: "all", label: "Any status", kind: "text" },
  { value: "pending", label: "Pending", kind: "icon", icon: "pending" },
  { value: "accepted", label: "Accepted", kind: "icon", icon: "check" },
  { value: "dismissed", label: "Dismissed", kind: "icon", icon: "dismiss" },
];
</script>

{#if open}
  <!-- Expanded full filter row -->
  <div
    style="padding: 8px 16px; border-bottom: 1px solid var(--tandem-border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center;"
  >
    <ChipGroup
      groupTestId="filter-type"
      groupAriaLabel="Filter by type"
      value={filterType}
      options={typeOptions}
      onSet={(v) => onSetFilterType(v as FilterType)}
    />
    <ChipGroup
      groupTestId="filter-author"
      groupAriaLabel="Filter by author"
      value={filterAuthor}
      options={authorOptions}
      onSet={(v) => onSetFilterAuthor(v as FilterAuthor)}
    />
    <ChipGroup
      groupTestId="filter-status"
      groupAriaLabel="Filter by status"
      value={filterStatus}
      options={statusOptions}
      onSet={(v) => onSetFilterStatus(v as FilterStatus)}
    />
    {#if hasFilters}
      <button
        data-testid="clear-filters-btn"
        onclick={onClearFilters}
        style="background: none; border: none; color: var(--tandem-accent); font-size: 11px; cursor: pointer; padding: 2px 4px;"
      >
        Clear
      </button>
    {/if}
    <button
      onclick={onToggleOpen}
      style="background: none; border: none; color: var(--tandem-fg-subtle); font-size: 10px; cursor: pointer; padding: 2px 4px; margin-left: auto;"
      aria-label="Collapse filters"
    >
      ▲
    </button>
  </div>
{/if}
