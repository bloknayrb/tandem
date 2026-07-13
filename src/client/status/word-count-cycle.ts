import type { Editor as TiptapEditor } from "@tiptap/core";

export type WordCountMode =
  | "words"
  | "characters"
  | "sentences"
  | "paragraphs"
  | "pages"
  | "reading";

const STORAGE_KEY = "tandem-status-count-mode";

const CYCLE: readonly WordCountMode[] = [
  "words",
  "characters",
  "sentences",
  "paragraphs",
  "pages",
  "reading",
];

const MODE_LABEL: Record<WordCountMode, string> = {
  words: "words",
  characters: "chars",
  sentences: "sentences",
  paragraphs: "paragraphs",
  pages: "pages",
  reading: "min read",
};

// Publishing-standard manuscript page basis (double-spaced, 12pt).
const WORDS_PER_PAGE = 250;
// Standard silent-reading-speed basis for the reading-time estimate.
const WORDS_PER_MINUTE = 200;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function nextMode(current: WordCountMode): WordCountMode {
  const i = CYCLE.indexOf(current);
  return CYCLE[(i + 1) % CYCLE.length] ?? "words";
}

export function modeLabel(mode: WordCountMode): string {
  return MODE_LABEL[mode];
}

export function loadMode(): WordCountMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (CYCLE as readonly string[]).includes(raw)) return raw as WordCountMode;
  } catch {
    // storage disabled — fall through
  }
  return "words";
}

export function saveMode(mode: WordCountMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // storage disabled — silent
  }
}

/**
 * Derive a count from the editor's current doc state. Returns 0 when the
 * editor is absent so the status pill can render a placeholder without
 * crashing on the empty-doc / pre-mount cases.
 *
 * Sentences uses a forgiving boundary regex: `[.!?]+` followed by whitespace
 * or end-of-string. Paragraphs counts non-empty top-level paragraph children
 * only — headings and blockquote wrappers are excluded so the chip reflects
 * prose body, not document structure.
 */
export function getCount(editor: TiptapEditor | null, mode: WordCountMode): number {
  if (!editor || editor.isDestroyed) return 0;
  const text = editor.state.doc.textContent;
  switch (mode) {
    case "characters":
      return text.length;
    case "words":
      return countWords(text);
    case "sentences": {
      const matches = text.match(/[^.!?]+[.!?]+(?:\s|$)/g);
      return matches?.length ?? (text.trim() ? 1 : 0);
    }
    case "paragraphs": {
      let count = 0;
      editor.state.doc.forEach((node) => {
        if (node.type.name === "paragraph" && node.textContent.trim()) count++;
      });
      return count;
    }
    case "pages":
      return Math.ceil(countWords(text) / WORDS_PER_PAGE);
    case "reading": {
      const words = countWords(text);
      return words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    }
  }
}
