<script lang="ts">
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Editor as TiptapEditor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import StarterKit from "@tiptap/starter-kit";
import { untrack } from "svelte";
import * as Y from "yjs";
import type { EditorFontKey } from "../hooks/useEditorFont.svelte";
import { createEditorFont } from "../hooks/useEditorFont.svelte";
import { readStoredName, subscribeToUserName } from "../hooks/useUserName";
import { AnnotationExtension } from "./extensions/annotation";
import { AuthorshipExtension } from "./extensions/authorship";
import { AwarenessExtension } from "./extensions/awareness";
import { MarkdownHtmlExtension } from "./extensions/markdown-html";
import { SlashCommandExtension } from "./extensions/slash-command";
import "./editor.css";

interface Props {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  readOnly: boolean;
  reviewMode?: boolean;
  activeAnnotationId?: string | null;
  editorFont?: EditorFontKey;
  onEditorReady?: (editor: TiptapEditor | null) => void;
  onAnnotationClick?: (annotationId: string) => void;
  onSlashCommandMenuChange?: (open: boolean) => void;
}

const {
  ydoc,
  provider,
  readOnly,
  reviewMode,
  activeAnnotationId,
  editorFont = "sans",
  onEditorReady,
  onAnnotationClick,
  onSlashCommandMenuChange,
}: Props = $props();

let editor = $state<TiptapEditor | null>(null);
let editorRoot: HTMLDivElement | null = null;

createEditorFont(
  () => editorFont,
  () => editorRoot,
);

// -------------------------------------------------------------------------
// Editor lifecycle: re-create when (ydoc, provider) identity changes.
//
// Pattern matches CLAUDE.md gotcha "Y.XmlText must be attached before
// populating": Tiptap creates its own Y.XmlFragment binding via the
// Collaboration extension on the supplied ydoc. We must destroy any prior
// editor BEFORE creating the new one (avoid duplicate event subscriptions
// and torn observers). Cleanup runs before the effect re-runs.
// -------------------------------------------------------------------------
$effect(() => {
  // Track identity of ydoc + provider so this effect re-runs on swap.
  void ydoc;
  void provider;

  if (!editorRoot) return;

  const next = new TiptapEditor({
    element: editorRoot,
    extensions: [
      StarterKit.configure({ history: false }), // Yjs handles undo/redo
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
      MarkdownHtmlExtension,
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider,
        user: {
          name: readStoredName(),
          color: "var(--tandem-warning)",
        },
      }),
      AnnotationExtension.configure({ ydoc }),
      AuthorshipExtension.configure({ ydoc }),
      AwarenessExtension.configure({ ydoc }),
      SlashCommandExtension.configure({ onOpenChange: onSlashCommandMenuChange }),
    ],
    editorProps: {
      attributes: {
        class: "tandem-editor",
        style:
          "outline: none; min-height: 500px; font-size: var(--tandem-editor-font-size, 16px); line-height: 1.6;",
      },
    },
    editable: untrack(() => !readOnly),
  });

  editor = next;
  untrack(() => onEditorReady?.(next));

  return () => {
    untrack(() => onEditorReady?.(null));
    next.destroy();
    if (editor === next) editor = null;
  };
});

// -- readOnly toggling without recreating the editor -----------------------
$effect(() => {
  const ed = editor;
  if (!ed) return;
  ed.setEditable(!readOnly);
});

// -- Keep CollaborationCursor name synced with stored display name --------
$effect(() => {
  const ed = editor;
  if (!ed) return;
  return subscribeToUserName((name) => ed.commands.updateUser({ name }));
});

// -- Apply active annotation highlight class -------------------------------
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const container = ed.view.dom;

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
});

function handleEditorClick(e: MouseEvent) {
  const target = (e.target as HTMLElement).closest("[data-annotation-id]");
  if (!target) return;
  const annotationId = target.getAttribute("data-annotation-id");
  if (annotationId && onAnnotationClick) {
    onAnnotationClick(annotationId);
  }
}
</script>

<div class={reviewMode ? "tandem-review-dimmed" : ""} onclick={handleEditorClick} role="presentation">
  <div bind:this={editorRoot}></div>
</div>

<style>
  /* Apply editor font to the Tiptap content DOM (inside Tiptap's own element tree). */
  :global(.tandem-editor) {
    font-family: var(--tandem-editor-font-family);
  }
</style>
