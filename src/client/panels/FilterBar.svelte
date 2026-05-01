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
    onSetFilterType,
    onSetFilterAuthor,
    onSetFilterStatus,
    onClearFilters,
  }: Props = $props();
</script>

<div
  style="padding: 8px 16px; border-bottom: 1px solid var(--tandem-border); display: flex; gap: 4px; flex-wrap: wrap; align-items: center;"
>
  <FilterSelect
    testId="filter-type"
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
</div>
