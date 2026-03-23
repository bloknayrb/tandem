import React, { useState, useEffect, useRef } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import * as Y from 'yjs';
import { pmPosToFlatOffset } from '../extensions/awareness';
import { generateAnnotationId } from '../../../shared/utils';
import { HIGHLIGHT_COLORS } from '../../../shared/constants';
import type { Annotation, AnnotationType, HighlightColor } from '../../../shared/types';

const HIGHLIGHT_COLOR_OPTIONS: Array<{ value: HighlightColor; label: string }> = [
  { value: 'yellow', label: 'Yellow' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
];

interface ToolbarProps {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
}

export function Toolbar({ editor, ydoc }: ToolbarProps) {
  const [hasSelection, setHasSelection] = useState(false);
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('yellow');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [suggestMode, setSuggestMode] = useState(false);
  const [suggestText, setSuggestText] = useState('');
  const [suggestReason, setSuggestReason] = useState('');
  const [askClaudeMode, setAskClaudeMode] = useState(false);
  const [askClaudeText, setAskClaudeText] = useState('');
  const capturedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const suggestInputRef = useRef<HTMLInputElement>(null);
  const askClaudeInputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;

    function onSelectionUpdate() {
      const { from, to } = editor!.state.selection;
      const next = from !== to;
      setHasSelection(prev => prev === next ? prev : next);
    }

    editor.on('selectionUpdate', onSelectionUpdate);
    return () => { editor.off('selectionUpdate', onSelectionUpdate); };
  }, [editor]);

  // Focus inputs when entering modes
  useEffect(() => {
    if (commentMode && commentInputRef.current) {
      commentInputRef.current.focus();
    }
  }, [commentMode]);

  useEffect(() => {
    if (suggestMode && suggestInputRef.current) {
      suggestInputRef.current.focus();
    }
  }, [suggestMode]);

  useEffect(() => {
    if (askClaudeMode && askClaudeInputRef.current) {
      askClaudeInputRef.current.focus();
    }
  }, [askClaudeMode]);

  // Close color picker when clicking outside
  useEffect(() => {
    if (!showColorPicker) return;

    function handleClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showColorPicker]);

  function createAnnotation(type: AnnotationType, content: string, color?: HighlightColor) {
    if (!editor || !ydoc) return;

    const range = capturedRangeRef.current ?? editor.state.selection;
    const { from, to } = range;
    if (from === to) return;

    const flatFrom = pmPosToFlatOffset(editor.state.doc, from);
    const flatTo = pmPosToFlatOffset(editor.state.doc, to);

    const id = generateAnnotationId();
    const annotation: Annotation = {
      id,
      author: 'user',
      type,
      range: { from: flatFrom, to: flatTo },
      content,
      status: 'pending',
      timestamp: Date.now(),
      ...(color ? { color } : {}),
    };

    ydoc.getMap('annotations').set(id, annotation);
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

  const inInputMode = commentMode || askClaudeMode || suggestMode;

  // -- Highlight --

  function handleHighlight(e: React.MouseEvent) {
    e.preventDefault();
    createAnnotation('highlight', '', highlightColor);
  }

  function handleColorPickerToggle(e: React.MouseEvent) {
    e.preventDefault();
    setShowColorPicker(prev => !prev);
  }

  function handleColorSelect(color: HighlightColor) {
    setHighlightColor(color);
    setShowColorPicker(false);
  }

  // -- Comment mode --

  function handleCommentStart(e: React.MouseEvent) {
    e.preventDefault();
    captureSelectionRange();
    setCommentMode(true);
    setCommentText('');
  }

  function handleCommentSubmit() {
    if (!commentText.trim()) {
      handleCommentCancel();
      return;
    }
    createAnnotation('comment', commentText.trim());
    setCommentMode(false);
    setCommentText('');
    editor?.chain().focus().run();
  }

  function handleCommentCancel() {
    setCommentMode(false);
    setCommentText('');
    resetAndFocusEditor();
  }

  function handleCommentKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommentSubmit();
    } else if (e.key === 'Escape') {
      handleCommentCancel();
    }
  }

  // -- Suggest mode --

  function handleSuggestStart(e: React.MouseEvent) {
    e.preventDefault();
    captureSelectionRange();
    setSuggestMode(true);
    setSuggestText('');
    setSuggestReason('');
  }

  function handleSuggestSubmit() {
    if (!suggestText.trim()) {
      handleSuggestCancel();
      return;
    }
    createAnnotation('suggestion', JSON.stringify({ newText: suggestText.trim(), reason: suggestReason.trim() }));
    setSuggestMode(false);
    setSuggestText('');
    setSuggestReason('');
    editor?.chain().focus().run();
  }

  function handleSuggestCancel() {
    setSuggestMode(false);
    setSuggestText('');
    setSuggestReason('');
    resetAndFocusEditor();
  }

  function handleSuggestKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSuggestSubmit();
    } else if (e.key === 'Escape') {
      handleSuggestCancel();
    }
  }

  // -- Flag --

  function handleFlag(e: React.MouseEvent) {
    e.preventDefault();
    createAnnotation('flag', '');
  }

  // -- Ask Claude mode --

  function handleAskClaudeStart(e: React.MouseEvent) {
    e.preventDefault();
    captureSelectionRange();
    setAskClaudeMode(true);
    setAskClaudeText('');
  }

  function handleAskClaudeSubmit() {
    if (!askClaudeText.trim()) {
      handleAskClaudeCancel();
      return;
    }
    createAnnotation('question', askClaudeText.trim());
    setAskClaudeMode(false);
    setAskClaudeText('');
    editor?.chain().focus().run();
  }

  function handleAskClaudeCancel() {
    setAskClaudeMode(false);
    setAskClaudeText('');
    resetAndFocusEditor();
  }

  function handleAskClaudeKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAskClaudeSubmit();
    } else if (e.key === 'Escape') {
      handleAskClaudeCancel();
    }
  }

  const canAnnotate = editor && ydoc && hasSelection;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 16px',
      borderBottom: '1px solid #e5e7eb',
      background: '#fafafa',
      userSelect: 'none',
    }}>
      <span style={{ fontWeight: 700, fontSize: '15px', color: '#6366f1', letterSpacing: '-0.02em' }}>
        Tandem
      </span>
      <div style={{ width: '1px', height: '20px', background: '#e5e7eb', margin: '0 8px' }} />

      {/* Highlight with color picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }}>
        <ToolbarButton
          label="Highlight"
          disabled={!canAnnotate || inInputMode}
          onMouseDown={handleHighlight}
          style={{ borderRadius: '4px 0 0 4px', borderRight: 'none' }}
        />
        <button
          disabled={!canAnnotate || inInputMode}
          onMouseDown={handleColorPickerToggle}
          title="Choose highlight color"
          style={{
            padding: '4px 6px',
            fontSize: '13px',
            border: '1px solid #e5e7eb',
            borderRadius: '0 4px 4px 0',
            background: (!canAnnotate || inInputMode) ? '#f9fafb' : '#fff',
            cursor: (!canAnnotate || inInputMode) ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span style={{
            display: 'inline-block',
            width: '12px',
            height: '12px',
            borderRadius: '2px',
            background: HIGHLIGHT_COLORS[highlightColor],
            border: '1px solid rgba(0,0,0,0.15)',
          }} />
        </button>
        {showColorPicker && (
          <div
            ref={colorPickerRef}
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              padding: '6px',
              display: 'flex',
              gap: '4px',
              zIndex: 10,
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}
          >
            {HIGHLIGHT_COLOR_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                title={label}
                onClick={() => handleColorSelect(value)}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '4px',
                  border: value === highlightColor ? '2px solid #374151' : '1px solid rgba(0,0,0,0.15)',
                  background: HIGHLIGHT_COLORS[value],
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <ToolbarButton
        label="Comment"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleCommentStart}
      />
      {commentMode && (
        <InputGroup
          inputRef={commentInputRef}
          value={commentText}
          onChange={setCommentText}
          onKeyDown={handleCommentKeyDown}
          onSubmit={handleCommentSubmit}
          onCancel={handleCommentCancel}
          placeholder="Add a comment..."
          submitLabel="Add"
          borderColor="#3b82f6"
          canSubmit={!!commentText.trim()}
        />
      )}

      <ToolbarButton
        label="Suggest"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleSuggestStart}
      />
      {suggestMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            ref={suggestInputRef}
            type="text"
            value={suggestText}
            onChange={e => setSuggestText(e.target.value)}
            onKeyDown={handleSuggestKeyDown}
            placeholder="Replacement text..."
            style={{
              padding: '3px 8px',
              fontSize: '13px',
              border: '1px solid #8b5cf6',
              borderRadius: '4px',
              outline: 'none',
              width: '160px',
            }}
          />
          <input
            type="text"
            value={suggestReason}
            onChange={e => setSuggestReason(e.target.value)}
            onKeyDown={handleSuggestKeyDown}
            placeholder="Reason (optional)"
            style={{
              padding: '3px 8px',
              fontSize: '13px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              outline: 'none',
              width: '140px',
            }}
          />
          <ToolbarButton label="Suggest" disabled={!suggestText.trim()} onClick={handleSuggestSubmit} />
          <ToolbarButton label="Cancel" disabled={false} onClick={handleSuggestCancel} />
        </div>
      )}

      <ToolbarButton
        label="Flag"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleFlag}
      />

      <ToolbarButton
        label="Ask Claude"
        shortcut="Ctrl+Shift+A"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleAskClaudeStart}
      />
      {askClaudeMode && (
        <InputGroup
          inputRef={askClaudeInputRef}
          value={askClaudeText}
          onChange={setAskClaudeText}
          onKeyDown={handleAskClaudeKeyDown}
          onSubmit={handleAskClaudeSubmit}
          onCancel={handleAskClaudeCancel}
          placeholder="Ask about this text..."
          submitLabel="Ask"
          borderColor="#6366f1"
          canSubmit={!!askClaudeText.trim()}
        />
      )}

      <div style={{ flex: 1 }} />
      <span style={{ fontSize: '12px', color: '#9ca3af' }}>Review Mode</span>
    </div>
  );
}

/** Reusable inline input group for comment/question modes */
function InputGroup({ inputRef, value, onChange, onKeyDown, onSubmit, onCancel, placeholder, submitLabel, borderColor, canSubmit }: {
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
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{
          padding: '3px 8px',
          fontSize: '13px',
          border: `1px solid ${borderColor}`,
          borderRadius: '4px',
          outline: 'none',
          width: '200px',
        }}
      />
      <ToolbarButton label={submitLabel} disabled={!canSubmit} onClick={onSubmit} />
      <ToolbarButton label="Cancel" disabled={false} onClick={onCancel} />
    </div>
  );
}

function ToolbarButton({ label, shortcut, disabled, onMouseDown, onClick, style }: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        padding: '4px 10px',
        fontSize: '13px',
        border: '1px solid #e5e7eb',
        borderRadius: '4px',
        background: disabled ? '#f9fafb' : '#fff',
        color: disabled ? '#9ca3af' : '#374151',
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      {label}
    </button>
  );
}
