import React from "react";
import { ToolbarButton } from "./ToolbarButton";

interface InputGroupProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder: string;
  submitLabel: string;
  borderColor: string;
  canSubmit: boolean;
  secondaryInput?: React.ReactNode;
}

/** Reusable inline input group for comment/question/suggest modes */
export function InputGroup({
  inputRef,
  value,
  onChange,
  onKeyDown,
  onSubmit,
  onCancel,
  placeholder,
  submitLabel,
  borderColor,
  canSubmit,
  secondaryInput,
}: InputGroupProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{
          padding: "3px 8px",
          fontSize: "13px",
          border: `1px solid ${borderColor}`,
          borderRadius: "4px",
          outline: "none",
          minWidth: "120px",
          flex: "1 1 200px",
        }}
      />
      {secondaryInput}
      <ToolbarButton label={submitLabel} disabled={!canSubmit} onClick={onSubmit} />
      <ToolbarButton label="Cancel" disabled={false} onClick={onCancel} />
    </div>
  );
}
