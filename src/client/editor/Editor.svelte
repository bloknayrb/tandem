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
import { readStoredName, subscribeToUserName } from "../hooks/useUserName";
import { openServerPath } from "../utils/server-paths";
import { AnnotationExtension } from "./extensions/annotation";
import { AuthorshipExtension } from "./extensions/authorship";
import { AwarenessExtension } from "./extensions/awareness";
import { FindReplaceExtension } from "./extensions/find-replace";
import { MarkdownHtmlExtension } from "./extensions/markdown-html";
import { SelectionDecorationExtension } from "./extensions/selection-decoration";
import { SlashCommandExtension } from "./slash-menu";
import "./editor.css";

import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";

/** File extensions that open as new Tandem tabs when clicked as relative links. .docx excluded — not navigable as a link target. */
const INTERNAL_LINK_EXTS = new Set([...SUPPORTED_EXTENSIONS].filter((e) => e !== ".docx"));

/**
 * Whitelist of safe external href prefixes that we'll hand off to the default
 * browser via window.open. Anything not in this list and not a relative path
 * (e.g. `javascript:`, `data:`, `vbscript:`) is treated as unsafe and ignored —
 * preventDefault has already been called by the time we check this, so the
 * browser won't navigate.
 */
const SAFE_EXTERNAL_PREFIXES = ["http://", "https://", "mailto:", "ftp://", "//"] as const;

function isSafeExternalHref(href: string): boolean {
  return SAFE_EXTERNAL_PREFIXES.some((p) => href.startsWith(p));
}

/**
 * Resolve a relative href against an absolute file path.
 * Works on both POSIX and Windows paths by detecting the separator.
 * Returns null if the resolved path's extension is not in INTERNAL_LINK_EXTS.
 */
function resolveRelativeLink(href: string, currentFilePath: string): string | null {
  // Detect Windows vs POSIX
  const sep = currentFilePath.includes("\\") ? "\\" : "/";

  // Strip hash fragment for resolution; we don't support in-page anchors cross-file
  const hashIdx = href.indexOf("#");
  const hrefPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (!hrefPath) return null; // pure fragment (#section) — not a file link

  // Check extension
  const extMatch = hrefPath.match(/\.[^./\\]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  if (!INTERNAL_LINK_EXTS.has(ext)) return null;

  // Get directory of current file (convert forward slashes in href to platform sep)
  const dirParts = currentFilePath.split(sep);
  dirParts.pop(); // remove filename

  // Normalize the href to use the platform separator
  const hrefNormalized = hrefPath.replace(/\//g, sep);
  const hrefParts = hrefNormalized.split(sep);

  // Merge directory + relative parts, resolving . and ..
  const resultParts = [...dirParts];
  for (const part of hrefParts) {
    if (part === "..") {
      if (resultParts.length > 0) resultParts.pop();
    } else if (part !== ".") {
      resultParts.push(part);
    }
  }

  return resultParts.join(sep);
}

interface Props {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  readOnly: boolean;
  /** Absolute path of the currently open file — used to resolve relative links. */
  currentFilePath?: string | null;
  /** Active document's file format (e.g. "docx", "md"). Drives the paged white-sheet layout for .docx. */
  format?: string | null;
  activeAnnotationId?: string | null;
  onEditorReady?: (editor: TiptapEditor | null) => void;
  onAnnotationClick?: (annotationId: string) => void;
  onSlashCommandMenuChange?: (open: boolean) => void;
}

const {
  ydoc,
  provider,
  readOnly,
  currentFilePath,
  format,
  activeAnnotationId,
  onEditorReady,
  onAnnotationClick,
  onSlashCommandMenuChange,
}: Props = $props();

let editor = $state<TiptapEditor | null>(null);
let editorRoot: HTMLDivElement | null = null;

// Paged white-sheet-on-gray-canvas layout for .docx files. Must be `$derived`
// (not `const`) so it updates when the active document changes — see
// feedback_svelte_const_vs_derived. CSS-driven: applies `.tandem-paged` to the
// editor root; styles live in editor.css. No DOM injection.
const isPaged = $derived(format === "docx");

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
        placeholder: "Start typing…",
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
      FindReplaceExtension,
      SelectionDecorationExtension,
    ],
    editorProps: {
      attributes: {
        class: "tandem-editor",
        // `min-height` lives in editor.css (`.tandem-editor` = 500px,
        // `.tandem-paged .tandem-editor` = 1056px). Inline `min-height` here
        // would beat the paged-layout selector via specificity and silently
        // lose the 11in sheet height for .docx.
        style: "outline: none; font-size: var(--tandem-editor-font-size, 16px); line-height: 1.6;",
      },
    },
    editable: untrack(() => !readOnly),
    autofocus: untrack(() => !readOnly),
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
// Tiptap's `setEditable` synchronously emits an "update" event every call.
// FindReplaceBar's bumpTick listener writes `tick++` on every update, which
// re-flushes Svelte effects; a redundant readOnly re-delivery cascading
// through Tiptap update emits can trip Svelte's effect_update_depth_exceeded
// guard on doc open (observed when opening docs/roadmap.md). Guard with a
// last-value check so no-op re-runs short-circuit before reaching Tiptap.
// See: feedback_svelte_effect_depth_guard.
let _lastReadOnly: boolean | undefined;
$effect(() => {
  const ed = editor;
  if (!ed) return;
  const ro = readOnly;
  if (_lastReadOnly === ro) return;
  _lastReadOnly = ro;
  ed.setEditable(!ro);
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

  if (activeAnnotationId) {
    container
      .querySelectorAll(`[data-annotation-id="${CSS.escape(activeAnnotationId)}"]`)
      .forEach((el) => {
        el.classList.add("tandem-annotation-active");
      });
  }
});

async function handleEditorClick(e: MouseEvent) {
  // --- Anchor intercept (closes #479) --------------------------------------
  // We want to own every anchor click except in-page fragments: relative links
  // open as new Tandem tabs, safe-protocol external links open in the default
  // browser, and unrecognised schemes (javascript:, data:, …) are silently
  // dropped so they can't navigate the editor frame.
  const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";

    // Empty href or pure fragment → let the browser handle (in-page scroll).
    if (!href || href.startsWith("#")) {
      return;
    }

    // Take ownership of this click — even if no branch below handles it,
    // we don't want the browser navigating to a javascript:/data:/etc URL.
    e.preventDefault();

    if (isSafeExternalHref(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }

    // Treat anything else with a recognised file extension as a relative path.
    if (currentFilePath) {
      const resolvedPath = resolveRelativeLink(href, currentFilePath);
      if (resolvedPath) {
        const result = await openServerPath(resolvedPath);
        if (!result.ok) {
          console.warn(`[tandem] Could not open linked file "${resolvedPath}": ${result.error}`);
        }
      }
    }
    return;
  }

  // --- Annotation click ----------------------------------------------------
  // #768 Bug 2: when annotations overlap (e.g. a highlight inside a Claude
  // comment span), ProseMirror's `Decoration.inline()` nests the wrapper
  // spans. Nesting order comes from `annotationsMap.forEach()` iteration in
  // buildDecorations — not user-meaningful. Using `closest()` alone returns
  // the *innermost* match, so a user's recent highlight could be hidden
  // under a Claude comment wrapper and clicking would focus the comment.
  //
  // Fix: enumerate ALL `[data-annotation-id]` ancestors at the click point
  // and apply a stable priority tiebreaker:
  //   highlight (2) > comment (1) > note (0)
  // Rationale: a highlight is typically the most-recent intentional user
  // action and the most visually obvious target at the click point; notes
  // are user-private; comments live between. Ties (two annotations of the
  // same type at overlapping ranges) resolve to the innermost — `>` rather
  // than `>=` preserves the first-seen (innermost) winner on equal priority.
  const TYPE_PRIORITY: Record<string, number> = {
    highlight: 2,
    comment: 1,
    note: 0,
  };
  let cursor: HTMLElement | null = (e.target as HTMLElement).closest(
    "[data-annotation-id]",
  ) as HTMLElement | null;
  let bestId: string | null = null;
  let bestPriority = -1;
  while (cursor) {
    const id = cursor.getAttribute("data-annotation-id");
    if (id) {
      const type = cursor.getAttribute("data-annotation-type") ?? "";
      const priority = TYPE_PRIORITY[type] ?? -1;
      if (priority > bestPriority) {
        bestPriority = priority;
        bestId = id;
      }
    }
    const parent = cursor.parentElement;
    cursor = parent ? (parent.closest("[data-annotation-id]") as HTMLElement | null) : null;
  }
  if (bestId && onAnnotationClick) {
    onAnnotationClick(bestId);
  }
}
</script>

<div
  bind:this={editorRoot}
  onclick={handleEditorClick}
  role="presentation"
  data-testid="editor-root"
  class:tandem-paged={isPaged}
></div>

<style>
  /* Apply editor font to the Tiptap content DOM (inside Tiptap's own element tree). */
  :global(.tandem-editor) {
    font-family: var(--tandem-editor-font-family);
  }
</style>
