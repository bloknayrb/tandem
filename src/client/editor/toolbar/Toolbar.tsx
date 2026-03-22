import React, { useState, useEffect, useRef } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import * as Y from 'yjs';
import { pmPosToFlatOffset } from '../extensions/awareness';
import type { Annotation, AnnotationType, HighlightColor } from '../../../shared/types';

interface ToolbarProps {
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
}

function generateAnnotationId(): string {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function Toolbar({ editor, ydoc }: ToolbarProps) {
  const [hasSelection, setHasSelection] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [askClaudeMode, setAskClaudeMode] = useState(false);
  const [askClaudeText, setAskClaudeText] = useState('');
  const capturedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const askClaudeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor) return;

    const onSelectionUpdate = () => {
      const { from, to } = editor.state.selection;
      const next = from !== to;
      setHasSelection(prev => prev === next ? prev : next);
    };

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
    if (askClaudeMode && askClaudeInputRef.current) {
      askClaudeInputRef.current.focus();
    }
  }, [askClaudeMode]);

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

  const inInputMode = commentMode || askClaudeMode;

  function handleHighlight(e: React.MouseEvent) {
    e.preventDefault();
    createAnnotation('highlight', '', 'yellow');
  }

  // -- Comment mode --

  function handleCommentStart(e: React.MouseEvent) {
    e.preventDefault();
    if (!editor) return;
    const { from, to } = editor.state.selection;
    capturedRangeRef.current = { from, to };
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
    capturedRangeRef.current = null;
    editor?.chain().focus().run();
  }

  function handleCommentKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommentSubmit();
    } else if (e.key === 'Escape') {
      handleCommentCancel();
    }
  }

  // -- Ask Claude mode --

  function handleAskClaudeStart(e: React.MouseEvent) {
    e.preventDefault();
    if (!editor) return;
    const { from, to } = editor.state.selection;
    capturedRangeRef.current = { from, to };
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
    capturedRangeRef.current = null;
    editor?.chain().focus().run();
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
      <ToolbarButton
        label="Highlight"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleHighlight}
      />
      <ToolbarButton
        label="Comment"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleCommentStart}
      />
      {commentMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            ref={commentInputRef}
            type="text"
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            onKeyDown={handleCommentKeyDown}
            placeholder="Add a comment..."
            style={{
              padding: '3px 8px',
              fontSize: '13px',
              border: '1px solid #3b82f6',
              borderRadius: '4px',
              outline: 'none',
              width: '200px',
            }}
          />
          <ToolbarButton label="Add" disabled={!commentText.trim()} onClick={handleCommentSubmit} />
          <ToolbarButton label="Cancel" disabled={false} onClick={handleCommentCancel} />
        </div>
      )}
      <ToolbarButton
        label="Ask Claude"
        shortcut="Ctrl+Shift+A"
        disabled={!canAnnotate || inInputMode}
        onMouseDown={handleAskClaudeStart}
      />
      {askClaudeMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            ref={askClaudeInputRef}
            type="text"
            value={askClaudeText}
            onChange={e => setAskClaudeText(e.target.value)}
            onKeyDown={handleAskClaudeKeyDown}
            placeholder="Ask about this text..."
            style={{
              padding: '3px 8px',
              fontSize: '13px',
              border: '1px solid #6366f1',
              borderRadius: '4px',
              outline: 'none',
              width: '200px',
            }}
          />
          <ToolbarButton label="Ask" disabled={!askClaudeText.trim()} onClick={handleAskClaudeSubmit} />
          <ToolbarButton label="Cancel" disabled={false} onClick={handleAskClaudeCancel} />
        </div>
      )}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: '12px', color: '#9ca3af' }}>Review Mode</span>
    </div>
  );
}

function ToolbarButton({ label, shortcut, disabled, onMouseDown, onClick }: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: () => void;
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
      }}
    >
      {label}
    </button>
  );
}
