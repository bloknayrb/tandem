// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORSHIP_ORIGIN_META } from "../../src/client/editor/extensions/authorship.js";
import { TUTORIAL_ANNOTATION_PREFIX, TUTORIAL_COMPLETED_KEY } from "../../src/shared/constants.js";
import type { Annotation, ChatMessage } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

// createTutorial spins up a createCoworkStatus poller that registers onDestroy —
// illegal under $effect.root (no component instance). Stub it inert; the Cowork
// row is covered by use-tutorial-cowork-dark.svelte.test.ts.
vi.mock(import("../../src/client/hooks/useCoworkStatus.svelte.js"), () => ({
  createCoworkStatus: () => ({
    get status() {
      return null;
    },
    get error() {
      return null;
    },
    loading: false,
    refetch: vi.fn(async () => true),
  }),
}));

import { createTutorial, type TutorialState } from "../../src/client/hooks/useTutorial.svelte.js";

/**
 * #1711 — the getting-started checklist. Three independent items, each ticked
 * only by the real action, in any order. The cases below are the ways an item
 * could tick WITHOUT the user doing it (the adversarial review's blocking set):
 * a Claude edit or an accepted suggestion ticking "Make an edit", a replay's
 * leftover resolves ticking "Accept or dismiss", and durable chat history
 * ticking "Ask Claude something" (#1965).
 */

/** Minimal Tiptap stand-in: `on`/`off` for `update`, plus `isFocused`. */
function fakeEditor() {
  const handlers = new Set<(p: { transaction: unknown }) => void>();
  const editor = {
    isFocused: true,
    on: (event: string, h: (p: { transaction: unknown }) => void) => {
      if (event === "update") handlers.add(h);
    },
    off: (event: string, h: (p: { transaction: unknown }) => void) => {
      if (event === "update") handlers.delete(h);
    },
  };
  const emit = (meta: Map<unknown, unknown> = new Map(), docChanged = true) => {
    const transaction = { docChanged, getMeta: (k: unknown) => meta.get(k) };
    for (const h of handlers) h({ transaction });
  };
  return { editor, emit, handlerCount: () => handlers.size };
}

function message(author: "user" | "claude", timestamp: number): ChatMessage {
  return { id: `msg-${author}-${timestamp}`, author, text: "hello", timestamp, read: true };
}

interface Ctx {
  tut: TutorialState;
  ed: ReturnType<typeof fakeEditor>;
  setAnnotations: (a: Annotation[]) => void;
  setMessages: (m: ChatMessage[]) => void;
  setResolved: (ids: string[]) => void;
}

/**
 * Build the hook over `$state` cells and hand them to `run`, then dispose.
 * `$state`, not plain `let`: the getters are read inside the hook's
 * `$effect`s, so a plain reassignment would never re-run them and every
 * "does not tick" case would pass vacuously.
 */
async function withTutorial(
  run: (ctx: Ctx) => void | Promise<void>,
  fileName = "welcome.md",
): Promise<void> {
  let annotations = $state<Annotation[]>([]);
  let messages = $state<ChatMessage[]>([]);
  let resolved = $state<ReadonlySet<string>>(new Set());
  const ed = fakeEditor();
  let tut: TutorialState | undefined;
  const dispose = $effect.root(() => {
    tut = createTutorial(
      () => annotations,
      () => ed.editor as unknown as Editor,
      () => fileName,
      () => messages,
      () => resolved,
    );
  });
  flushSync();
  try {
    await run({
      tut: tut as TutorialState,
      ed,
      setAnnotations: (a) => {
        annotations = a;
        flushSync();
      },
      setMessages: (m) => {
        messages = m;
        flushSync();
      },
      setResolved: (ids) => {
        resolved = new Set(ids);
        flushSync();
      },
    });
  } finally {
    dispose();
  }
}

/** Let the coalescing tick's microtask run, then flush effects. */
async function settle(): Promise<void> {
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("Accept or dismiss a comment from Claude", () => {
  it("ticks when the user resolves an annotation", () =>
    withTutorial(({ tut, setResolved }) => {
      expect(tut.reviewed).toBe(false);
      setResolved(["tutorial-suggest-1"]);
      expect(tut.reviewed).toBe(true);
    }));

  it("does not tick on a resolve still in its undo window when a replay re-arms", () =>
    withTutorial(({ tut, setResolved }) => {
      setResolved(["tutorial-suggest-1"]);
      tut.dismissTutorial();
      flushSync();
      tut.restartTutorial();
      flushSync();
      expect(tut.reviewed).toBe(false);
      setResolved(["tutorial-suggest-1", "tutorial-comment-1"]);
      expect(tut.reviewed).toBe(true);
    }));

  it("does not tick on annotations that are merely resolved on the record", () =>
    // Claude's tandem_resolveAnnotation, or a replay's leftover seeds: resolved
    // records the user did not resolve now. Only the review hook's signal counts.
    withTutorial(({ tut, setAnnotations }) => {
      setAnnotations([
        makeAnnotation({ id: `${TUTORIAL_ANNOTATION_PREFIX}suggest-1`, status: "accepted" }),
      ]);
      expect(tut.reviewed).toBe(false);
    }));
});

describe("Ask Claude something (#1965 baseline)", () => {
  it("ticks on a user chat message sent after arming", () =>
    withTutorial(({ tut, setMessages }) => {
      setMessages([message("user", Date.now() + 1000)]);
      expect(tut.asked).toBe(true);
    }));

  it("does not tick on a Claude-authored message", () =>
    withTutorial(({ tut, setMessages }) => {
      setMessages([message("claude", Date.now() + 1000)]);
      expect(tut.asked).toBe(false);
    }));

  it("does not tick on chat history that predates arming", () =>
    // Chat is durable and `restartTutorial` cannot clear it: without the
    // baseline this ticks for every user with any chat history.
    withTutorial(({ tut, setMessages }) => {
      setMessages([message("user", Date.now() - 60_000)]);
      expect(tut.asked).toBe(false);
    }));

  it("ticks on a new outbound user comment", () =>
    withTutorial(({ tut, setAnnotations }) => {
      setAnnotations([
        makeAnnotation({
          id: "q",
          author: "user",
          type: "comment",
          audience: "outbound",
          timestamp: Date.now() + 1000,
        }),
      ]);
      expect(tut.asked).toBe(true);
    }));

  it.each([
    ["a private note — Claude never sees one (ADR-027)", { type: "note", audience: "private" }],
    ["a comment with no audience — absent is not outbound", { type: "comment" }],
  ] as const)("does not tick on %s", (_label, over) =>
    withTutorial(({ tut, setAnnotations }) => {
      setAnnotations([
        makeAnnotation({ id: "n", author: "user", timestamp: Date.now() + 1000, ...over }),
      ]);
      expect(tut.asked).toBe(false);
    }),
  );

  it("does not tick on a user comment that predates arming (replay keeps it)", () =>
    withTutorial(({ tut, setAnnotations }) => {
      setAnnotations([
        makeAnnotation({
          id: "old",
          author: "user",
          type: "comment",
          audience: "outbound",
          timestamp: Date.now() - 60_000,
        }),
      ]);
      expect(tut.asked).toBe(false);
    }));

  it("does not tick on a tutorial seed", () =>
    withTutorial(({ tut, setAnnotations }) => {
      setAnnotations([
        makeAnnotation({
          id: `${TUTORIAL_ANNOTATION_PREFIX}comment-9`,
          author: "user",
          type: "comment",
          audience: "outbound",
          timestamp: Date.now() + 1000,
        }),
      ]);
      expect(tut.asked).toBe(false);
    }));
});

describe("Make an edit", () => {
  it("ticks on a focused local edit, deferred out of the Tiptap handler", () =>
    withTutorial(async ({ tut, ed }) => {
      ed.emit();
      // Never written synchronously from the handler (CLAUDE.md, Client/UI).
      expect(tut.edited).toBe(false);
      await settle();
      expect(tut.edited).toBe(true);
      // Ticked: the listener is removed.
      expect(ed.handlerCount()).toBe(0);
    }));

  it.each([
    [
      "a remote (ySync) change, e.g. Claude's tandem_edit",
      new Map<unknown, unknown>([[ySyncPluginKey, {}]]),
    ],
    [
      "a Claude-authored local write, e.g. accepting a suggestion",
      new Map<unknown, unknown>([[AUTHORSHIP_ORIGIN_META, "claude"]]),
    ],
  ])("does not tick on %s", (_label, meta) =>
    withTutorial(async ({ tut, ed }) => {
      ed.emit(meta);
      await settle();
      expect(tut.edited).toBe(false);
    }),
  );

  it("does not tick while the editor is unfocused, or on a selection-only transaction", () =>
    withTutorial(async ({ tut, ed }) => {
      ed.emit(new Map(), false);
      ed.editor.isFocused = false;
      ed.emit();
      await settle();
      expect(tut.edited).toBe(false);
    }));
});

describe("completion", () => {
  it("items tick in any order; all three → allDone → completes after 3 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await withTutorial(async ({ tut, ed, setMessages, setResolved }) => {
      // Edit first, then ask, then review — the old card's reverse order.
      ed.emit();
      await settle();
      setMessages([message("user", Date.now() + 1000)]);
      expect(tut.allDone).toBe(false);
      setResolved(["tutorial-comment-1"]);
      expect(tut.allDone).toBe(true);
      expect(tut.tutorialActive).toBe(true);
      vi.advanceTimersByTime(3000);
      flushSync();
      expect(tut.tutorialActive).toBe(false);
      expect(localStorage.getItem(TUTORIAL_COMPLETED_KEY)).toBe("true");
    });
  });

  it("dismiss completes without any item ticked", () =>
    withTutorial(({ tut }) => {
      tut.dismissTutorial();
      flushSync();
      expect(tut.tutorialActive).toBe(false);
      expect(localStorage.getItem(TUTORIAL_COMPLETED_KEY)).toBe("true");
    }));

  it("a user who finished the old card (legacy 'true') never sees the checklist", () => {
    localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");
    return withTutorial(({ tut }) => {
      expect(tut.tutorialActive).toBe(false);
    });
  });

  it("is inactive off welcome.md", () =>
    withTutorial(({ tut }) => {
      expect(tut.tutorialActive).toBe(false);
    }, "notes.md"));
});
