import React, { useState, useEffect, useRef } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { ToolbarButton } from "./ToolbarButton";

interface FormattingToolbarProps {
  editor: TiptapEditor | null;
  disabled?: boolean;
}

type HeadingLevel = 1 | 2 | 3;

const HEADING_LEVELS: HeadingLevel[] = [1, 2, 3];

const HEADING_FONT_WEIGHTS: Record<HeadingLevel, number> = {
  1: 700,
  2: 600,
  3: 500,
};

function findActiveHeading(editor: TiptapEditor): HeadingLevel | null {
  for (const level of HEADING_LEVELS) {
    if (editor.isActive("heading", { level })) return level;
  }
  return null;
}

/** Wraps a command so onMouseDown prevents default then executes it. */
function withPreventDefault(command: () => void): (e: React.MouseEvent) => void {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    command();
  };
}

/**
 * Rich text formatting buttons that drive Tiptap's StarterKit extensions.
 *
 * Undo/Redo are omitted: the Collaboration extension disables Tiptap's built-in
 * history, and integrating Y.js UndoManager requires adding
 * @tiptap/extension-collaboration-history or manual wiring. Deferred to a
 * follow-up issue.
 */
export function FormattingToolbar({ editor, disabled }: FormattingToolbarProps) {
  // Force re-render on editor transaction so active states stay current
  const [, setTick] = useState(0);
  const [showHeadingMenu, setShowHeadingMenu] = useState(false);
  const headingMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const handler = () => setTick((t) => t + 1);
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);

  // Close heading menu on outside click
  useEffect(() => {
    if (!showHeadingMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (headingMenuRef.current && !headingMenuRef.current.contains(e.target as Node)) {
        setShowHeadingMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showHeadingMenu]);

  const isEditable = editor?.isEditable ?? false;
  const isDisabled = !editor || !isEditable || !!disabled;

  if (!editor) return null;

  const activeHeading: HeadingLevel | null = findActiveHeading(editor);

  function handleHeadingToggle(level: HeadingLevel) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      editor?.chain().focus().toggleHeading({ level }).run();
      setShowHeadingMenu(false);
    };
  }

  const headingLabel = activeHeading ? `H${activeHeading}` : "H";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      <ToolbarButton
        label="B"
        shortcut="Ctrl+B"
        disabled={isDisabled}
        active={editor.isActive("bold")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleBold().run())}
        style={{ fontWeight: 700, minWidth: "30px" }}
      />
      <ToolbarButton
        label="I"
        shortcut="Ctrl+I"
        disabled={isDisabled}
        active={editor.isActive("italic")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleItalic().run())}
        style={{ fontStyle: "italic", minWidth: "30px" }}
      />
      <ToolbarButton
        label="S"
        shortcut="Ctrl+Shift+X"
        disabled={isDisabled}
        active={editor.isActive("strike")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleStrike().run())}
        style={{ textDecoration: "line-through", minWidth: "30px" }}
      />
      <ToolbarButton
        label="<>"
        shortcut="Ctrl+E"
        disabled={isDisabled}
        active={editor.isActive("code")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleCode().run())}
        style={{ fontFamily: "monospace", minWidth: "30px" }}
      />

      {/* Heading dropdown */}
      <div style={{ position: "relative" }} ref={headingMenuRef}>
        <ToolbarButton
          label={headingLabel}
          disabled={isDisabled}
          active={activeHeading !== null}
          onMouseDown={(e: React.MouseEvent) => {
            e.preventDefault();
            setShowHeadingMenu((prev) => !prev);
          }}
          style={{ minWidth: "30px" }}
        />
        {showHeadingMenu && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: "4px",
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: "6px",
              padding: "4px",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
              zIndex: 10,
              boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            }}
          >
            {HEADING_LEVELS.map((level) => (
              <button
                key={level}
                onMouseDown={handleHeadingToggle(level)}
                style={{
                  padding: "4px 12px",
                  fontSize: "13px",
                  border: "none",
                  borderRadius: "4px",
                  background: activeHeading === level ? "#eef2ff" : "transparent",
                  color: activeHeading === level ? "#4338ca" : "#374151",
                  cursor: "pointer",
                  textAlign: "left",
                  fontWeight: HEADING_FONT_WEIGHTS[level],
                  whiteSpace: "nowrap",
                }}
              >
                Heading {level}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ width: "1px", height: "16px", background: "#e5e7eb", margin: "0 2px" }} />

      <ToolbarButton
        label="UL"
        shortcut="Ctrl+Shift+8"
        disabled={isDisabled}
        active={editor.isActive("bulletList")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleBulletList().run())}
        style={{ minWidth: "30px" }}
      />
      <ToolbarButton
        label="OL"
        shortcut="Ctrl+Shift+7"
        disabled={isDisabled}
        active={editor.isActive("orderedList")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleOrderedList().run())}
        style={{ minWidth: "30px" }}
      />
      <ToolbarButton
        label="BQ"
        shortcut="Ctrl+Shift+B"
        disabled={isDisabled}
        active={editor.isActive("blockquote")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleBlockquote().run())}
        style={{ minWidth: "30px" }}
      />
    </div>
  );
}
