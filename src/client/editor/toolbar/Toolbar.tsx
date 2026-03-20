import React from 'react';

export function Toolbar() {
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
      <ToolbarButton label="Highlight" shortcut="" disabled />
      <ToolbarButton label="Comment" shortcut="" disabled />
      <ToolbarButton label="Ask Claude" shortcut="Ctrl+Shift+A" disabled />
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: '12px', color: '#9ca3af' }}>Review Mode</span>
    </div>
  );
}

function ToolbarButton({ label, shortcut, disabled }: { label: string; shortcut: string; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
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
