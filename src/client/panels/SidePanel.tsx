import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import * as Y from 'yjs';
import type { Annotation, AnnotationType } from '../../shared/types';
import { HIGHLIGHT_COLORS } from '../../shared/constants';
import { flatOffsetToPmPos } from '../editor/extensions/annotation';

interface SidePanelProps {
  annotations: Annotation[];
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  reviewMode: boolean;
  onToggleReviewMode: () => void;
  activeAnnotationId: string | null;
  onActiveAnnotationChange: (id: string | null) => void;
}

type FilterType = AnnotationType | 'all';
type FilterAuthor = 'all' | 'claude' | 'user';
type FilterStatus = 'all' | 'pending' | 'accepted' | 'dismissed';

/** Apply a suggestion annotation's text replacement in the editor */
function applySuggestion(ann: Annotation, editor: TiptapEditor) {
  if (ann.type !== 'suggestion') return;
  try {
    const { newText } = JSON.parse(ann.content);
    if (typeof newText === 'string') {
      const pmFrom = flatOffsetToPmPos(editor.state.doc, ann.range.from);
      const pmTo = flatOffsetToPmPos(editor.state.doc, ann.range.to);
      editor.chain().focus().deleteRange({ from: pmFrom, to: pmTo }).insertContentAt(pmFrom, newText).run();
    }
  } catch {
    // Malformed suggestion content
  }
}

export function SidePanel({ annotations, editor, ydoc, reviewMode, onToggleReviewMode, activeAnnotationId, onActiveAnnotationChange }: SidePanelProps) {
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [filterAuthor, setFilterAuthor] = useState<FilterAuthor>('all');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [reviewIndex, setReviewIndex] = useState(0);
  const reviewIndexRef = useRef(0);

  // Stable refs for keyboard callbacks to avoid stale closures
  const ydocRef = useRef(ydoc);
  const editorRef = useRef(editor);
  ydocRef.current = ydoc;
  editorRef.current = editor;

  // Single-pass filtering + categorization
  const { filtered, pending, resolved, allPending } = useMemo(() => {
    const filtered: Annotation[] = [];
    const allPending: Annotation[] = [];

    for (const a of annotations) {
      if (a.status === 'pending') allPending.push(a);
      const matchType = filterType === 'all' || a.type === filterType;
      const matchAuthor = filterAuthor === 'all' || a.author === filterAuthor;
      const matchStatus = filterStatus === 'all' || a.status === filterStatus;
      if (matchType && matchAuthor && matchStatus) filtered.push(a);
    }

    const pending = filtered.filter(a => a.status === 'pending');
    const resolved = filtered.filter(a => a.status !== 'pending');

    return { filtered, pending, resolved, allPending };
  }, [annotations, filterType, filterAuthor, filterStatus]);

  // Keyboard review targets only pending annotations (unfiltered)
  const reviewTargets = allPending;
  const reviewTargetsRef = useRef(reviewTargets);
  reviewTargetsRef.current = reviewTargets;

  function resolveAnnotation(id: string, status: 'accepted' | 'dismissed') {
    const y = ydocRef.current;
    if (!y) return;
    const map = y.getMap('annotations');
    const ann = map.get(id) as Annotation | undefined;
    if (!ann) return;
    map.set(id, { ...ann, status });
    if (status === 'accepted' && editorRef.current) {
      applySuggestion(ann, editorRef.current);
    }
  }

  function handleAccept(id: string) {
    resolveAnnotation(id, 'accepted');
  }

  function handleDismiss(id: string) {
    resolveAnnotation(id, 'dismissed');
  }

  function handleBulkAccept() {
    for (const ann of allPending) resolveAnnotation(ann.id, 'accepted');
  }

  function handleBulkDismiss() {
    for (const ann of allPending) resolveAnnotation(ann.id, 'dismissed');
  }

  // Scroll editor to an annotation's range
  const scrollToAnnotation = useCallback((ann: Annotation) => {
    const ed = editorRef.current;
    if (!ed) return;
    const pmFrom = flatOffsetToPmPos(ed.state.doc, ann.range.from);
    const pmTo = flatOffsetToPmPos(ed.state.doc, ann.range.to);
    ed.chain().focus().setTextSelection({ from: pmFrom, to: pmTo }).run();
    const domAtPos = ed.view.domAtPos(pmFrom);
    const el = domAtPos.node instanceof HTMLElement ? domAtPos.node : domAtPos.node.parentElement;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Stable keyboard review callbacks (use refs to avoid dep cascade)
  const navigateReview = useCallback((direction: 'next' | 'prev') => {
    const targets = reviewTargetsRef.current;
    if (targets.length === 0) return;
    let idx = reviewIndexRef.current;
    idx = direction === 'next'
      ? (idx + 1) % targets.length
      : (idx - 1 + targets.length) % targets.length;
    reviewIndexRef.current = idx;
    setReviewIndex(idx);
    scrollToAnnotation(targets[idx]);
  }, [scrollToAnnotation]);

  const acceptCurrent = useCallback(() => {
    const targets = reviewTargetsRef.current;
    if (targets.length === 0) return;
    const ann = targets[reviewIndexRef.current];
    if (ann) resolveAnnotation(ann.id, 'accepted');
  }, []);

  const dismissCurrent = useCallback(() => {
    const targets = reviewTargetsRef.current;
    if (targets.length === 0) return;
    const ann = targets[reviewIndexRef.current];
    if (ann) resolveAnnotation(ann.id, 'dismissed');
  }, []);

  // Reset review index and scroll to first annotation when entering review mode
  const prevReviewModeRef = useRef(false);
  useEffect(() => {
    if (reviewMode && !prevReviewModeRef.current && reviewTargets.length > 0) {
      reviewIndexRef.current = 0;
      setReviewIndex(0);
      scrollToAnnotation(reviewTargets[0]);
    }
    prevReviewModeRef.current = reviewMode;
  }, [reviewMode, reviewTargets, scrollToAnnotation]);

  // Sync activeAnnotationId when review index changes
  useEffect(() => {
    if (reviewMode && reviewTargets.length > 0) {
      onActiveAnnotationChange(reviewTargets[reviewIndex]?.id ?? null);
    } else {
      onActiveAnnotationChange(null);
    }
  }, [reviewMode, reviewIndex, reviewTargets, onActiveAnnotationChange]);

  // Keyboard shortcuts — stable deps via refs
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        onToggleReviewMode();
        return;
      }

      if (!reviewMode) return;

      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        navigateReview(e.shiftKey ? 'prev' : 'next');
      } else if (e.key === 'y' || e.key === 'Y') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        acceptCurrent();
      } else if (e.key === 'n' || e.key === 'N') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        dismissCurrent();
      } else if (e.key === 'e' || e.key === 'E') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        // Scroll to current annotation and exit review mode without resolving
        const targets = reviewTargetsRef.current;
        const ann = targets[reviewIndexRef.current];
        if (ann) scrollToAnnotation(ann);
        onToggleReviewMode();
      } else if (e.key === 'Escape') {
        onToggleReviewMode();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [reviewMode, navigateReview, acceptCurrent, dismissCurrent, scrollToAnnotation, onToggleReviewMode]);

  // Keep review index in bounds when annotations change
  useEffect(() => {
    if (reviewMode && reviewIndexRef.current >= reviewTargets.length) {
      const newIdx = Math.max(0, reviewTargets.length - 1);
      reviewIndexRef.current = newIdx;
      setReviewIndex(newIdx);
    }
  }, [reviewMode, reviewTargets.length]);

  // Auto-exit review mode when no pending left
  useEffect(() => {
    if (reviewMode && reviewTargets.length === 0) {
      onToggleReviewMode();
    }
  }, [reviewMode, reviewTargets.length, onToggleReviewMode]);

  const hasFilters = filterType !== 'all' || filterAuthor !== 'all' || filterStatus !== 'all';
  const activeReviewAnn = reviewMode && reviewTargets.length > 0 ? reviewTargets[reviewIndex] : null;

  return (
    <div style={{
      width: '300px',
      borderLeft: '1px solid #e5e7eb',
      background: '#fafafa',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, margin: 0 }}>
            Annotations
            {allPending.length > 0 && (
              <span style={{
                marginLeft: '8px',
                padding: '1px 6px',
                fontSize: '11px',
                background: '#6366f1',
                color: 'white',
                borderRadius: '10px',
              }}>
                {allPending.length}
              </span>
            )}
          </h3>
          {allPending.length > 0 && (
            <button
              onClick={onToggleReviewMode}
              title="Keyboard review mode (Ctrl+Shift+R)"
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                border: `1px solid ${reviewMode ? '#6366f1' : '#d1d5db'}`,
                borderRadius: '3px',
                background: reviewMode ? '#eef2ff' : '#fff',
                color: reviewMode ? '#6366f1' : '#6b7280',
                cursor: 'pointer',
                fontWeight: reviewMode ? 600 : 400,
              }}
            >
              {reviewMode ? 'Exit Review' : 'Review'}
            </button>
          )}
        </div>
      </div>

      {/* Review mode indicator */}
      {reviewMode && reviewTargets.length > 0 && (
        <div style={{
          padding: '8px 16px',
          background: '#eef2ff',
          borderBottom: '1px solid #e5e7eb',
          fontSize: '12px',
          color: '#4338ca',
        }}>
          <div style={{ fontWeight: 600, marginBottom: '2px' }}>
            Reviewing {reviewIndex + 1} / {reviewTargets.length}
          </div>
          <div style={{ color: '#6366f1' }}>
            Tab: next · Shift+Tab: prev · Y: accept · N: dismiss · E: examine · Esc: exit
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        gap: '4px',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}>
        <FilterSelect
          value={filterType}
          onChange={v => setFilterType(v as FilterType)}
          options={[
            { value: 'all', label: 'All types' },
            { value: 'highlight', label: 'Highlights' },
            { value: 'comment', label: 'Comments' },
            { value: 'suggestion', label: 'Suggestions' },
            { value: 'question', label: 'Questions' },
          ]}
        />
        <FilterSelect
          value={filterAuthor}
          onChange={v => setFilterAuthor(v as FilterAuthor)}
          options={[
            { value: 'all', label: 'Anyone' },
            { value: 'claude', label: 'Claude' },
            { value: 'user', label: 'You' },
          ]}
        />
        <FilterSelect
          value={filterStatus}
          onChange={v => setFilterStatus(v as FilterStatus)}
          options={[
            { value: 'all', label: 'Any status' },
            { value: 'pending', label: 'Pending' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'dismissed', label: 'Dismissed' },
          ]}
        />
        {hasFilters && (
          <button
            onClick={() => { setFilterType('all'); setFilterAuthor('all'); setFilterStatus('all'); }}
            style={{
              background: 'none', border: 'none', color: '#6366f1',
              fontSize: '11px', cursor: 'pointer', padding: '2px 4px',
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Bulk actions */}
      {allPending.length > 1 && (
        <div style={{
          padding: '6px 16px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          gap: '6px',
        }}>
          <button
            onClick={handleBulkAccept}
            style={{
              padding: '2px 8px', fontSize: '11px', border: '1px solid #d1d5db',
              borderRadius: '3px', background: '#f0fdf4', color: '#166534', cursor: 'pointer',
            }}
          >
            Accept All ({allPending.length})
          </button>
          <button
            onClick={handleBulkDismiss}
            style={{
              padding: '2px 8px', fontSize: '11px', border: '1px solid #d1d5db',
              borderRadius: '3px', background: '#fef2f2', color: '#991b1b', cursor: 'pointer',
            }}
          >
            Dismiss All
          </button>
        </div>
      )}

      {/* Annotation list */}
      <div style={{ padding: '8px 16px', flex: 1 }}>
        {filtered.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#9ca3af', marginTop: '8px' }}>
            {hasFilters ? 'No annotations match filters.' : 'No annotations yet. Open a document to get started.'}
          </p>
        ) : (
          <>
            {pending.map(ann => (
              <AnnotationCard
                key={ann.id}
                annotation={ann}
                isReviewTarget={activeReviewAnn?.id === ann.id}
                onAccept={handleAccept}
                onDismiss={handleDismiss}
                onClick={() => scrollToAnnotation(ann)}
              />
            ))}
            {resolved.length > 0 && (
              <details style={{ marginTop: '12px' }}>
                <summary style={{ fontSize: '12px', color: '#9ca3af', cursor: 'pointer' }}>
                  {resolved.length} resolved
                </summary>
                {resolved.map(ann => (
                  <AnnotationCard
                    key={ann.id}
                    annotation={ann}
                    onClick={() => scrollToAnnotation(ann)}
                  />
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterSelect({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: '2px 4px',
        fontSize: '11px',
        border: '1px solid #e5e7eb',
        borderRadius: '3px',
        background: '#fff',
        color: '#374151',
        cursor: 'pointer',
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

interface AnnotationCardProps {
  annotation: Annotation;
  isReviewTarget?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onClick?: () => void;
}

function AnnotationCard({ annotation, isReviewTarget, onAccept, onDismiss, onClick }: AnnotationCardProps) {
  const borderColor = annotation.color
    ? HIGHLIGHT_COLORS[annotation.color] || '#e5e7eb'
    : annotation.type === 'comment' ? '#3b82f6'
    : annotation.type === 'suggestion' ? '#8b5cf6'
    : annotation.type === 'question' ? '#6366f1'
    : '#e5e7eb';

  const isPending = annotation.status === 'pending';

  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 10px',
        marginBottom: '6px',
        borderLeft: `3px solid ${borderColor}`,
        background: isReviewTarget ? '#eef2ff' : 'white',
        borderRadius: '0 4px 4px 0',
        fontSize: '13px',
        opacity: isPending ? 1 : 0.6,
        cursor: onClick ? 'pointer' : 'default',
        outline: isReviewTarget ? '2px solid #6366f1' : 'none',
        transition: 'background 0.15s, outline 0.15s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>
          {annotation.type}
          {!isPending && (
            <span style={{
              marginLeft: '6px',
              fontSize: '10px',
              color: annotation.status === 'accepted' ? '#16a34a' : '#dc2626',
              fontWeight: 600,
            }}>
              {annotation.status}
            </span>
          )}
        </span>
        <span style={{ fontSize: '11px', color: '#9ca3af' }}>
          {annotation.author === 'claude' ? 'Claude' : 'You'}
        </span>
      </div>
      <p style={{ margin: 0, color: '#4b5563', lineHeight: '1.4' }}>
        {annotation.type === 'suggestion'
          ? (() => {
              try {
                const parsed = JSON.parse(annotation.content);
                return parsed.reason || parsed.newText;
              } catch {
                return annotation.content;
              }
            })()
          : annotation.content || '(no note)'}
      </p>
      {isPending && (onAccept || onDismiss) && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
          {onAccept && (
            <button
              onClick={(e) => { e.stopPropagation(); onAccept(annotation.id); }}
              style={{
                padding: '2px 8px', fontSize: '11px', border: '1px solid #d1d5db',
                borderRadius: '3px', background: '#f0fdf4', color: '#166534', cursor: 'pointer',
              }}
            >
              Accept
            </button>
          )}
          {onDismiss && (
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(annotation.id); }}
              style={{
                padding: '2px 8px', fontSize: '11px', border: '1px solid #d1d5db',
                borderRadius: '3px', background: '#fef2f2', color: '#991b1b', cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
