<script lang="ts">
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Editor as TiptapEditor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Typography from "@tiptap/extension-typography";
import { untrack } from "svelte";
import * as Y from "yjs";
import type { TandemNotification } from "../../shared/types.js";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";
import { readStoredName, subscribeToUserName } from "../hooks/useUserName";
import { openServerPath } from "../utils/server-paths";
import { installContextMenu } from "./context-menu/install";
// Schema-defining extensions (nodes + marks + static plugins) live in one shared
// module so the editor and tests register the same schema — see editor-extensions.ts.
import { buildSchemaExtensions } from "./editor-extensions";
import { makeEditorProps } from "./editor-props";
import { AnnotationExtension } from "./extensions/annotation";
import { AnnotationPingExtension } from "./extensions/annotationPing";
import { AuthorshipExtension } from "./extensions/authorship";
import { AwarenessExtension } from "./extensions/awareness";
import { FindReplaceExtension } from "./extensions/find-replace";
import { HeadingCollapseExtension } from "./extensions/heading-collapse";
import { PlaintextBreaksExtension } from "./extensions/plaintext-breaks";
import { SelectionDecorationExtension } from "./extensions/selection-decoration";
import { SlashCommandExtension } from "./slash-menu";
import { applyLink, getInitialLinkHref } from "./toolbar/handlers";
import LinkEditor from "./toolbar/LinkEditor.svelte";
// resolveRelativeLink + INTERNAL_LINK_EXTS hoisted to ./utils/relative-link.ts:
// module-private here, it had zero test coverage, and its fail-closed traversal
// guards are exactly the kind of thing that has to be tested.
import {
  LINKABLE_EXTS_LABEL,
  resolveRelativeLink,
  SECURITY_REJECT_REASONS,
} from "./utils/relative-link";
import { isSafeExternalHref } from "./utils/url-safety";
import "./editor.css";

// SAFE_EXTERNAL_PREFIXES + isSafeExternalHref hoisted to ./utils/url-safety.ts
// so the click-time anchor intercept and the paste-time link sanitizer share
// one allowlist (any drift would silently widen the XSS trust surface).

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
  /** Intent-only callbacks used by the desktop native editor menu. */
  onFocusChat?: () => void;
  onComposeAnnotation?: (kind: "comment" | "note") => void;
  /**
   * Surface a link-open failure to the user. Threaded as a prop rather than
   * calling `createNotifications()` here: that factory is NOT a singleton (it
   * opens a fresh `EventSource` per call), so a second instantiation would
   * duplicate the SSE subscription and the tray.
   */
  onNotify?: (n: TandemNotification) => void;
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
  onFocusChat,
  onComposeAnnotation,
  onNotify,
}: Props = $props();

let editor = $state<TiptapEditor | null>(null);
let editorRoot: HTMLDivElement | null = null;
let showContextLinkEditor = $state(false);
let contextLinkHref = $state("");
let contextLinkPosition = $state("position: fixed; left: 16px; top: 16px;");

// Paged white-sheet-on-gray-canvas layout for .docx files. Must be `$derived`
// (not `const`) so it updates when the active document changes — see
// feedback_svelte_const_vs_derived. CSS-driven: applies `.tandem-paged` to the
// editor root; styles live in editor.css. No DOM injection.
const isPaged = $derived(format === "docx");

// Singleton settings store (safe by design — see createTandemSettings'
// doc-comment; StatusBar.svelte is the existing precedent for reaching it
// straight from a leaf component instead of threading a prop through
// App.svelte).
const settingsState = createTandemSettings();

// `settings` is wholesale-reassigned on every settings write (any field, not
// just these two), so reading `settingsState.settings.smartTypography` /
// `.spellcheck` directly inside an `$effect` would track the whole object
// and rebuild/re-apply on every unrelated settings change. These `$derived`
// memos narrow tracking to just the one boolean each — load-bearing, not
// stylistic.
const smartTypography = $derived(settingsState.settings.smartTypography);
const spellcheckOn = $derived(settingsState.settings.spellcheck);

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
  // Also track `smartTypography` (via the narrow $derived memo above, not
  // raw `settingsState.settings`) so toggling the setting tears down and
  // rebuilds the editor — the only way to add/remove an extension from
  // Tiptap's ExtensionManager. Same lifecycle cost as a tab switch; cheap
  // and infrequent (a Settings-modal checkbox flip, not a hot path).
  const smartTypographyOn = smartTypography;

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
      // A4: opt-in smart typography (smart quotes/dashes/ellipsis as you
      // type). Default off; conditionally included based on the tracked
      // `smartTypographyOn` above — and that CONDITIONAL INCLUSION is why it
      // is assembled here rather than in buildSchemaExtensions(), which takes
      // no params and cannot see a setting. Adding no nodes or marks is not by
      // itself the test: TableColumnAlignExtension (#995) adds neither and does
      // live in that builder, deliberately, so the client tests exercise its
      // real registration.
      ...(smartTypographyOn ? [Typography] : []),
      // #1460: a plaintext document cannot store a newline inside a textblock,
      // so Shift+Enter has to split the block instead of inserting a hardBreak.
      //
      // `getFormat` is a live getter, NOT `untrack`ed like `filePath` above, and
      // the difference is the point: Save-As promotes a document in place (same
      // docId, same ydoc, same provider), so this editor survives a `.md`
      // scratchpad becoming a `.txt` file. A captured format would stay "md" and
      // keep accepting hardBreaks into a document that is now plaintext.
      PlaintextBreaksExtension.configure({ getFormat: () => format ?? undefined }),
    ],
    editorProps: makeEditorProps(
      untrack(() => spellcheckOn),
      () => format ?? undefined,
    ),
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
    focusChat: () => onFocusChat?.(),
    composeAnnotation: (kind) => onComposeAnnotation?.(kind),
    editLink: () => {
      // Re-read from the current PM selection; the href captured by the
      // right-click host remains private and is never round-tripped through Rust.
      if (!next.isEditable || !next.isActive("link")) return;
      contextLinkHref = getInitialLinkHref(next);
      try {
        const coords = next.view.coordsAtPos(next.state.selection.head);
        const left = Math.max(8, Math.min(coords.left, window.innerWidth - 264));
        const top = Math.max(8, Math.min(coords.bottom + 6, window.innerHeight - 56));
        contextLinkPosition = `position: fixed; left: ${left}px; top: ${top}px;`;
      } catch {
        contextLinkPosition = "position: fixed; left: 16px; top: 16px;";
      }
      showContextLinkEditor = true;
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

// -- A5: spellcheck toggling without recreating the editor ------------------
// `setOptions({ editorProps })` replaces `editorProps` wholesale (not a
// shallow merge), so `makeEditorProps` always rebuilds the full object
// (attributes + clipboardTextParser + clipboardTextSerializer + handlePaste),
// not just the spellcheck bit. No last-value guard needed here (unlike `_lastReadOnly` above):
// `spellcheckOn` is a memoized `$derived` of a primitive, so this effect only
// re-fires on a real toggle — or on editor recreation, where the one
// same-value `setOptions` call is harmless (the new editor was already
// constructed with the current value).
$effect(() => {
  const ed = editor;
  if (!ed) return;
  // The format getter has to be re-supplied here too. `setOptions` replaces
  // `editorProps` wholesale, so omitting it would silently drop the #1460 paste
  // guard the moment anyone toggles spellcheck — the guard would be present,
  // correct, and unreachable. Passing a getter rather than a value keeps this
  // effect from gaining `format` as a dependency: the closure is built here but
  // only read later, inside a paste handler.
  ed.setOptions({ editorProps: makeEditorProps(spellcheckOn, () => format ?? undefined) });
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

function notifyLinkProblem(message: string, severity: "warning" | "error", dedupKey: string): void {
  onNotify?.({
    id: `link-problem-${Date.now()}`,
    type: "general-error",
    severity,
    message,
    dedupKey,
    timestamp: Date.now(),
    errorCode: "LINK_NOT_OPENABLE",
  });
}

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
  //
  // #1377 widened the RENDER boundary without widening this one, so an href can
  // now be clickable — pointer cursor, hover tooltip naming a destination — and
  // still be refused here. Every refusal therefore has to SAY so. A
  // `console.warn` alone is not a channel in the primary distribution: the
  // Tauri release build ships no `devtools` feature, so there is no inspector
  // the user can open. (Since #1439 `utils/client-log.ts` does carry warnings
  // into the diagnostics report — but this refusal is one the user needs to see
  // NOW, not one a maintainer reads afterwards, so the notice stays.)
  if (!currentFilePath) {
    notifyLinkProblem(
      `Can't follow "${href}" — save this document to disk first so relative links have somewhere to resolve against.`,
      "warning",
      `link-no-file:${href}`,
    );
    return;
  }

  const resolved = resolveRelativeLink(href, currentFilePath);
  if (!resolved.ok) {
    // A blocked traversal and a mistyped extension are not the same event. The
    // first is something a hostile or model-authored document put in front of
    // the user — MCP tools write markdown into these files — and it needs a
    // durable record, not a line in a console nobody can open.
    const hostile = SECURITY_REJECT_REASONS.has(resolved.reason);
    notifyLinkProblem(
      hostile
        ? `Blocked a link pointing outside this document's folder: "${href}"`
        : `Can't open "${href}" — Tandem follows links to ${LINKABLE_EXTS_LABEL} files relative to this document.`,
      hostile ? "error" : "warning",
      `link-rejected:${resolved.reason}:${href}`,
    );
    console.warn(`[tandem] Link refused (${resolved.reason}): "${href}"`);
    return;
  }

  const result = await openServerPath(resolved.path);
  if (!result.ok) {
    notifyLinkProblem(
      `Couldn't open "${resolved.path}": ${result.error}`,
      "error",
      `link-open-failed:${resolved.path}`,
    );
    console.warn(`[tandem] Could not open linked file "${resolved.path}": ${result.error}`);
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
<LinkEditor
  open={showContextLinkEditor}
  initialValue={contextLinkHref}
  positionStyle={contextLinkPosition}
  testIdPrefix="context-link"
  onApply={(value) => {
    if (editor && !editor.isDestroyed && editor.isEditable && editor.isActive("link")) {
      applyLink(editor, value);
    }
    showContextLinkEditor = false;
  }}
  onClose={() => {
    showContextLinkEditor = false;
    editor?.view.focus();
  }}
/>

<style>
  /* Apply editor font to the Tiptap content DOM (inside Tiptap's own element tree). */
  :global(.tandem-editor) {
    font-family: var(--tandem-editor-font-family);
  }
</style>
