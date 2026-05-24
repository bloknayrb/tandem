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
 *   is anchored by `hash(level, normalizedText, ordinalIndex)`. Persistence is
 *   skipped for ephemeral `upload://` paths (scratchpads / uploaded files use a
 *   per-session UUID key that would otherwise leak into localStorage forever).
 * - **Collapse survives in-session text edits.** Editing a collapsed heading's
 *   text changes its hash. The on-edit reconciliation distinguishes a real
 *   deletion (heading *count* dropped → garbage-collect the vanished hash from
 *   localStorage) from a text edit (count unchanged → migrate the collapsed
 *   entry positionally to the heading's new hash so the section stays
 *   collapsed). A text edit must NEVER erase persisted collapse state.
 * - **Positions live in plugin state**, mapped through `tr.mapping.map()` on
 *   every transaction so collapse decorations stay aligned during edits.
 * - **No Svelte $state into .configure().** The `filePath` option is read once
 *   when the editor is constructed. Editor instances are keyed by tab id in
 *   App.svelte, so the file path is stable for the editor's lifetime; switching
 *   tabs rebuilds the editor (and re-hydrates from localStorage).
 *
 * # Known limitation: duplicate-heading positional ordinals
 * Headings with identical level + text are disambiguated by a positional
 * ordinal (0, 1, 2 … in document order). This is inherent to "basic scope" —
 * there's no stable per-heading identity. Reordering or deleting one of several
 * identical headings shifts the ordinals, so a collapse can re-target a
 * *different* duplicate after such an edit. Acceptable for the common case
 * (distinct heading text); a future scope could anchor to a CRDT-stable id.
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
  /**
   * `true` once we've seen a transaction where `walkHeadings(state.doc)` returned
   * a non-empty list — i.e. the YDoc has finished its initial Hocuspocus sync.
   *
   * Why this matters: the plugin's `init()` runs synchronously when the editor
   * is created, but at that moment the YDoc is freshly attached and its content
   * arrives asynchronously over the wire. If we prune the persisted collapsed
   * set against an empty doc, we'd wipe the user's saved state before it has a
   * chance to be restored. So:
   *
   * 1. `init()` loads localStorage into `collapsed` but does NOT persist or
   *    prune. `hasSeenContent` starts `false`.
   * 2. `view.props.update` watches for the first transaction where the doc
   *    actually has headings, then dispatches `{ type: "rehydrate" }`.
   * 3. The `rehydrate` apply() arm re-reads localStorage (in case the toggle
   *    path wrote a stale empty set during the gap), prunes against real
   *    headings, persists, and flips `hasSeenContent` true.
   * 4. The on-edit prune codepath only runs once `hasSeenContent` is true, so
   *    a transient empty-doc transaction during reload can't wipe state.
   */
  hasSeenContent: boolean;
}

type HeadingCollapseMeta = { type: "toggle"; hash: string } | { type: "rehydrate" };

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_KEY_PREFIX = "tandem:headingCollapse:";

function lsKey(filePath: string | null): string | null {
  if (!filePath) return null;
  // Skip ephemeral documents: scratchpads / uploaded files use a per-session
  // UUID path under the `upload://` scheme. Persisting their collapse state
  // would leak a localStorage key per session that never gets reclaimed.
  if (filePath.startsWith("upload://")) return null;
  return LS_KEY_PREFIX + filePath;
}

export function loadCollapsed(filePath: string | null): Set<string> {
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

export function saveCollapsed(filePath: string | null, collapsed: Set<string>): void {
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
export function normalizeHeadingText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Walk the doc collecting top-level headings.
 *
 * Hash recipe: `${level}::${normalizedText}::${ordinalIndexAmongIdenticalHeadings}`.
 * Duplicates (same level + text) are distinguished by an ordinal counter so
 * "## Notes" appearing three times still produces three distinct hashes.
 */
export function walkHeadings(doc: PmNode): HeadingEntry[] {
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

/**
 * Reconcile the collapsed-hash set against a doc edit.
 *
 * The HIGH bug (#815 review): a naive "drop any persisted hash not in the
 * current heading set" prune destroys collapse state the instant the user types
 * into a collapsed heading — the text edit re-hashes the heading, the old hash
 * looks "vanished", and we'd both re-expand the section AND erase localStorage.
 *
 * Fix: distinguish two cases by comparing heading *count* before/after:
 *
 *  - **Count decreased** → a heading was genuinely removed. Garbage-collect any
 *    collapsed hash that no longer resolves to a heading, and persist.
 *
 *  - **Count unchanged** → no deletion; any hash mismatch is a text edit in
 *    progress. We MUST NOT erase persistence. Better still, migrate the
 *    collapsed entry positionally to the heading's new hash so the section
 *    stays collapsed across the keystroke. Because the count is identical, the
 *    old and new heading arrays are index-aligned (document order), so an
 *    index-by-index hash diff tells us exactly which entry was retyped.
 *
 *  - **Count increased** → a heading was added; nothing to prune.
 *
 * Returns the (possibly new) collapsed set. Persists to localStorage only when
 * the set actually changed.
 */
export function reconcileOnEdit(
  prevHeadings: HeadingEntry[],
  nextHeadings: HeadingEntry[],
  collapsed: Set<string>,
  filePath: string | null,
): Set<string> {
  if (collapsed.size === 0) return collapsed;
  const validHashes = new Set(nextHeadings.map((h) => h.hash));

  // Same count → treat hash mismatches as in-progress text edits and migrate
  // the collapsed entry to the heading's new hash (index-aligned by position).
  if (prevHeadings.length === nextHeadings.length) {
    let changed = false;
    const migrated = new Set(collapsed);
    for (let i = 0; i < prevHeadings.length; i++) {
      const oldHash = prevHeadings[i].hash;
      const newHash = nextHeadings[i].hash;
      if (oldHash !== newHash && migrated.has(oldHash)) {
        migrated.delete(oldHash);
        migrated.add(newHash);
        changed = true;
      }
    }
    if (!changed) return collapsed;
    saveCollapsed(filePath, migrated);
    return migrated;
  }

  // Count increased → a heading was added; retain everything (a still-valid
  // collapsed hash stays, any transiently-mismatched one is left untouched and
  // will reconcile on a later settling edit). Never erase here.
  if (nextHeadings.length > prevHeadings.length) {
    return collapsed;
  }

  // Count decreased → a real deletion. Garbage-collect hashes that no longer
  // resolve to any heading.
  let needsSave = false;
  const filtered = new Set<string>();
  for (const hash of collapsed) {
    if (validHashes.has(hash)) {
      filtered.add(hash);
    } else {
      needsSave = true;
    }
  }
  if (!needsSave) return collapsed;
  saveCollapsed(filePath, filtered);
  return filtered;
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
  // a heading section is composed of in markdown documents. The offset-based
  // window (start.pos / endPos) is self-sufficient; no running cursor needed.
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
  });

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
            // Load persisted state but DO NOT prune or persist here. The doc is
            // typically empty at this moment (Hocuspocus sync hasn't completed),
            // so walking it would yield no headings and pruning would destroy
            // the user's saved set. The `rehydrate` meta path runs after the
            // first non-empty transaction (see view.update below) to do the
            // real reconciliation.
            const collapsed = loadCollapsed(filePath);
            const headings = walkHeadings(state.doc);
            return {
              collapsed,
              headings,
              decoSet: buildDecorations(state.doc, headings, collapsed),
              hasSeenContent: headings.length > 0,
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
                hasSeenContent: prev.hasSeenContent,
              };
            }

            // Rehydrate: re-read localStorage now that the doc has content,
            // validate persisted hashes against real headings, persist the
            // pruned set, and flip `hasSeenContent` true so the on-edit prune
            // path below becomes active.
            if (meta?.type === "rehydrate") {
              const headings = walkHeadings(newState.doc);
              const persisted = loadCollapsed(filePath);
              const validHashes = new Set(headings.map((h) => h.hash));
              const pruned = new Set<string>();
              for (const hash of persisted) {
                if (validHashes.has(hash)) pruned.add(hash);
              }
              if (pruned.size !== persisted.size) {
                saveCollapsed(filePath, pruned);
              }
              return {
                collapsed: pruned,
                headings,
                decoSet: buildDecorations(newState.doc, headings, pruned),
                hasSeenContent: true,
              };
            }

            // Doc didn't change AND no meta — return previous state unchanged.
            if (!tr.docChanged) {
              return prev;
            }

            // Doc changed: recompute headings, rebuild decorations, and
            // reconcile the collapsed set — but ONLY once we've seen real
            // content, otherwise a transient empty-doc transaction during
            // initial sync would wipe the persisted set before rehydrate fires.
            const headings = walkHeadings(newState.doc);
            const hasSeenContent = prev.hasSeenContent || headings.length > 0;

            let collapsed = prev.collapsed;
            if (prev.hasSeenContent) {
              collapsed = reconcileOnEdit(prev.headings, headings, prev.collapsed, filePath);
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
              hasSeenContent,
            };
          },
        },
        view(editorView) {
          // After the YDoc finishes its initial Hocuspocus sync, the doc gains
          // content via a transaction we don't initiate. Watch for the first
          // update where the doc has real headings and dispatch `rehydrate` so
          // the plugin reconciles its persisted set against the populated doc.
          //
          // This must run EXACTLY ONCE per editor lifetime — and crucially even
          // when the doc was ALREADY populated at plugin construction (the
          // common `{#key activeTab.id}` tab-switch remount / HMR / y-prosemirror
          // fast-populate path, where init() sets hasSeenContent=true). The
          // `rehydrated` closure flag — independent of plugin-state
          // `hasSeenContent` — guarantees the localStorage reconciliation is not
          // silently skipped on that path. See MEDIUM(b) in #815 review.
          //
          // The dispatch is deferred via requestAnimationFrame so we don't
          // re-enter ProseMirror's updateState() synchronously inside update()
          // (matches annotation.ts's rAF-deferred convention — MEDIUM(a)).
          let rehydrated = false;
          let rafId: number | null = null;

          function scheduleRehydrate() {
            if (rehydrated || rafId !== null) return;
            rafId = requestAnimationFrame(() => {
              rafId = null;
              if (rehydrated) return;
              const state = headingCollapseKey.getState(editorView.state);
              if (!state || state.headings.length === 0) return;
              rehydrated = true;
              const tr = editorView.state.tr
                .setMeta(headingCollapseKey, { type: "rehydrate" } satisfies HeadingCollapseMeta)
                .setMeta("addToHistory", false);
              editorView.dispatch(tr);
            });
          }

          // Cover the doc-already-populated-at-init case: update() may not fire
          // a second time if no further transactions arrive, so kick a check on
          // mount too. Both paths share the `rehydrated` one-shot guard.
          scheduleRehydrate();

          return {
            update(view) {
              if (rehydrated) return;
              const state = headingCollapseKey.getState(view.state);
              if (!state || state.headings.length === 0) return;
              scheduleRehydrate();
            },
            destroy() {
              if (rafId !== null) cancelAnimationFrame(rafId);
            },
          };
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
