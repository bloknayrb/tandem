import React from 'react';
import { CLAUDE_PRESENCE_COLOR } from '../../shared/constants';

interface StatusBarProps {
  connected: boolean;
  claudeStatus: string | null;
  claudeActive: boolean;
}

export function StatusBar({ connected, claudeStatus, claudeActive }: StatusBarProps) {
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
          background: CLAUDE_PRESENCE_COLOR,
          opacity: claudeActive ? 1 : 0.4,
          display: 'inline-block',
          transition: 'opacity 0.3s ease',
          animation: claudeActive ? 'tandem-status-pulse 1.5s ease-in-out infinite' : 'none',
        }} />
        <span style={{
          transition: 'color 0.3s ease',
          color: claudeActive ? '#4b5563' : '#9ca3af',
        }}>
          {claudeStatus ? `Claude -- ${claudeStatus}` : 'Claude -- idle'}
        </span>
      </div>
      <style>{`
        @keyframes tandem-status-pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
