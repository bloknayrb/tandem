<script lang="ts">
import FilterSelect from "./FilterSelect.svelte";

export type FilterType = "highlight" | "comment" | "note" | "all" | "with-replacement";
export type FilterAuthor = "all" | "claude" | "user" | "import";
export type FilterStatus = "all" | "pending" | "accepted" | "dismissed";

interface Props {
  filterType: FilterType;
  filterAuthor: FilterAuthor;
  filterStatus: FilterStatus;
  hasFilters: boolean;
  open: boolean;
  totalCount: number;
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
  totalCount,
  onToggleOpen,
  onSetFilterType,
  onSetFilterAuthor,
  onSetFilterStatus,
  onClearFilters,
}: Props = $props();

const filterLabel = $derived.by(() => {
  if (!hasFilters) return "All";
  const parts: string[] = [];
  if (filterType !== "all") {
    const labels: Record<FilterType, string> = {
      all: "All",
      highlight: "Highlights",
      comment: "Comments",
      note: "Notes",
      "with-replacement": "With replacement",
    };
    parts.push(labels[filterType]);
  }
  if (filterAuthor !== "all") {
    const labels: Record<FilterAuthor, string> = {
      all: "Anyone",
      claude: "Claude",
      user: "You",
      import: "Imported",
    };
    parts.push(labels[filterAuthor]);
  }
  if (filterStatus !== "all") {
    const labels: Record<FilterStatus, string> = {
      all: "Any status",
      pending: "Pending",
      accepted: "Accepted",
      dismissed: "Dismissed",
    };
    parts.push(labels[filterStatus]);
  }
  return parts.join(" · ") || "All";
});
</script>

{#if !open}
  <!-- Collapsed summary chip -->
  <div style="padding: 6px 16px; border-bottom: 1px solid var(--tandem-border);">
    <button
      data-testid="filter-bar-toggle"
      onclick={onToggleOpen}
      style="display: flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-pill); padding: 3px 10px; font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle); cursor: pointer; white-space: nowrap;"
    >
      <span>{filterLabel} {totalCount}</span>
      <span style="font-size: 9px; opacity: 0.7;">▾</span>
      <span>Filter</span>
    </button>
  </div>
{:else}
  <!-- Expanded full filter row -->
  <div
    style="padding: 8px 16px; border-bottom: 1px solid var(--tandem-border); display: flex; gap: 4px; flex-wrap: wrap; align-items: center;"
  >
    <FilterSelect
      testId="filter-type"
      ariaLabel="Filter by type"
      value={filterType}
      onChange={(v) => onSetFilterType(v as FilterType)}
      options={[
        { value: "all", label: "All types" },
        { value: "highlight", label: "Highlights" },
        { value: "comment", label: "Comments" },
        { value: "note", label: "Notes" },
        { value: "with-replacement", label: "With replacement" },
      ]}
    />
    <FilterSelect
      testId="filter-author"
      ariaLabel="Filter by author"
      value={filterAuthor}
      onChange={(v) => onSetFilterAuthor(v as FilterAuthor)}
      options={[
        { value: "all", label: "Anyone" },
        { value: "claude", label: "Claude" },
        { value: "user", label: "You" },
        { value: "import", label: "Imported" },
      ]}
    />
    <FilterSelect
      testId="filter-status"
      ariaLabel="Filter by status"
      value={filterStatus}
      onChange={(v) => onSetFilterStatus(v as FilterStatus)}
      options={[
        { value: "all", label: "Any status" },
        { value: "pending", label: "Pending" },
        { value: "accepted", label: "Accepted" },
        { value: "dismissed", label: "Dismissed" },
      ]}
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
