import React from 'react';

export function DocumentTabs() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      padding: '4px 8px',
      background: '#f3f4f6',
      borderBottom: '1px solid #e5e7eb',
    }}>
      <span style={{ fontSize: '13px', color: '#9ca3af' }}>No documents open</span>
    </div>
  );
}
