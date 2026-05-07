import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tandemFindReplace: {
      find: (opts: FindReplaceOptions) => ReturnType;
      findNext: () => ReturnType;
      findPrev: () => ReturnType;
      findClose: () => ReturnType;
    };
  }
}

export const findReplaceKey = new PluginKey<FindReplaceState>("tandemFindReplace");

export interface FindReplaceOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexMode: boolean;
}

export interface MatchRange {
  from: number;
  to: number;
}

export interface FindReplaceState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexMode: boolean;
  matches: MatchRange[];
  activeIndex: number;
  decoSet: DecorationSet;
}

type FindReplaceMeta =
  | { type: "find"; opts: FindReplaceOptions }
  | { type: "close" }
  | { type: "next" }
  | { type: "prev" };

const EMPTY_STATE: FindReplaceState = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regexMode: false,
  matches: [],
  activeIndex: -1,
  decoSet: DecorationSet.empty,
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(
  opts: Pick<FindReplaceOptions, "query" | "caseSensitive" | "wholeWord" | "regexMode">,
): RegExp | null {
  if (!opts.query) return null;
  try {
    const pattern = opts.regexMode ? opts.query : escapeRegex(opts.query);
    const flags = opts.caseSensitive ? "g" : "gi";
    const wrapped = opts.wholeWord ? `\\b${pattern}\\b` : pattern;
    return new RegExp(wrapped, flags);
  } catch {
    return null;
  }
}

function walkMatches(doc: EditorState["doc"], opts: FindReplaceOptions): MatchRange[] {
  const re = buildRegex(opts);
  if (!re) return [];

  const result: MatchRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textContent;
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      result.push({ from: pos + 1 + idx, to: pos + 1 + idx + m[0].length });
    }
  });
  return result;
}

function buildDecoSet(
  doc: EditorState["doc"],
  matches: MatchRange[],
  activeIndex: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { from, to } = matches[i];
    try {
      decos.push(
        Decoration.inline(from, to, {
          class: i === activeIndex ? "tandem-find-active" : "tandem-find-match",
        }),
      );
    } catch {
      // Range invalidated by concurrent edit — skip
    }
  }
  return DecorationSet.create(doc, decos);
}

function findActiveIndex(matches: MatchRange[], cursor: number): number {
  if (matches.length === 0) return -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].from <= cursor && cursor <= matches[i].to) return i;
  }
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].from > cursor) return i;
  }
  return 0;
}

function applyFindMeta(
  meta: FindReplaceMeta,
  prev: FindReplaceState,
  newState: EditorState,
): FindReplaceState {
  if (meta.type === "close") {
    return EMPTY_STATE;
  }

  if (meta.type === "find") {
    const opts = meta.opts;
    const matches = walkMatches(newState.doc, opts);
    const cursor = newState.selection.from;
    const activeIndex = findActiveIndex(matches, cursor);
    return {
      ...opts,
      matches,
      activeIndex,
      decoSet: buildDecoSet(newState.doc, matches, activeIndex),
    };
  }

  if (meta.type === "next") {
    const next = prev.matches.length === 0 ? -1 : (prev.activeIndex + 1) % prev.matches.length;
    return { ...prev, activeIndex: next, decoSet: buildDecoSet(newState.doc, prev.matches, next) };
  }

  if (meta.type === "prev") {
    const p =
      prev.matches.length === 0
        ? -1
        : (prev.activeIndex - 1 + prev.matches.length) % prev.matches.length;
    return { ...prev, activeIndex: p, decoSet: buildDecoSet(newState.doc, prev.matches, p) };
  }

  const _exhaustive: never = meta;
  return _exhaustive;
}

export const FindReplaceExtension = Extension.create({
  name: "tandemFindReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<FindReplaceState>({
        key: findReplaceKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, prev, _old, newState) {
            const rawMeta = tr.getMeta(findReplaceKey) as FindReplaceMeta | undefined;
            if (rawMeta) return applyFindMeta(rawMeta, prev, newState);

            if (!prev.query) return prev;

            if (tr.docChanged) {
              const matches = walkMatches(newState.doc, prev);
              const cursor = newState.selection.from;
              const activeIndex = findActiveIndex(matches, cursor);
              return {
                ...prev,
                matches,
                activeIndex,
                decoSet: buildDecoSet(newState.doc, matches, activeIndex),
              };
            }

            // Selection-only change: update active index
            const cursor = newState.selection.from;
            const activeIndex = findActiveIndex(prev.matches, cursor);
            if (activeIndex === prev.activeIndex) return prev;
            return {
              ...prev,
              activeIndex,
              decoSet: buildDecoSet(newState.doc, prev.matches, activeIndex),
            };
          },
        },
        props: {
          decorations(state) {
            return findReplaceKey.getState(state)?.decoSet ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      find:
        (opts: FindReplaceOptions) =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findReplaceKey, { type: "find", opts }));
          return true;
        },
      findNext:
        () =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findReplaceKey, { type: "next" }));
          return true;
        },
      findPrev:
        () =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findReplaceKey, { type: "prev" }));
          return true;
        },
      findClose:
        () =>
        ({ dispatch, tr }) => {
          if (dispatch) dispatch(tr.setMeta(findReplaceKey, { type: "close" }));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Escape: ({ editor }) => {
        const state = findReplaceKey.getState(editor.state);
        if (!state?.query) return false;
        editor.commands.findClose();
        return true;
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Replace helpers — called from FindReplaceBar, not from the plugin
// ---------------------------------------------------------------------------

export function getFindState(editorState: EditorState): FindReplaceState | undefined {
  return findReplaceKey.getState(editorState);
}

export function replaceActive(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  replaceText: string,
): boolean {
  const state = getFindState(view.state);
  if (!state || state.activeIndex < 0 || state.matches.length === 0) return false;
  const { from, to } = state.matches[state.activeIndex];
  const tr = view.state.tr
    .insertText(replaceText, from, to)
    .setMeta(findReplaceKey, { type: "next" });
  view.dispatch(tr);
  return true;
}

export async function replaceAll(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  replaceText: string,
  onProgress?: (replaced: number, total: number) => void,
): Promise<{ replaced: number; partial: boolean }> {
  const CHUNK = 100;
  let replaced = 0;
  let partial = false;

  for (let pass = 0; pass < 50; pass++) {
    const state = getFindState(view.state);
    if (!state?.query || state.matches.length === 0) break;

    const chunk = state.matches.slice(0, CHUNK);

    try {
      // Replace in reverse order so earlier positions aren't shifted by later ones
      let tr = view.state.tr;
      for (let i = chunk.length - 1; i >= 0; i--) {
        const { from, to } = chunk[i];
        tr = tr.insertText(replaceText, from, to);
      }
      view.dispatch(tr);
      replaced += chunk.length;
      onProgress?.(replaced, replaced + (state.matches.length - chunk.length));
    } catch (err) {
      partial = true;
      console.warn("[find-replace] replaceAll chunk failed at pass", pass, err);
      break;
    }

    if (chunk.length < CHUNK) break;
    // Yield between chunks so the plugin can re-walk with fresh positions
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return { replaced, partial };
}
