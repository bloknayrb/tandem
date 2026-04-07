import React, { useState, useEffect, useRef } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { yUndoPluginKey } from "y-prosemirror";
import { ToolbarButton } from "./ToolbarButton";

const BulletListIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="2" cy="4" r="1.5" fill="currentColor" />
    <circle cx="2" cy="8" r="1.5" fill="currentColor" />
    <circle cx="2" cy="12" r="1.5" fill="currentColor" />
    <rect x="5" y="3" width="9" height="2" rx="1" fill="currentColor" />
    <rect x="5" y="7" width="9" height="2" rx="1" fill="currentColor" />
    <rect x="5" y="11" width="9" height="2" rx="1" fill="currentColor" />
  </svg>
);

const OrderedListIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="5" y="3" width="9" height="2" rx="1" fill="currentColor" />
    <rect x="5" y="7" width="9" height="2" rx="1" fill="currentColor" />
    <rect x="5" y="11" width="9" height="2" rx="1" fill="currentColor" />
    <text x="0" y="5.5" fontSize="4.5" fill="currentColor" fontFamily="monospace" fontWeight="bold">
      1.
    </text>
    <text x="0" y="9.5" fontSize="4.5" fill="currentColor" fontFamily="monospace" fontWeight="bold">
      2.
    </text>
    <text
      x="0"
      y="13.5"
      fontSize="4.5"
      fill="currentColor"
      fontFamily="monospace"
      fontWeight="bold"
    >
      3.
    </text>
  </svg>
);

const LinkIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M6.5 8.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.5 7.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CodeBlockIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M5 4L1 8l4 4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11 4l4 4-4 4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M9 2l-2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const BlockquoteIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="0" y="2" width="3" height="12" rx="1.5" fill="currentColor" />
    <rect x="5" y="4" width="9" height="2" rx="1" fill="currentColor" opacity="0.7" />
    <rect x="5" y="8" width="7" height="2" rx="1" fill="currentColor" opacity="0.7" />
    <rect x="5" y="12" width="8" height="2" rx="1" fill="currentColor" opacity="0.7" />
  </svg>
);

const UndoIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M4 7L1 4l3-3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M1 4h9a5 5 0 0 1 0 10H7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const RedoIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 7l3-3-3-3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M15 4H6a5 5 0 0 0 0 10h3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

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

/** Rich text formatting buttons that drive Tiptap's StarterKit extensions. */
export function FormattingToolbar({ editor, disabled }: FormattingToolbarProps) {
  // Tiptap's isActive() reads editor state imperatively and doesn't trigger React
  // re-renders on its own, so we force a re-render on every transaction.
  const [, setTick] = useState(0);
  const [showHeadingMenu, setShowHeadingMenu] = useState(false);
  const headingMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      if (!editor.isDestroyed) setTick((t) => t + 1);
    };
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);

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

  if (!editor) return null;

  const isEditable = editor.isEditable;
  const isDisabled = !isEditable || !!disabled;

  const undoState = yUndoPluginKey.getState(editor.state);
  const canUndo = !isDisabled && (undoState?.undoManager?.undoStack.length ?? 0) > 0;
  const canRedo = !isDisabled && (undoState?.undoManager?.redoStack.length ?? 0) > 0;

  const activeHeading: HeadingLevel | null = findActiveHeading(editor);

  function handleHeadingToggle(level: HeadingLevel) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      if (!editor || editor.isDestroyed) return;
      editor.chain().focus().toggleHeading({ level }).run();
      setShowHeadingMenu(false);
    };
  }

  const headingLabel = activeHeading ? `H${activeHeading}` : "H";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      <ToolbarButton
        label={UndoIcon}
        ariaLabel="Undo"
        shortcut="Ctrl+Z"
        disabled={!canUndo}
        onMouseDown={withPreventDefault(() => editor.commands.undo())}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />
      <ToolbarButton
        label={RedoIcon}
        ariaLabel="Redo"
        shortcut="Ctrl+Shift+Z"
        disabled={!canRedo}
        onMouseDown={withPreventDefault(() => editor.commands.redo())}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />
      <div style={{ width: "1px", height: "16px", background: "#e5e7eb", margin: "0 2px" }} />
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
      <div
        style={{ position: "relative" }}
        ref={headingMenuRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") setShowHeadingMenu(false);
        }}
      >
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
            role="menu"
            aria-label="Heading level"
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
                type="button"
                role="menuitem"
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
        label={BulletListIcon}
        ariaLabel="Bullet list"
        shortcut="Ctrl+Shift+8"
        disabled={isDisabled}
        active={editor.isActive("bulletList")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleBulletList().run())}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />
      <ToolbarButton
        label={OrderedListIcon}
        ariaLabel="Ordered list"
        shortcut="Ctrl+Shift+7"
        disabled={isDisabled}
        active={editor.isActive("orderedList")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleOrderedList().run())}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />
      <ToolbarButton
        label={BlockquoteIcon}
        ariaLabel="Blockquote"
        shortcut="Ctrl+Shift+B"
        disabled={isDisabled}
        active={editor.isActive("blockquote")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleBlockquote().run())}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />

      <div style={{ width: "1px", height: "16px", background: "#e5e7eb", margin: "0 2px" }} />

      <ToolbarButton
        label={LinkIcon}
        ariaLabel="Link"
        shortcut="Ctrl+K"
        disabled={
          isDisabled ||
          (!editor.isActive("link") && editor.state.selection.from === editor.state.selection.to)
        }
        active={editor.isActive("link")}
        onMouseDown={withPreventDefault(() => {
          if (editor.isActive("link")) {
            editor.chain().focus().unsetLink().run();
          } else {
            const url = window.prompt("Enter URL:");
            if (url) {
              editor.chain().focus().setLink({ href: url }).run();
            }
          }
        })}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />
      <ToolbarButton
        label="—"
        ariaLabel="Horizontal rule"
        disabled={isDisabled}
        onMouseDown={withPreventDefault(() => editor.chain().focus().setHorizontalRule().run())}
        style={{ minWidth: "30px" }}
      />
      <ToolbarButton
        label={CodeBlockIcon}
        ariaLabel="Code block"
        disabled={isDisabled}
        active={editor.isActive("codeBlock")}
        onMouseDown={withPreventDefault(() => editor.chain().focus().toggleCodeBlock().run())}
        style={{ minWidth: "30px", padding: "4px 6px" }}
      />
    </div>
  );
}
