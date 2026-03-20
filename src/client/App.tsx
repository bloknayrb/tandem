import React, { useState, useRef, useCallback, useEffect } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Editor } from './editor/Editor';
import { SidePanel } from './panels/SidePanel';
import { StatusBar } from './status/StatusBar';
import { Toolbar } from './editor/toolbar/Toolbar';
import type { Annotation } from '../shared/types';

export default function App() {
  const [connected, setConnected] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [ready, setReady] = useState(false);

  // Stable refs for Y.Doc and provider — survive StrictMode double-mount
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const wsPort = 3478;
    const provider = new WebsocketProvider(`ws://localhost:${wsPort}`, 'default', ydoc);
    providerRef.current = provider;

    // Connection status
    provider.on('status', ({ status }: { status: string }) => {
      setConnected(status === 'connected');
    });

    // Watch annotations Y.Map for changes
    const annotationsMap = ydoc.getMap('annotations');
    const observer = () => {
      const anns: Annotation[] = [];
      annotationsMap.forEach((value) => {
        anns.push(value as Annotation);
      });
      setAnnotations(anns);
    };
    annotationsMap.observe(observer);

    setReady(true);

    return () => {
      annotationsMap.unobserve(observer);
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
      <StatusBar connected={connected} />
    </div>
  );
}
