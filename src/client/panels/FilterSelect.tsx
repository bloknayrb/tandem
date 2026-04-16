export interface FilterSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  testId?: string;
}

export function FilterSelect({ value, onChange, options, testId }: FilterSelectProps) {
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "2px 4px",
        fontSize: "11px",
        border: "1px solid var(--tandem-border-strong)",
        borderRadius: "3px",
        background: "var(--tandem-surface)",
        color: "var(--tandem-fg)",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
