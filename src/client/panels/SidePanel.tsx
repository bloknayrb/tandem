import React from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import * as Y from 'yjs';
import type { Annotation } from '../../shared/types';
import { HIGHLIGHT_COLORS } from '../../shared/constants';
import { flatOffsetToPmPos } from '../editor/extensions/annotation';

interface SidePanelProps {
  annotations: Annotation[];
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
}

export function SidePanel({ annotations, editor, ydoc }: SidePanelProps) {
  const pending = annotations.filter(a => a.status === 'pending');
  const resolved = annotations.filter(a => a.status !== 'pending');

  function handleDismiss(id: string) {
    if (!ydoc) return;
    const map = ydoc.getMap('annotations');
    const ann = map.get(id) as Annotation | undefined;
    if (!ann) return;
    map.set(id, { ...ann, status: 'dismissed' as const });
  }

  function handleAccept(id: string) {
    if (!ydoc) return;
    const map = ydoc.getMap('annotations');
    const ann = map.get(id) as Annotation | undefined;
    if (!ann) return;

    // Update status first
    map.set(id, { ...ann, status: 'accepted' as const });

    // For suggestions, apply the text replacement
    if (ann.type === 'suggestion' && editor) {
      try {
        const { newText } = JSON.parse(ann.content);
        if (typeof newText === 'string') {
          const pmFrom = flatOffsetToPmPos(editor.state.doc, ann.range.from);
          const pmTo = flatOffsetToPmPos(editor.state.doc, ann.range.to);
          editor.chain().focus().deleteRange({ from: pmFrom, to: pmTo }).insertContentAt(pmFrom, newText).run();
        }
      } catch {
        // Malformed suggestion content — status already updated, skip text change
      }
    }
  }

  return (
    <div style={{
      width: '300px',
      borderLeft: '1px solid #e5e7eb',
      background: '#fafafa',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, margin: 0 }}>
          Annotations
          {pending.length > 0 && (
            <span style={{
              marginLeft: '8px',
              padding: '1px 6px',
              fontSize: '11px',
              background: '#6366f1',
              color: 'white',
              borderRadius: '10px',
            }}>
              {pending.length}
            </span>
          )}
        </h3>
      </div>

      <div style={{ padding: '8px 16px', flex: 1 }}>
        {annotations.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#9ca3af', marginTop: '8px' }}>
            No annotations yet. Open a document to get started.
          </p>
        ) : (
          <>
            {pending.map(ann => (
              <AnnotationCard
                key={ann.id}
                annotation={ann}
                onAccept={handleAccept}
                onDismiss={handleDismiss}
              />
            ))}
            {resolved.length > 0 && (
              <details style={{ marginTop: '12px' }}>
                <summary style={{ fontSize: '12px', color: '#9ca3af', cursor: 'pointer' }}>
                  {resolved.length} resolved
                </summary>
                {resolved.map(ann => (
                  <AnnotationCard key={ann.id} annotation={ann} />
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface AnnotationCardProps {
  annotation: Annotation;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
}

function AnnotationCard({ annotation, onAccept, onDismiss }: AnnotationCardProps) {
  const borderColor = annotation.color
    ? HIGHLIGHT_COLORS[annotation.color] || '#e5e7eb'
    : annotation.type === 'comment' ? '#3b82f6'
    : annotation.type === 'suggestion' ? '#8b5cf6'
    : '#e5e7eb';

  const isPending = annotation.status === 'pending';

  return (
    <div style={{
      padding: '8px 10px',
      marginBottom: '6px',
      borderLeft: `3px solid ${borderColor}`,
      background: 'white',
      borderRadius: '0 4px 4px 0',
      fontSize: '13px',
      opacity: isPending ? 1 : 0.6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>{annotation.type}</span>
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
              onClick={() => onAccept(annotation.id)}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                border: '1px solid #d1d5db',
                borderRadius: '3px',
                background: '#f0fdf4',
                color: '#166534',
                cursor: 'pointer',
              }}
            >
              Accept
            </button>
          )}
          {onDismiss && (
            <button
              onClick={() => onDismiss(annotation.id)}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                border: '1px solid #d1d5db',
                borderRadius: '3px',
                background: '#fef2f2',
                color: '#991b1b',
                cursor: 'pointer',
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
