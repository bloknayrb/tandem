import type { Editor as TiptapEditor } from "@tiptap/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import { toPmPos } from "../../../shared/positions/types";
import type { Annotation, AnnotationType, HighlightColor, TandemMode } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { pmPosToFlatOffset } from "../../positions";
import { FormattingToolbar } from "./FormattingToolbar";
import { HighlightColorPicker } from "./HighlightColorPicker";
import { InputGroup } from "./InputGroup";
import { ModeToggle } from "./ModeToggle";
import { ToolbarButton } from "./ToolbarButton";

type ToolbarMode = "idle" | "comment";

interface ToolbarProps {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  onSettingsOpen?: () => void;
  /** Forwarded ref for the settings gear button — needed so a keyboard shortcut
   * can anchor the popover and so focus can return here when it closes. */
  settingsBtnRef?: React.RefObject<HTMLButtonElement | null>;
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  heldCount?: number;
}

export function Toolbar({
  editor,
  ydoc,
  onSettingsOpen,
  settingsBtnRef,
  tandemMode,
  onModeChange,
  heldCount,
}: ToolbarProps) {
  const [hasSelection, setHasSelection] = useState(false);
  const [mode, setMode] = useState<ToolbarMode>("idle");
  const [modeText, setModeText] = useState("");
  const capturedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor) return;
    const ed = editor;

    function onSelectionUpdate() {
      const { from, to } = ed.state.selection;
      const next = from !== to;
      setHasSelection((prev) => (prev === next ? prev : next));
    }

    editor.on("selectionUpdate", onSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", onSelectionUpdate);
    };
  }, [editor]);

  useEffect(() => {
    if (mode === "comment" && commentInputRef.current) {
      commentInputRef.current.focus();
    }
  }, [mode]);

  function createAnnotation(
    type: AnnotationType,
    content: string,
    extras?: { color?: HighlightColor },
  ) {
    if (!editor || !ydoc) return;

    const range = capturedRangeRef.current ?? editor.state.selection;
    const { from, to } = range;
    if (from === to) return;

    const flatFrom = pmPosToFlatOffset(editor.state.doc, toPmPos(from));
    const flatTo = pmPosToFlatOffset(editor.state.doc, toPmPos(to));

    const id = generateAnnotationId();
    const annotation = {
      id,
      author: "user" as const,
      type,
      range: { from: flatFrom, to: flatTo },
      content,
      status: "pending" as const,
      timestamp: Date.now(),
      ...(extras?.color ? { color: extras.color } : {}),
    } as Annotation;

    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, annotation);
    capturedRangeRef.current = null;
  }

  function captureSelectionRange() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    capturedRangeRef.current = { from, to };
  }

  function resetAndFocusEditor() {
    capturedRangeRef.current = null;
    editor?.chain().focus().run();
  }

  const inInputMode = mode !== "idle";

  // -- Highlight --

  function handleHighlight(color: HighlightColor) {
    createAnnotation("highlight", "", { color });
  }

  // -- Consolidated mode handlers --

  const handleModeStart = useCallback(
    (targetMode: ToolbarMode) => {
      return (e: React.MouseEvent) => {
        e.preventDefault();
        captureSelectionRange();
        setMode(targetMode);
        setModeText("");
      };
    },
    [editor],
  );

  const startComment = useMemo(() => handleModeStart("comment"), [handleModeStart]);

  function handleModeCancel() {
    setMode("idle");
    setModeText("");
    resetAndFocusEditor();
  }

  function handleModeSubmit() {
    if (!modeText.trim()) {
      handleModeCancel();
      return;
    }

    createAnnotation("comment", modeText.trim());

    setMode("idle");
    setModeText("");
    editor?.chain().focus().run();
  }

  function handleModeKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleModeSubmit();
    } else if (e.key === "Escape") {
      handleModeCancel();
    }
  }

  // -- Flag --

  function handleFlag(e: React.MouseEvent) {
    e.preventDefault();
    createAnnotation("flag", "");
  }

  const canAnnotate = editor && ydoc && hasSelection;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px",
        minHeight: "42px",
        padding: "8px 16px",
        borderBottom: "1px solid var(--tandem-border)",
        background: "var(--tandem-surface-muted)",
        userSelect: "none",
      }}
    >
      <span
        style={{
          fontWeight: 700,
          fontSize: "15px",
          color: "var(--tandem-accent)",
          letterSpacing: "-0.02em",
        }}
      >
        Tandem
      </span>
      <div
        style={{
          width: "1px",
          height: "20px",
          background: "var(--tandem-border)",
          margin: "0 8px",
        }}
      />

      <FormattingToolbar editor={editor} disabled={inInputMode} />

      {/* Divider between formatting and annotation sections */}
      <div
        style={{
          width: "1px",
          height: "20px",
          background: "var(--tandem-border)",
          margin: "0 8px",
        }}
      />

      {/* Highlight with color picker */}
      <HighlightColorPicker disabled={!canAnnotate || inInputMode} onHighlight={handleHighlight} />

      <ToolbarButton
        label="Comment"
        disabled={!canAnnotate || inInputMode}
        disabledTitle="Select text first"
        onMouseDown={startComment}
      />
      {mode === "comment" && (
        <InputGroup
          inputRef={commentInputRef}
          value={modeText}
          onChange={setModeText}
          onKeyDown={handleModeKeyDown}
          onSubmit={handleModeSubmit}
          onCancel={handleModeCancel}
          placeholder="Add a comment..."
          submitLabel="Add"
          borderColor="var(--tandem-author-user)"
          canSubmit={!!modeText.trim()}
        />
      )}

      <ToolbarButton label="Flag" disabled={!canAnnotate || inInputMode} onMouseDown={handleFlag} />

      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {/* heldCount badge */}
        {(heldCount ?? 0) > 0 && (
          <span
            data-testid="held-badge"
            style={{
              padding: "1px 6px",
              fontSize: "10px",
              fontWeight: 600,
              color: "var(--tandem-warning-fg-strong)",
              background: "var(--tandem-warning-bg)",
              borderRadius: "9999px",
            }}
          >
            {heldCount} held
          </span>
        )}
        {/* Solo/Tandem mode toggle */}
        {tandemMode && onModeChange && (
          <ModeToggle tandemMode={tandemMode} onModeChange={onModeChange} />
        )}
        {onSettingsOpen && (
          <button
            ref={settingsBtnRef}
            data-testid="settings-btn"
            onClick={onSettingsOpen}
            title="Settings (Ctrl+,)"
            aria-label="Settings"
            aria-keyshortcuts="Control+Comma"
            style={{
              background: "none",
              border: "1px solid var(--tandem-border-strong)",
              borderRadius: "4px",
              cursor: "pointer",
              color: "var(--tandem-fg-muted)",
              fontSize: "13px",
              padding: "4px 12px",
              minHeight: "24px",
            }}
          >
            Settings
          </button>
        )}
      </div>
    </div>
  );
}
