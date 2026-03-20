// Annotation types
export type AnnotationType = 'highlight' | 'comment' | 'suggestion' | 'overlay';
export type AnnotationStatus = 'pending' | 'accepted' | 'dismissed';
export type HighlightColor = 'yellow' | 'red' | 'green' | 'blue' | 'purple';
export type Severity = 'info' | 'warning' | 'error' | 'success';

export interface Annotation {
  id: string;
  author: 'user' | 'claude';
  type: AnnotationType;
  range: DocumentRange;
  content: string;
  status: AnnotationStatus;
  timestamp: number;
  color?: HighlightColor;
}

export interface DocumentRange {
  from: number;
  to: number;
}

export interface AnchoredRange {
  start: { nodeId: string; offset: number };
  end: { nodeId: string; offset: number };
  textSnapshot: string;
  stale: boolean;
}

export interface OverlayEntry {
  id: string;
  overlayId: string;
  range: AnchoredRange;
  score: string;
  numericScore?: number;
  detail: {
    summary: string;
    explanation: string;
    suggestion?: string;
    severity?: Severity;
    references?: Array<{ label: string; url?: string; documentNodeId?: string }>;
  };
  dismissed: boolean;
  accepted?: boolean;
  data: Record<string, unknown>;
}

export interface OverlayDefinition {
  id: string;
  label: string;
  type: string;
  visible: boolean;
  mode: 'snapshot' | 'live';
  entries: OverlayEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface DocumentGroup {
  id: string;
  name: string;
  documents: DocumentInfo[];
  createdAt: number;
}

export interface DocumentInfo {
  id: string;
  filePath: string;
  fileName: string;
  format: 'md' | 'txt' | 'html' | 'docx';
  tokenEstimate: number;
  pageEstimate: number;
  readOnly: boolean;
}

export interface ServerInfo {
  port: number;
  url: string;
  pid: number;
  startedAt: number;
}

export interface ToolSuccess<T = unknown> {
  error: false;
  data: T;
  version?: string;
}

export interface ToolError {
  error: true;
  code: 'RANGE_STALE' | 'FILE_LOCKED' | 'FILE_NOT_FOUND' | 'NO_DOCUMENT' | 'INVALID_RANGE' | 'FORMAT_ERROR';
  message: string;
  details?: Record<string, unknown>;
}

export type ToolResponse<T = unknown> = ToolSuccess<T> | ToolError;

export interface AwarenessState {
  user: string;
  color: string;
  cursor?: { from: number; to: number };
  status?: string;
  isTyping?: boolean;
  lastActivity?: number;
}

/** Claude's awareness state as stored in Y.Map('awareness') key 'claude' */
export interface ClaudeAwareness {
  status: string;
  timestamp: number;
  active: boolean;
  focusParagraph: number | null;
}

export interface SessionData {
  filePath: string;
  annotations: Annotation[];
  overlays: OverlayDefinition[];
  groupId?: string;
  lastAccessed: number;
}
