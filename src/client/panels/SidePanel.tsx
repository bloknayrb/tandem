import React from 'react';
import type { Annotation } from '../../shared/types';
import { HIGHLIGHT_COLORS } from '../../shared/constants';

interface SidePanelProps {
  annotations: Annotation[];
}

export function SidePanel({ annotations }: SidePanelProps) {
  const pending = annotations.filter(a => a.status === 'pending');
  const resolved = annotations.filter(a => a.status !== 'pending');

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
              <AnnotationCard key={ann.id} annotation={ann} />
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

function AnnotationCard({ annotation }: { annotation: Annotation }) {
  const borderColor = annotation.color
    ? HIGHLIGHT_COLORS[annotation.color] || '#e5e7eb'
    : annotation.type === 'comment' ? '#3b82f6'
    : annotation.type === 'suggestion' ? '#8b5cf6'
    : '#e5e7eb';

  return (
    <div style={{
      padding: '8px 10px',
      marginBottom: '6px',
      borderLeft: `3px solid ${borderColor}`,
      background: 'white',
      borderRadius: '0 4px 4px 0',
      fontSize: '13px',
      opacity: annotation.status === 'pending' ? 1 : 0.6,
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
    </div>
  );
}
