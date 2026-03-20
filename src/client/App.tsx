import React, { useState, useMemo, useCallback, useEffect } from 'react';
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

  // Create Y.Doc and WebSocket provider once, stable across renders
  const { ydoc, provider } = useMemo(() => {
    const ydoc = new Y.Doc();
    const wsPort = 3478;
    const provider = new WebsocketProvider(`ws://localhost:${wsPort}`, 'default', ydoc);
    return { ydoc, provider };
  }, []);

  // Connection status
  useEffect(() => {
    const handler = ({ status }: { status: string }) => {
      setConnected(status === 'connected');
    };
    provider.on('status', handler);
    return () => {
      provider.off('status', handler);
    };
  }, [provider]);

  // Watch annotations Y.Map for changes
  useEffect(() => {
    const annotationsMap = ydoc.getMap('annotations');
    const observer = () => {
      const anns: Annotation[] = [];
      annotationsMap.forEach((value) => {
        anns.push(value as Annotation);
      });
      setAnnotations(anns);
    };
    annotationsMap.observe(observer);
    return () => {
      annotationsMap.unobserve(observer);
    };
  }, [ydoc]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      provider.destroy();
      ydoc.destroy();
    };
  }, [provider, ydoc]);

  const handleConnectionChange = useCallback((status: boolean) => {
    setConnected(status);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 48px' }}>
          <Editor
            ydoc={ydoc}
            provider={provider}
            onConnectionChange={handleConnectionChange}
          />
        </div>
        <SidePanel annotations={annotations} />
      </div>
      <StatusBar connected={connected} />
    </div>
  );
}
