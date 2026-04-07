import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import * as Y from "yjs";
import { pmPosToFlatOffset } from "../../positions";
import { toPmPos } from "../../../shared/positions/types";
import { generateAnnotationId } from "../../../shared/utils";
import { HIGHLIGHT_COLORS, Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import type { Annotation, AnnotationType, HighlightColor, TandemMode } from "../../../shared/types";
import { InputGroup } from "./InputGroup";
import { ToolbarButton } from "./ToolbarButton";
import { FormattingToolbar } from "./FormattingToolbar";

const HIGHLIGHT_COLOR_OPTIONS: Array<{ value: HighlightColor; label: string }> = [
  { value: "yellow", label: "Yellow" },
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "purple", label: "Purple" },
];

type ToolbarMode = "idle" | "comment" | "suggest" | "askClaude";

interface ToolbarProps {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  onSettingsClick?: (rect: DOMRect) => void;
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  heldCount?: number;
}

export function Toolbar({
  editor,
  ydoc,
  onSettingsClick,
  tandemMode,
  onModeChange,
  heldCount,
}: ToolbarProps) {
  const [hasSelection, setHasSelection] = useState(false);
  const [highlightColor, setHighlightColor] = useState<HighlightColor>("yellow");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [mode, setMode] = useState<ToolbarMode>("idle");
  const [modeText, setModeText] = useState("");
  const [modeReason, setModeReason] = useState(""); // used by suggest mode only
  const capturedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const suggestInputRef = useRef<HTMLInputElement>(null);
  const askClaudeInputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

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
    if (mode === "idle") return;
    const refMap: Record<Exclude<ToolbarMode, "idle">, React.RefObject<HTMLInputElement | null>> = {
      comment: commentInputRef,
      suggest: suggestInputRef,
      askClaude: askClaudeInputRef,
    };
    const ref = refMap[mode];
    if (ref.current) {
      ref.current.focus();
    }
  }, [mode]);

  // Close color picker when clicking outside
  useEffect(() => {
    if (!showColorPicker) return;

    function handleClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showColorPicker]);

  function createAnnotation(type: AnnotationType, content: string, color?: HighlightColor) {
    if (!editor || !ydoc) return;

    const range = capturedRangeRef.current ?? editor.state.selection;
    const { from, to } = range;
    if (from === to) return;

    const flatFrom = pmPosToFlatOffset(editor.state.doc, toPmPos(from));
    const flatTo = pmPosToFlatOffset(editor.state.doc, toPmPos(to));

    const id = generateAnnotationId();
    const annotation: Annotation = {
      id,
      author: "user",
      type,
      range: { from: flatFrom, to: flatTo },
      content,
      status: "pending",
      timestamp: Date.now(),
      ...(color ? { color } : {}),
    };

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

  function handleHighlight(e: React.MouseEvent) {
    e.preventDefault();
    createAnnotation("highlight", "", highlightColor);
  }

  function handleColorPickerToggle(e: React.MouseEvent) {
    e.preventDefault();
    setShowColorPicker((prev) => !prev);
  }

  function handleColorSelect(color: HighlightColor) {
    setHighlightColor(color);
    setShowColorPicker(false);
  }

  // -- Consolidated mode handlers --

  const handleModeStart = useCallback(
    (targetMode: ToolbarMode) => {
      return (e: React.MouseEvent) => {
        e.preventDefault();
        captureSelectionRange();
        setMode(targetMode);
        setModeText("");
        setModeReason("");
      };
    },
    [editor],
  );

  const startComment = useMemo(() => handleModeStart("comment"), [handleModeStart]);
  const startSuggest = useMemo(() => handleModeStart("suggest"), [handleModeStart]);
  const startAskClaude = useMemo(() => handleModeStart("askClaude"), [handleModeStart]);

  function handleModeCancel() {
    setMode("idle");
    setModeText("");
    setModeReason("");
    resetAndFocusEditor();
  }

  function handleModeSubmit() {
    if (!modeText.trim()) {
      handleModeCancel();
      return;
    }

    switch (mode) {
      case "comment":
        createAnnotation("comment", modeText.trim());
        break;
      case "suggest":
        createAnnotation(
          "suggestion",
          JSON.stringify({ newText: modeText.trim(), reason: modeReason.trim() }),
        );
        break;
      case "askClaude":
        createAnnotation("question", modeText.trim());
        break;
    }

    setMode("idle");
    setModeText("");
    setModeReason("");
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
        borderBottom: "1px solid #e5e7eb",
        background: "#fafafa",
        userSelect: "none",
      }}
    >
      <span
        style={{ fontWeight: 700, fontSize: "15px", color: "#6366f1", letterSpacing: "-0.02em" }}
      >
        Tandem
      </span>
      <div style={{ width: "1px", height: "20px", background: "#e5e7eb", margin: "0 8px" }} />

      <FormattingToolbar editor={editor} disabled={inInputMode} />

      {/* Divider between formatting and annotation sections */}
      <div style={{ width: "1px", height: "20px", background: "#e5e7eb", margin: "0 8px" }} />

      {/* Highlight with color picker */}
      <div style={{ display: "flex", alignItems: "center", gap: "2px", position: "relative" }}>
        <ToolbarButton
          label="Highlight"
          disabled={!canAnnotate || inInputMode}
          disabledTitle="Select text first"
          onMouseDown={handleHighlight}
          style={{ borderRadius: "4px 0 0 4px", borderRight: "none" }}
        />
        <button
          disabled={!canAnnotate || inInputMode}
          onMouseDown={handleColorPickerToggle}
          title="Choose highlight color"
          style={{
            padding: "4px 6px",
            fontSize: "13px",
            border: "1px solid #e5e7eb",
            borderRadius: "0 4px 4px 0",
            background: !canAnnotate || inInputMode ? "#f9fafb" : "#fff",
            cursor: !canAnnotate || inInputMode ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: "12px",
              height: "12px",
              borderRadius: "2px",
              background: HIGHLIGHT_COLORS[highlightColor],
              border: "1px solid rgba(0,0,0,0.15)",
            }}
          />
        </button>
        {showColorPicker && (
          <div
            ref={colorPickerRef}
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: "4px",
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: "6px",
              padding: "6px",
              display: "flex",
              gap: "4px",
              zIndex: 10,
              boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            }}
          >
            {HIGHLIGHT_COLOR_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                title={label}
                onClick={() => handleColorSelect(value)}
                style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "4px",
                  border:
                    value === highlightColor ? "2px solid #374151" : "1px solid rgba(0,0,0,0.15)",
                  background: HIGHLIGHT_COLORS[value],
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
            <button
              data-testid="color-picker-close"
              title="Close"
              onClick={() => setShowColorPicker(false)}
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "4px",
                border: "1px solid rgba(0,0,0,0.15)",
                background: "#f3f4f6",
                cursor: "pointer",
                padding: 0,
                fontSize: "13px",
                color: "#6b7280",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

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
          borderColor="#3b82f6"
          canSubmit={!!modeText.trim()}
        />
      )}

      <ToolbarButton
        label="Suggest"
        disabled={!canAnnotate || inInputMode}
        disabledTitle="Select text first"
        onMouseDown={startSuggest}
      />
      {mode === "suggest" && (
        <InputGroup
          inputRef={suggestInputRef}
          value={modeText}
          onChange={setModeText}
          onKeyDown={handleModeKeyDown}
          onSubmit={handleModeSubmit}
          onCancel={handleModeCancel}
          placeholder="Replacement text..."
          submitLabel="Suggest"
          borderColor="#8b5cf6"
          canSubmit={!!modeText.trim()}
          secondaryInput={
            <input
              type="text"
              value={modeReason}
              onChange={(e) => setModeReason(e.target.value)}
              onKeyDown={handleModeKeyDown}
              placeholder="Reason (optional)"
              style={{
                padding: "3px 8px",
                fontSize: "13px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                outline: "none",
                minWidth: "100px",
                flex: "1 1 140px",
              }}
            />
          }
        />
      )}

      <ToolbarButton label="Flag" disabled={!canAnnotate || inInputMode} onMouseDown={handleFlag} />

      <ToolbarButton
        label="Ask Claude"
        shortcut="Ctrl+Shift+A"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={startAskClaude}
      />
      {mode === "askClaude" && (
        <InputGroup
          inputRef={askClaudeInputRef}
          value={modeText}
          onChange={setModeText}
          onKeyDown={handleModeKeyDown}
          onSubmit={handleModeSubmit}
          onCancel={handleModeCancel}
          placeholder="Ask about this text..."
          submitLabel="Ask"
          borderColor="#6366f1"
          canSubmit={!!modeText.trim()}
        />
      )}

      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {/* heldCount badge */}
        {(heldCount ?? 0) > 0 && (
          <span
            style={{
              padding: "1px 6px",
              fontSize: "10px",
              fontWeight: 600,
              color: "#92400e",
              background: "#fef3c7",
              borderRadius: "9999px",
            }}
          >
            {heldCount} held
          </span>
        )}
        {/* Solo/Tandem mode toggle */}
        {tandemMode && onModeChange && (
          <div
            role="group"
            aria-label="Claude collaboration mode"
            style={{
              display: "flex",
              border: "1px solid #d1d5db",
              borderRadius: "4px",
              overflow: "hidden",
            }}
          >
            <button
              title="Write undisturbed — Claude only responds when you message"
              aria-pressed={tandemMode === "solo"}
              onClick={() => onModeChange("solo")}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "none",
                cursor: "pointer",
                background: tandemMode === "solo" ? "#6366f1" : "transparent",
                color: tandemMode === "solo" ? "#fff" : "#6b7280",
                fontWeight: tandemMode === "solo" ? 600 : 400,
                borderRight: "1px solid #d1d5db",
                display: "flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              {tandemMode === "solo" && (
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: "#9ca3af",
                    display: "inline-block",
                  }}
                />
              )}
              Solo
            </button>
            <button
              title="Full collaboration — Claude reacts to selections and document changes"
              aria-pressed={tandemMode === "tandem"}
              onClick={() => onModeChange("tandem")}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "none",
                cursor: "pointer",
                background: tandemMode === "tandem" ? "#6366f1" : "transparent",
                color: tandemMode === "tandem" ? "#fff" : "#6b7280",
                fontWeight: tandemMode === "tandem" ? 600 : 400,
                display: "flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              {tandemMode === "tandem" && (
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: "#22c55e",
                    display: "inline-block",
                  }}
                />
              )}
              Tandem
            </button>
          </div>
        )}
        {onSettingsClick && (
          <button
            onClick={(e) => onSettingsClick(e.currentTarget.getBoundingClientRect())}
            title="Layout settings"
            aria-label="Layout settings"
            style={{
              background: "none",
              border: "1px solid #d1d5db",
              borderRadius: "4px",
              cursor: "pointer",
              color: "#6b7280",
              fontSize: "13px",
              padding: "4px 12px",
            }}
          >
            Settings
          </button>
        )}
      </div>
    </div>
  );
}
