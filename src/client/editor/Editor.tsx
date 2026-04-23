import { HocuspocusProvider } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import React, { useCallback, useEffect } from "react";
import * as Y from "yjs";
import { readStoredName, subscribeToUserName } from "../hooks/useUserName";
import { AnnotationExtension } from "./extensions/annotation";
import { AuthorshipExtension } from "./extensions/authorship";
import { AwarenessExtension } from "./extensions/awareness";
import "./editor.css";

interface EditorProps {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  readOnly: boolean;
  reviewMode?: boolean;
  activeAnnotationId?: string | null;
  onEditorReady?: (editor: TiptapEditor | null) => void;
  onAnnotationClick?: (annotationId: string) => void;
}

export function Editor({
  ydoc,
  provider,
  readOnly,
  reviewMode,
  activeAnnotationId,
  onEditorReady,
  onAnnotationClick,
}: EditorProps) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          history: false, // Yjs handles undo/redo
        }),
        Highlight.configure({ multicolor: true }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        }),
        Placeholder.configure({
          placeholder: "Open a document with Claude to get started...",
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
          user: {
            name: readStoredName(),
            color: "var(--tandem-warning)",
          },
        }),
        AnnotationExtension.configure({ ydoc }),
        AuthorshipExtension.configure({ ydoc }),
        AwarenessExtension.configure({ ydoc }),
      ],
      editorProps: {
        attributes: {
          class: "tandem-editor",
          style:
            "outline: none; min-height: 500px; font-size: var(--tandem-editor-font-size, 16px); line-height: 1.6;",
        },
      },
    },
    [ydoc, provider],
  ); // Re-create editor if ydoc or provider change

  // Toggle editable mode without recreating the editor (preserves HocuspocusProvider)
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [editor, readOnly]);

  // Keep the CollaborationCursor label in sync with the display name. The
  // cursor user is captured at editor creation, so a later name edit from
  // StatusBar or Settings won't propagate without this subscription.
  useEffect(() => {
    if (!editor) return;
    return subscribeToUserName((name) => editor.commands.updateUser({ name }));
  }, [editor]);

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // Apply active annotation highlight class based on activeAnnotationId
  useEffect(() => {
    if (!editor) return;
    const container = editor.view.dom;

    container.querySelectorAll(".tandem-annotation-active").forEach((el) => {
      el.classList.remove("tandem-annotation-active");
    });

    if (activeAnnotationId && reviewMode) {
      container
        .querySelectorAll(`[data-annotation-id="${CSS.escape(activeAnnotationId)}"]`)
        .forEach((el) => {
          el.classList.add("tandem-annotation-active");
        });
    }
  }, [editor, activeAnnotationId, reviewMode]);

  const handleEditorClick = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest("[data-annotation-id]");
      if (!target) return;
      const annotationId = target.getAttribute("data-annotation-id");
      if (annotationId && onAnnotationClick) {
        onAnnotationClick(annotationId);
      }
    },
    [onAnnotationClick],
  );

  const containerClass = reviewMode ? "tandem-review-dimmed" : "";

  return (
    <div className={containerClass} onClick={handleEditorClick}>
      <EditorContent editor={editor} />
    </div>
  );
}
