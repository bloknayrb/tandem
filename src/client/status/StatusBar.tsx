import React from 'react';

interface StatusBarProps {
  connected: boolean;
}

export function StatusBar({ connected }: StatusBarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '4px 16px',
      height: '28px',
      borderTop: '1px solid #e5e7eb',
      background: '#fafafa',
      fontSize: '12px',
      color: '#6b7280',
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: connected ? '#22c55e' : '#ef4444',
          display: 'inline-block',
        }} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: '#6366f1',
          opacity: 0.5,
          display: 'inline-block',
        }} />
        <span>Claude -- idle</span>
      </div>
    </div>
  );
}
