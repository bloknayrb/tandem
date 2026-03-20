import React from 'react';

interface CommentThreadProps {
  threadId: string;
}

export function CommentThread({ threadId }: CommentThreadProps) {
  return (
    <div style={{ padding: '8px', borderBottom: '1px solid #e5e7eb' }}>
      <p style={{ fontSize: '13px', color: '#9ca3af' }}>Thread {threadId}</p>
    </div>
  );
}
