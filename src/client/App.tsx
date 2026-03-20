import React, { useState, useRef, useCallback, useEffect } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Editor } from './editor/Editor';
import { SidePanel } from './panels/SidePanel';
import { StatusBar } from './status/StatusBar';
import { Toolbar } from './editor/toolbar/Toolbar';
import { DEFAULT_WS_PORT } from '../shared/constants';
import type { Annotation } from '../shared/types';

export default function App() {
  const [connected, setConnected] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<string | null>(null);
  const [claudeActive, setClaudeActive] = useState(false);
  const [ready, setReady] = useState(false);

  // Stable refs for Y.Doc and provider — survive StrictMode double-mount
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const provider = new HocuspocusProvider({
      url: `ws://localhost:${DEFAULT_WS_PORT}`,
      name: 'default',
      document: ydoc,
    });
    providerRef.current = provider;

    // Connection status
    provider.on('status', ({ status }: { status: string }) => {
      setConnected(status === 'connected');
    });

    // Watch annotations Y.Map for changes
    const annotationsMap = ydoc.getMap('annotations');
    const annotationObserver = () => {
      const anns: Annotation[] = [];
      annotationsMap.forEach((value) => {
        anns.push(value as Annotation);
      });
      setAnnotations(anns);
    };
    annotationsMap.observe(annotationObserver);

    // Watch awareness Y.Map for Claude's status (with change guard to avoid no-op re-renders)
    const awarenessMap = ydoc.getMap('awareness');
    let prevStatus: string | null = null;
    let prevActive = false;
    const awarenessObserver = () => {
      const claude = awarenessMap.get('claude') as {
        status: string;
        timestamp: number;
        active: boolean;
      } | undefined;

      const newStatus = claude?.status ?? null;
      const newActive = claude?.active ?? false;
      if (newStatus !== prevStatus) {
        prevStatus = newStatus;
        setClaudeStatus(newStatus);
      }
      if (newActive !== prevActive) {
        prevActive = newActive;
        setClaudeActive(newActive);
      }
    };
    awarenessMap.observe(awarenessObserver);

    setReady(true);

    return () => {
      annotationsMap.unobserve(annotationObserver);
      awarenessMap.unobserve(awarenessObserver);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      providerRef.current = null;
      setReady(false);
    };
  }, []);

  const handleConnectionChange = useCallback((status: boolean) => {
    setConnected(status);
  }, []);

  // Don't render editor until Y.Doc and provider are ready
  if (!ready || !ydocRef.current || !providerRef.current) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#9ca3af' }}>
        Connecting...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 48px' }}>
          <Editor
            ydoc={ydocRef.current}
            provider={providerRef.current}
            onConnectionChange={handleConnectionChange}
          />
        </div>
        <SidePanel annotations={annotations} />
      </div>
      <StatusBar
        connected={connected}
        claudeStatus={claudeStatus}
        claudeActive={claudeActive}
      />
    </div>
  );
}
