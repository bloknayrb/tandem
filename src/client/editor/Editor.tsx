import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { AnnotationExtension } from './extensions/annotation';
import { AwarenessExtension } from './extensions/awareness';

interface EditorProps {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  onConnectionChange: (connected: boolean) => void;
  onEditorReady?: (editor: TiptapEditor | null) => void;
}

export function Editor({ ydoc, provider, onConnectionChange, onEditorReady }: EditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: false, // Yjs handles undo/redo
      }),
      Highlight.configure({ multicolor: true }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Placeholder.configure({
        placeholder: 'Open a document with Claude to get started...',
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Collaboration.configure({
        document: ydoc,
      }),
      CollaborationCursor.configure({
        provider: provider,
        user: { name: 'Bryan', color: '#f59e0b' },
      }),
      AnnotationExtension.configure({ ydoc }),
      AwarenessExtension.configure({ ydoc }),
    ],
    editorProps: {
      attributes: {
        class: 'tandem-editor',
        style: 'outline: none; min-height: 500px; font-size: 16px; line-height: 1.6;',
      },
    },
  }, [ydoc, provider]); // Re-create editor if ydoc or provider change

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div>
      <EditorContent editor={editor} />
      <style>{`
        .tandem-editor h1 { font-size: 2em; font-weight: 700; margin: 0.67em 0; }
        .tandem-editor h2 { font-size: 1.5em; font-weight: 600; margin: 0.75em 0; }
        .tandem-editor h3 { font-size: 1.17em; font-weight: 600; margin: 0.83em 0; }
        .tandem-editor p { margin: 0.5em 0; }
        .tandem-editor ul, .tandem-editor ol { padding-left: 1.5em; }
        .tandem-editor table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .tandem-editor td, .tandem-editor th { border: 1px solid #ddd; padding: 8px; }
        .tandem-editor th { background: #f5f5f5; font-weight: 600; }
        .tandem-editor blockquote {
          border-left: 3px solid #e5e7eb;
          margin: 0.5em 0;
          padding-left: 1em;
          color: #6b7280;
        }
        .collaboration-cursor__caret {
          position: relative;
          border-left: 2px solid;
          border-right: none;
          margin-left: -1px;
        }
        .collaboration-cursor__label {
          position: absolute;
          top: -1.4em;
          left: -1px;
          font-size: 12px;
          white-space: nowrap;
          padding: 0 4px;
          border-radius: 3px 3px 3px 0;
          color: white;
        }
        .ProseMirror-focused { outline: none; }
        .ProseMirror p.is-empty::before {
          content: attr(data-placeholder);
          color: #adb5bd;
          pointer-events: none;
          float: left;
          height: 0;
        }

        /* Annotation decorations */
        .tandem-highlight { cursor: pointer; }
        .tandem-highlight:hover { filter: brightness(0.95); }
        .tandem-comment { cursor: pointer; }
        .tandem-comment:hover { border-bottom-style: solid; }
        .tandem-suggestion { cursor: pointer; }

        /* Claude focus paragraph */
        .tandem-claude-focus {
          position: relative;
        }
        .tandem-claude-focus::before {
          content: '';
          position: absolute;
          left: -24px;
          top: 0;
          bottom: 0;
          width: 3px;
          background: rgba(99, 102, 241, 0.6);
          border-radius: 2px;
          animation: tandem-gutter-pulse 2s ease-in-out infinite;
        }
        @keyframes tandem-gutter-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
