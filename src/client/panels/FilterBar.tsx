import { FilterSelect } from "./FilterSelect";

export type FilterType =
  | "highlight"
  | "comment"
  | "flag"
  | "all"
  | "with-replacement"
  | "for-claude";
export type FilterAuthor = "all" | "claude" | "user" | "import";
export type FilterStatus = "all" | "pending" | "accepted" | "dismissed";

interface FilterBarProps {
  filterType: FilterType;
  setFilterType: (v: FilterType) => void;
  filterAuthor: FilterAuthor;
  setFilterAuthor: (v: FilterAuthor) => void;
  filterStatus: FilterStatus;
  setFilterStatus: (v: FilterStatus) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
}

export function FilterBar({
  filterType,
  setFilterType,
  filterAuthor,
  setFilterAuthor,
  filterStatus,
  setFilterStatus,
  hasFilters,
  onClearFilters,
}: FilterBarProps) {
  return (
    <div
      style={{
        padding: "8px 16px",
        borderBottom: "1px solid var(--tandem-border)",
        display: "flex",
        gap: "4px",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <FilterSelect
        testId="filter-type"
        value={filterType}
        onChange={(v) => setFilterType(v as FilterType)}
        options={[
          { value: "all", label: "All types" },
          { value: "highlight", label: "Highlights" },
          { value: "comment", label: "Comments" },
          { value: "with-replacement", label: "With replacement" },
          { value: "for-claude", label: "For Claude" },
          { value: "flag", label: "Flags" },
        ]}
      />
      <FilterSelect
        testId="filter-author"
        value={filterAuthor}
        onChange={(v) => setFilterAuthor(v as FilterAuthor)}
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
        onChange={(v) => setFilterStatus(v as FilterStatus)}
        options={[
          { value: "all", label: "Any status" },
          { value: "pending", label: "Pending" },
          { value: "accepted", label: "Accepted" },
          { value: "dismissed", label: "Dismissed" },
        ]}
      />
      {hasFilters && (
        <button
          data-testid="clear-filters-btn"
          onClick={onClearFilters}
          style={{
            background: "none",
            border: "none",
            color: "var(--tandem-accent)",
            fontSize: "11px",
            cursor: "pointer",
            padding: "2px 4px",
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
