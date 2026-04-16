import type { Editor as TiptapEditor } from "@tiptap/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { HIGHLIGHT_COLORS, Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import { toPmPos } from "../../../shared/positions/types";
import type { Annotation, AnnotationType, HighlightColor, TandemMode } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";
import { pmPosToFlatOffset } from "../../positions";
import { FormattingToolbar } from "./FormattingToolbar";
import { InputGroup } from "./InputGroup";
import { ToolbarButton } from "./ToolbarButton";

const HIGHLIGHT_COLOR_OPTIONS: Array<{ value: HighlightColor; label: string }> = [
  { value: "yellow", label: "Yellow" },
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "purple", label: "Purple" },
];

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
  const [highlightColor, setHighlightColor] = useState<HighlightColor>("yellow");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [mode, setMode] = useState<ToolbarMode>("idle");
  const [modeText, setModeText] = useState("");
  const [showReplacement, setShowReplacement] = useState(false);
  const [replacementText, setReplacementText] = useState("");
  const [sendToClaude, setSendToClaude] = useState(false);
  const capturedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
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
    if (mode === "comment" && commentInputRef.current) {
      commentInputRef.current.focus();
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

  function createAnnotation(
    type: AnnotationType,
    content: string,
    extras?: { color?: HighlightColor; suggestedText?: string; directedAt?: "claude" },
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
      ...(extras?.suggestedText !== undefined ? { suggestedText: extras.suggestedText } : {}),
      ...(extras?.directedAt !== undefined ? { directedAt: extras.directedAt } : {}),
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

  function handleHighlight(e: React.MouseEvent) {
    e.preventDefault();
    createAnnotation("highlight", "", { color: highlightColor });
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
        setReplacementText("");
        setShowReplacement(false);
        setSendToClaude(false);
      };
    },
    [editor],
  );

  const startComment = useMemo(() => handleModeStart("comment"), [handleModeStart]);

  function handleModeCancel() {
    setMode("idle");
    setModeText("");
    setReplacementText("");
    setShowReplacement(false);
    setSendToClaude(false);
    resetAndFocusEditor();
  }

  function handleModeSubmit() {
    if (!modeText.trim() && !replacementText.trim()) {
      handleModeCancel();
      return;
    }

    const extras: { suggestedText?: string; directedAt?: "claude" } = {};
    if (showReplacement && replacementText.trim()) {
      extras.suggestedText = replacementText.trim();
    }
    if (sendToClaude) {
      extras.directedAt = "claude";
    }

    createAnnotation("comment", modeText.trim(), extras);

    setMode("idle");
    setModeText("");
    setReplacementText("");
    setShowReplacement(false);
    setSendToClaude(false);
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
            border: "1px solid var(--tandem-border)",
            borderRadius: "0 4px 4px 0",
            background:
              !canAnnotate || inInputMode ? "var(--tandem-surface-muted)" : "var(--tandem-surface)",
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
              background: "var(--tandem-surface)",
              border: "1px solid var(--tandem-border)",
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
                    value === highlightColor
                      ? "2px solid var(--tandem-fg)"
                      : "1px solid rgba(0,0,0,0.15)",
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
                background: "var(--tandem-surface-muted)",
                cursor: "pointer",
                padding: 0,
                fontSize: "13px",
                color: "var(--tandem-fg-muted)",
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
          placeholder={sendToClaude ? "Ask about this text..." : "Add a comment..."}
          submitLabel={showReplacement ? "Suggest" : sendToClaude ? "Ask" : "Add"}
          borderColor={
            showReplacement
              ? "#8b5cf6"
              : sendToClaude
                ? "var(--tandem-accent)"
                : "var(--tandem-author-user)"
          }
          canSubmit={!!modeText.trim() || (showReplacement && !!replacementText.trim())}
          secondaryInput={
            <>
              {showReplacement && (
                <input
                  type="text"
                  value={replacementText}
                  onChange={(e) => setReplacementText(e.target.value)}
                  onKeyDown={handleModeKeyDown}
                  placeholder="Replacement text..."
                  style={{
                    padding: "3px 8px",
                    fontSize: "13px",
                    border: "1px solid var(--tandem-border-strong)",
                    borderRadius: "4px",
                    outline: "none",
                    minWidth: "100px",
                    flex: "1 1 140px",
                  }}
                />
              )}
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <label
                  style={{
                    fontSize: "11px",
                    color: showReplacement ? "#8b5cf6" : "var(--tandem-fg-subtle)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "3px",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showReplacement}
                    onChange={(e) => {
                      setShowReplacement(e.target.checked);
                      if (!e.target.checked) setReplacementText("");
                    }}
                    style={{ margin: 0 }}
                  />
                  Replace
                </label>
                <label
                  style={{
                    fontSize: "11px",
                    color: sendToClaude ? "var(--tandem-accent)" : "var(--tandem-fg-subtle)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "3px",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sendToClaude}
                    onChange={(e) => setSendToClaude(e.target.checked)}
                    style={{ margin: 0 }}
                  />
                  @Claude
                </label>
              </div>
            </>
          }
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
              color: "var(--tandem-warning)",
              background: "var(--tandem-warning-bg)",
              borderRadius: "9999px",
            }}
          >
            {heldCount} held
          </span>
        )}
        {/* Solo/Tandem mode toggle */}
        {tandemMode && onModeChange && (
          <div
            data-testid="mode-toggle"
            role="group"
            aria-label="Claude collaboration mode"
            style={{
              display: "flex",
              border: "1px solid var(--tandem-border-strong)",
              borderRadius: "4px",
              overflow: "hidden",
            }}
          >
            <button
              data-testid="mode-solo-btn"
              title="Write undisturbed — Claude only responds when you message"
              aria-pressed={tandemMode === "solo"}
              onClick={() => onModeChange("solo")}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "none",
                cursor: "pointer",
                background: tandemMode === "solo" ? "var(--tandem-accent)" : "transparent",
                color: tandemMode === "solo" ? "var(--tandem-accent-fg)" : "var(--tandem-fg-muted)",
                fontWeight: tandemMode === "solo" ? 600 : 400,
                borderRight: "1px solid var(--tandem-border-strong)",
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
                    background: "var(--tandem-fg-subtle)",
                    display: "inline-block",
                  }}
                />
              )}
              Solo
            </button>
            <button
              data-testid="mode-tandem-btn"
              title="Full collaboration — Claude reacts to selections and document changes"
              aria-pressed={tandemMode === "tandem"}
              onClick={() => onModeChange("tandem")}
              style={{
                padding: "3px 10px",
                fontSize: "12px",
                border: "none",
                cursor: "pointer",
                background: tandemMode === "tandem" ? "var(--tandem-accent)" : "transparent",
                color:
                  tandemMode === "tandem" ? "var(--tandem-accent-fg)" : "var(--tandem-fg-muted)",
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
                    background: "var(--tandem-success)",
                    display: "inline-block",
                  }}
                />
              )}
              Tandem
            </button>
          </div>
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
