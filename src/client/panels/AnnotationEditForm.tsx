import React from "react";

export interface AnnotationEditFormProps {
  annotationId: string;
  hasSuggestedText: boolean;
  editText: string;
  editNewText: string;
  editReason: string;
  textareaStyle: React.CSSProperties;
  onChangeEditText: (value: string) => void;
  onChangeEditNewText: (value: string) => void;
  onChangeEditReason: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function AnnotationEditForm({
  annotationId,
  hasSuggestedText,
  editText,
  editNewText,
  editReason,
  textareaStyle,
  onChangeEditText,
  onChangeEditNewText,
  onChangeEditReason,
  onKeyDown,
  onSave,
  onCancel,
}: AnnotationEditFormProps) {
  return (
    <div style={{ marginTop: "4px" }} onClick={(e) => e.stopPropagation()}>
      {hasSuggestedText ? (
        <>
          <label
            style={{
              fontSize: "11px",
              color: "var(--tandem-fg-muted)",
              display: "block",
              marginBottom: "2px",
            }}
          >
            Replacement text
          </label>
          <textarea
            data-testid={`edit-newtext-${annotationId}`}
            value={editNewText}
            onChange={(e) => onChangeEditNewText(e.target.value)}
            onKeyDown={onKeyDown}
            style={textareaStyle}
            autoFocus
          />
          <label
            style={{
              fontSize: "11px",
              color: "var(--tandem-fg-muted)",
              display: "block",
              marginTop: "4px",
              marginBottom: "2px",
            }}
          >
            Reason
          </label>
          <textarea
            data-testid={`edit-reason-${annotationId}`}
            value={editReason}
            onChange={(e) => onChangeEditReason(e.target.value)}
            onKeyDown={onKeyDown}
            style={textareaStyle}
          />
        </>
      ) : (
        <textarea
          data-testid={`edit-text-${annotationId}`}
          value={editText}
          onChange={(e) => onChangeEditText(e.target.value)}
          onKeyDown={onKeyDown}
          style={textareaStyle}
          autoFocus
        />
      )}
      <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
        <button
          data-testid={`edit-save-btn-${annotationId}`}
          onClick={(e) => {
            e.stopPropagation();
            onSave();
          }}
          style={{
            padding: "2px 8px",
            fontSize: "11px",
            border: "1px solid var(--tandem-border-strong)",
            borderRadius: "3px",
            background: "var(--tandem-success-bg)",
            color: "var(--tandem-success-fg-strong)",
            cursor: "pointer",
          }}
        >
          Save
        </button>
        <button
          data-testid={`edit-cancel-btn-${annotationId}`}
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          style={{
            padding: "2px 8px",
            fontSize: "11px",
            border: "1px solid var(--tandem-border-strong)",
            borderRadius: "3px",
            background: "var(--tandem-surface)",
            color: "var(--tandem-fg-muted)",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
