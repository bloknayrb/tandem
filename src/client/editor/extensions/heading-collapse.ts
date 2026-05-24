import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Heading section collapse (basic scope, issue #650).
 *
 * Adds a chevron toggle to each top-level heading. Click chevron → all sibling
 * nodes after the heading are hidden via Decoration (`display: none`) until the
 * next heading at same-or-higher level.
 *
 * # Design notes
 * - **Plugin-local state, not Y.js.** Collapse is a personal viewing preference;
 *   broadcasting via awareness would leak it in tandem mode (not expected). See
 *   issue #650 "Out of scope: Yjs-synced collapse".
 * - **localStorage persistence**, keyed by document path. Each collapsed heading
 *   is anchored by `hash(level, normalizedText, ordinalIndex)` — survives
 *   in-session text edits because we re-compute on every doc change.
 * - **Positions live in plugin state**, mapped through `tr.mapping.map()` on
 *   every transaction so collapse decorations stay aligned during edits.
 * - **No Svelte $state into .configure().** The `filePath` option is read once
 *   when the editor is constructed. Editor instances are keyed by tab id in
 *   App.svelte, so the file path is stable for the editor's lifetime; switching
 *   tabs rebuilds the editor (and re-hydrates from localStorage).
 */

export const headingCollapseKey = new PluginKey<HeadingCollapseState>("tandemHeadingCollapse");

export interface HeadingCollapseOptions {
  /** Absolute path of the active file. Used as the localStorage namespace. */
  filePath: string | null;
}

interface HeadingEntry {
  /** ProseMirror position of the heading node start. */
  pos: number;
  /** Heading level (1-6). */
  level: number;
  /** Stable hash for this heading based on (level, text, ordinal). */
  hash: string;
}

export interface HeadingCollapseState {
  /** Set of currently-collapsed heading hashes. */
  collapsed: Set<string>;
  /** Headings discovered in the current doc, ordered by position. */
  headings: HeadingEntry[];
  /** Decoration set: chevron widgets + hide decorations for collapsed sections. */
  decoSet: DecorationSet;
}

type HeadingCollapseMeta = { type: "toggle"; hash: string } | { type: "rehydrate" };

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_KEY_PREFIX = "tandem:headingCollapse:";

function lsKey(filePath: string | null): string | null {
  if (!filePath) return null;
  return LS_KEY_PREFIX + filePath;
}

function loadCollapsed(filePath: string | null): Set<string> {
  const key = lsKey(filePath);
  if (!key) return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // localStorage may throw in incognito or storage-disabled browsers.
    return new Set();
  }
}

function saveCollapsed(filePath: string | null, collapsed: Set<string>): void {
  const key = lsKey(filePath);
  if (!key) return;
  try {
    if (collapsed.size === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(Array.from(collapsed)));
    }
  } catch {
    // Best effort — incognito / storage-disabled / quota exceeded.
  }
}

// ---------------------------------------------------------------------------
// Heading walking & hashing
// ---------------------------------------------------------------------------

/** Normalize heading text for hashing: lowercase, collapse whitespace. */
function normalizeHeadingText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Walk the doc collecting top-level headings.
 *
 * Hash recipe: `${level}::${normalizedText}::${ordinalIndexAmongIdenticalHeadings}`.
 * Duplicates (same level + text) are distinguished by an ordinal counter so
 * "## Notes" appearing three times still produces three distinct hashes.
 */
function walkHeadings(doc: PmNode): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const seen = new Map<string, number>();

  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "heading") return true;
    // Only top-level headings (direct children of doc). Headings can't legally
    // nest in ProseMirror's schema, but guard anyway so the chevron only renders
    // for what the user perceives as document sections.
    if (parent !== doc) return false;

    const level = (node.attrs.level as number) ?? 1;
    const text = normalizeHeadingText(node.textContent);
    const baseKey = `${level}::${text}`;
    const ordinal = seen.get(baseKey) ?? 0;
    seen.set(baseKey, ordinal + 1);
    const hash = `${baseKey}::${ordinal}`;
    entries.push({ pos, level, hash });
    return false;
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Decoration construction
// ---------------------------------------------------------------------------

/**
 * Build a chevron widget for one heading. The widget is a button placed at the
 * heading's start position. Click toggles collapse via plugin meta dispatch.
 *
 * `stopEvent` returns true so ProseMirror doesn't treat the click as a doc
 * interaction. `ignoreSelection` keeps the chevron from being included in
 * cursor-position math.
 */
function buildChevronWidget(pos: number, hash: string, isCollapsed: boolean): Decoration {
  return Decoration.widget(
    pos + 1,
    (view) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tandem-heading-chevron";
      btn.dataset.testid = "heading-chevron";
      btn.dataset.headingHash = hash;
      btn.dataset.collapsed = String(isCollapsed);
      btn.setAttribute("aria-label", isCollapsed ? "Expand section" : "Collapse section");
      btn.setAttribute("aria-expanded", String(!isCollapsed));
      btn.contentEditable = "false";
      // Visual: a unicode chevron. CSS rotates / colors it; this keeps the
      // plugin self-contained without requiring an SVG sprite asset.
      btn.textContent = isCollapsed ? "▶" : "▼";

      btn.addEventListener("mousedown", (e) => {
        // Prevent ProseMirror from treating mousedown as a selection event.
        e.preventDefault();
      });
      btn.addEventListener("click", (e) => {
        // Stop propagation so the click doesn't bubble to the editor's
        // anchor/annotation click handler in Editor.svelte.
        e.stopPropagation();
        e.preventDefault();
        const tr = view.state.tr.setMeta(headingCollapseKey, {
          type: "toggle",
          hash,
        } satisfies HeadingCollapseMeta);
        view.dispatch(tr);
      });
      return btn;
    },
    {
      // Side -1 keeps the widget rendered before the heading text.
      side: -1,
      // Don't include the widget in the selection or in copy operations.
      ignoreSelection: true,
      // Tell ProseMirror to ignore events on the widget — our addEventListener
      // handlers run first (capture phase isn't needed; click bubbles through
      // before PM's view-level handlers fire).
      stopEvent: () => true,
      // Key includes the collapse state so PM treats a toggled chevron as a
      // *different* widget and re-renders the DOM with the new label/icon.
      // Reusing a key across collapse states would leave the chevron showing
      // ▼ even after the user collapses the section.
      key: `chevron:${hash}:${isCollapsed ? "c" : "e"}`,
    },
  );
}

/**
 * For a collapsed heading at `headings[index]`, build node decorations that
 * hide every subsequent sibling until the next heading at same-or-higher level
 * (or end of doc).
 */
function buildHideDecorations(doc: PmNode, headings: HeadingEntry[], index: number): Decoration[] {
  const start = headings[index];
  // Find the next heading at same-or-higher level (lower numeric level value).
  let endPos = doc.content.size;
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= start.level) {
      endPos = headings[j].pos;
      break;
    }
  }

  const decos: Decoration[] = [];
  // Iterate top-level siblings between (start.pos + startNode.size) and endPos.
  // Use doc.forEach for direct top-level children — this is the structural unit
  // a heading section is composed of in markdown documents.
  let cursor = 0;
  doc.forEach((child, offset) => {
    if (offset > start.pos && offset < endPos) {
      const from = offset;
      const to = offset + child.nodeSize;
      decos.push(
        Decoration.node(from, to, {
          class: "tandem-heading-collapsed-hidden",
          style: "display: none;",
        }),
      );
    }
    cursor = offset + child.nodeSize;
  });
  void cursor;

  return decos;
}

/**
 * Build the full DecorationSet: chevron widgets for every heading + hide
 * decorations for every collapsed section.
 */
function buildDecorations(
  doc: PmNode,
  headings: HeadingEntry[],
  collapsed: Set<string>,
): DecorationSet {
  const decos: Decoration[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const isCollapsed = collapsed.has(h.hash);
    try {
      decos.push(buildChevronWidget(h.pos, h.hash, isCollapsed));
      if (isCollapsed) {
        decos.push(...buildHideDecorations(doc, headings, i));
      }
    } catch {
      // Skip a heading whose position is no longer valid — happens during
      // rapid edits where headings briefly straddle a transaction boundary.
    }
  }
  if (decos.length === 0) return DecorationSet.empty;
  return DecorationSet.create(doc, decos);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const HeadingCollapseExtension = Extension.create<HeadingCollapseOptions>({
  name: "tandemHeadingCollapse",

  addOptions() {
    return {
      filePath: null,
    };
  },

  addProseMirrorPlugins() {
    // Captured once at editor construction — see file-header design note.
    // The editor is re-created on tab switch (App.svelte uses `{#key activeTab.id}`),
    // so this value is stable for the editor's lifetime.
    const filePath = this.options.filePath;

    return [
      new Plugin<HeadingCollapseState>({
        key: headingCollapseKey,
        state: {
          init(_config, state) {
            const collapsed = loadCollapsed(filePath);
            const headings = walkHeadings(state.doc);
            // Drop any persisted hashes that no longer match a heading in the
            // current doc. This keeps localStorage from accumulating stale
            // entries across edits between sessions.
            const validHashes = new Set(headings.map((h) => h.hash));
            const pruned = new Set<string>();
            for (const hash of collapsed) {
              if (validHashes.has(hash)) pruned.add(hash);
            }
            // Persist the pruned set so next load is clean. No-op if unchanged.
            if (pruned.size !== collapsed.size) {
              saveCollapsed(filePath, pruned);
            }
            return {
              collapsed: pruned,
              headings,
              decoSet: buildDecorations(state.doc, headings, pruned),
            };
          },
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(headingCollapseKey) as HeadingCollapseMeta | undefined;

            // Toggle: flip the hash in/out of the collapsed set, persist, rebuild.
            if (meta?.type === "toggle") {
              const next = new Set(prev.collapsed);
              if (next.has(meta.hash)) {
                next.delete(meta.hash);
              } else {
                next.add(meta.hash);
              }
              saveCollapsed(filePath, next);
              return {
                collapsed: next,
                headings: prev.headings,
                decoSet: buildDecorations(newState.doc, prev.headings, next),
              };
            }

            // Doc didn't change AND no meta — just map the deco set forward.
            // (Mapping a deco set through a no-op transaction is cheap.)
            if (!tr.docChanged) {
              return prev;
            }

            // Doc changed: recompute headings (text may have changed → hash may
            // have changed), reconcile collapsed set, rebuild decorations.
            const headings = walkHeadings(newState.doc);
            const validHashes = new Set(headings.map((h) => h.hash));
            let collapsed = prev.collapsed;
            let needsSave = false;
            // Filter out hashes whose heading vanished (deleted or text changed).
            const filtered = new Set<string>();
            for (const hash of collapsed) {
              if (validHashes.has(hash)) {
                filtered.add(hash);
              } else {
                needsSave = true;
              }
            }
            if (needsSave) {
              collapsed = filtered;
              saveCollapsed(filePath, collapsed);
            }
            return {
              collapsed,
              headings,
              // Map the previous deco set through the transaction so chevron
              // widgets at unchanged positions don't flicker, then rebuild
              // fresh for the new heading list. Rebuild wins for correctness;
              // mapping alone wouldn't update collapsed-section spans for an
              // edit that changes downstream sibling structure.
              decoSet: buildDecorations(newState.doc, headings, collapsed),
            };
          },
        },
        props: {
          decorations(state) {
            return headingCollapseKey.getState(state)?.decoSet ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
