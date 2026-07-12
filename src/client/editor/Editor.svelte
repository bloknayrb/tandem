<script lang="ts">
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Editor as TiptapEditor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { TextSelection } from "@tiptap/pm/state";
import { untrack } from "svelte";
import * as Y from "yjs";
import { readStoredName, subscribeToUserName } from "../hooks/useUserName";
import { openServerPath } from "../utils/server-paths";
import { installContextMenu } from "./context-menu/install";
// Schema-defining extensions (nodes + marks + static plugins) live in one shared
// module so the editor and tests register the same schema — see editor-extensions.ts.
import { buildSchemaExtensions } from "./editor-extensions";
import { AnnotationExtension } from "./extensions/annotation";
import { AnnotationPingExtension } from "./extensions/annotationPing";
import { AuthorshipExtension } from "./extensions/authorship";
import { AwarenessExtension } from "./extensions/awareness";
import { FindReplaceExtension } from "./extensions/find-replace";
import { HeadingCollapseExtension } from "./extensions/heading-collapse";
import { SelectionDecorationExtension } from "./extensions/selection-decoration";
import { SlashCommandExtension } from "./slash-menu";
import { markdownToSlice } from "./utils/markdown-paste";
import { buildPlainTextSlice } from "./utils/plain-paste";
import { isSafeExternalHref } from "./utils/url-safety";
import "./editor.css";

import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";

/** File extensions that open as new Tandem tabs when clicked as relative links. .docx excluded — not navigable as a link target. */
const INTERNAL_LINK_EXTS = new Set([...SUPPORTED_EXTENSIONS].filter((e) => e !== ".docx"));

// SAFE_EXTERNAL_PREFIXES + isSafeExternalHref hoisted to ./utils/url-safety.ts
// so the click-time anchor intercept and the paste-time link sanitizer share
// one allowlist (any drift would silently widen the XSS trust surface).

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
  /** Clicking editor text that is NOT an annotation clears the active selection. */
  onClearAnnotation?: () => void;
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
  onClearAnnotation,
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
      // Schema-defining extensions (StarterKit, ListItemCheckbox, the
      // underline/superscript/subscript marks, Highlight, Link, Image,
      // Placeholder, Table family, MarkdownHtml, RawMarkdown). Fresh instances
      // per rebuild; shared with the editor tests. See editor-extensions.ts.
      // Runtime-param extensions are appended below — order preserved so
      // ListItemCheckbox stays after StarterKit's listItem:false and
      // HeadingCollapse stays after AnnotationExtension (#650).
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider,
        user: {
          name: readStoredName(),
          color: "var(--tandem-warning)",
        },
      }),
      AnnotationExtension.configure({ ydoc }),
      // A4 (#798) gutter ping on annotation arrival — owns its own ephemeral
      // node-decoration set, independent of AnnotationExtension's perf-tuned
      // inline-decoration plugin (see annotationPing.ts).
      AnnotationPingExtension.configure({ ydoc }),
      // Registered AFTER AnnotationExtension so its chevron widgets render
      // above annotation decorations and its node-hide decorations win the
      // display: none vs annotation-class composition. Decoration ordering
      // matters here — see issue #650.
      HeadingCollapseExtension.configure({
        // Captured-once via untrack: the editor is keyed by activeTab.id in
        // App.svelte, so currentFilePath is stable for this editor's lifetime.
        // Passing a reactive $state value here would rebuild the editor on
        // every toggle. See the readOnly last-value guard at ~line 200.
        filePath: untrack(() => currentFilePath ?? null),
      }),
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
      // Paste raw markdown as formatted rich text (#788). We return a parsed
      // ProseMirror Slice so y-prosemirror's sync plugin captures it via the
      // normal paste transaction — we never touch the Y.Doc directly. When the
      // user requests plain-text paste (Ctrl+Shift+V → `plain === true`), or the
      // text isn't markdown-ish, we fall through to plain-text parsing.
      clipboardTextParser: (text, $context, plain, view) => {
        if (!plain) {
          const slice = markdownToSlice(text, view.state.schema);
          if (slice) return slice;
        }
        // Fall back to plain-text behavior: split on blank-line groups into
        // paragraphs, carrying the context's active marks. Shared with the
        // context menu's "Paste as Plain Text" (issue #923) so the two never
        // diverge.
        return buildPlainTextSlice(text, view.state.schema, $context.marks());
      },
      // Paste URL over a non-empty selection → link the selected text instead
      // of replacing it. Direct `editorProps` handlers run BEFORE both
      // `clipboardTextParser` above and Link's own `pasteHandler` plugin, so
      // returning true here suppresses both — no double handling regardless
      // of whether Link's paste-link behavior would also have fired.
      // Ctrl+Shift+V (plain paste) hits this path too: a bare URL carries no
      // formatting to strip, so "plain paste" and "rich paste" produce the
      // same result here. We deliberately don't branch on ProseMirror's
      // internal `view.input.shiftKey` — not a stable API surface.
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain")?.trim();
        if (!text || /\s/.test(text)) return false;
        if (!isSafeExternalHref(text)) return false;

        const { selection } = view.state;
        if (selection.empty || !(selection instanceof TextSelection)) return false;

        const linkType = view.state.schema.marks.link;
        if (!linkType) return false;

        view.dispatch(
          view.state.tr.addMark(selection.from, selection.to, linkType.create({ href: text })),
        );
        return true;
      },
    },
    editable: untrack(() => !readOnly),
    autofocus: untrack(() => !readOnly),
  });

  editor = next;
  untrack(() => onEditorReady?.(next));

  // Native (Tauri) context menu — issue #923. Bound to THIS editor instance
  // (never the reactive `editor` $state) and torn down before destroy so a
  // doc-switch can't leak the global Tauri listener. No-op in browser mode.
  const teardownContextMenu = installContextMenu(next, {
    openHref: (href) => {
      void openHref(href);
    },
  });

  return () => {
    untrack(() => onEditorReady?.(null));
    teardownContextMenu();
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

// Open a link href the same way for both the click intercept and the context
// menu's "Open Link" item (issue #923): safe external schemes go to the system
// browser, relative paths open as Tandem tabs, unrecognised schemes are
// dropped. The allowlist (`isSafeExternalHref`) is the single trust gate — both
// callers funnel through here so neither can drift. No-ops on empty/fragment.
async function openHref(href: string) {
  if (!href || href.startsWith("#")) return;

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
}

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
    await openHref(href);
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
  // Start below the lowest possible priority (-1 for unknown/missing types) so
  // an id-bearing element with an unknown `data-annotation-type` (priority -1)
  // still wins over "no match", preserving the innermost-fallback behavior.
  let bestPriority = Number.NEGATIVE_INFINITY;
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
  } else if (!bestId) {
    // Clicked editor text that isn't an annotation → deselect (empty selection
    // is a valid resting state). Inert for editing: clearing the selection-state
    // var has no document effect — the active-highlight effect above just strips
    // the `.tandem-annotation-active` class and skips re-adding it when the id is
    // null.
    onClearAnnotation?.();
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
