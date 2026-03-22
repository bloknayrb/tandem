import React, { useEffect, useRef, useState } from 'react';
import { CLAUDE_PRESENCE_COLOR } from '../../shared/constants';

interface StatusBarProps {
  connected: boolean;
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly?: boolean;
  documentCount?: number;
}

const RECONNECTED_FLASH_MS = 2_000;
const SERVER_CHECK_MS = 30_000;

export function StatusBar({ connected, claudeStatus, claudeActive, readOnly, documentCount = 0 }: StatusBarProps) {
  const [showReconnectedFlash, setShowReconnectedFlash] = useState(false);
  const [showServerBanner, setShowServerBanner] = useState(false);
  const prevConnected = useRef(connected);
  const disconnectedAt = useRef<number | null>(null);

  useEffect(() => {
    const was = prevConnected.current;
    prevConnected.current = connected;

    if (!connected) {
      if (disconnectedAt.current === null) disconnectedAt.current = Date.now();
      const timer = setTimeout(() => setShowServerBanner(true), SERVER_CHECK_MS);
      return () => clearTimeout(timer);
    }

    // Just reconnected
    disconnectedAt.current = null;
    setShowServerBanner(false);
    if (!was) {
      setShowReconnectedFlash(true);
      const timer = setTimeout(() => setShowReconnectedFlash(false), RECONNECTED_FLASH_MS);
      return () => clearTimeout(timer);
    }
  }, [connected]);

  const isReconnecting = !connected && disconnectedAt.current !== null;

  const dotColor = connected
    ? '#22c55e'
    : isReconnecting
      ? '#eab308'
      : '#ef4444';

  const label = showReconnectedFlash
    ? 'Reconnected'
    : connected
      ? 'Connected'
      : isReconnecting
        ? 'Reconnecting\u2026'
        : 'Disconnected';

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
          background: dotColor,
          display: 'inline-block',
          animation: isReconnecting ? 'tandem-reconnect-pulse 1.2s ease-in-out infinite' : 'none',
        }} />
        <span>{label}</span>
        {showServerBanner && !connected && (
          <span style={{ color: '#eab308', fontWeight: 500 }}>
            — check if the server is running
          </span>
        )}
        {documentCount > 0 && (
          <span style={{ color: '#9ca3af' }}>
            {documentCount} doc{documentCount !== 1 ? 's' : ''} open
          </span>
        )}
      </div>
      {readOnly && (
        <span style={{
          padding: '1px 8px',
          fontSize: '11px',
          fontWeight: 600,
          color: '#92400e',
          background: '#fef3c7',
          borderRadius: '9999px',
          border: '1px solid #fde68a',
        }}>
          Review Only
        </span>
      )}
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
        @keyframes tandem-reconnect-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
