import { untrack } from "svelte";
import type * as Y from "yjs";
import {
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_REPLY_SEEN,
  Y_MAP_REPLY_SEEN_WATERMARK,
} from "../../shared/constants";
import { withBrowser } from "../../shared/origins";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, AnnotationReply } from "../../shared/types";
import {
  createThreadAnswerDetector,
  isThreadAnswer,
  type ReplyBaseline,
  type ThreadAnswer,
  type ThreadAnswerParent,
} from "../notifications/thread-answer-detector";

/** Most seen entries kept on CTRL; older ones fold into the watermark. */
export const MAX_REPLY_SEEN_ENTRIES = 500;

interface ParentInfo extends ThreadAnswerParent {
  status: string;
}

interface DocData {
  documentId: string;
  replies: AnnotationReply[];
  parents: Map<string, ParentInfo>;
  /** The thread answers per annotation, oldest first — what cards look up. */
  answers: Map<string, AnnotationReply[]>;
}

export interface ThreadAnswerTab {
  id: string;
  ydoc: Y.Doc;
}

export interface ThreadAnswers {
  /** The document `ReplyThread` cards are showing (the active tab). */
  readonly activeDocumentId: string | null;
  /** Has any window shown this answer? Reads the shared map directly. */
  isSeen(replyId: string, timestamp: number): boolean;
  /**
   * The unseen Claude answers on a card, oldest first. Empty while the parent
   * is not pending (a resolved comment never holds a marker) and until CTRL
   * has synced. Reactive.
   */
  unseenAnswerIds(documentId: string, annotationId: string): string[];
  /**
   * Record that these replies were shown. Writes only while the window is
   * active — read reactively, so an effect calling this re-runs on focus —
   * and only ids that are thread answers in that document.
   */
  markSeen(documentId: string, replyIds: readonly string[]): void;
}

/**
 * Claude answers in the user's own comment threads (#2360), across EVERY open
 * document — a background tab's provider stays connected and synced, so an
 * answer there is announced like one in the active tab.
 *
 * Two jobs:
 * - feed `thread-answer-detector.ts` per document (baselines from `yjsSync`'s
 *   `replyBaselines`) and hand the live answers to `onAnswers`;
 * - own the cross-window seen state in CTRL's `Y_MAP_REPLY_SEEN`, which backs
 *   the card's "new" marker and the dispatcher's `isSeen`.
 *
 * **Seen map.** Keyed by reply id, valued with the reply's timestamp. A
 * watermark entry makes everything stamped before it read seen: it is set the
 * first time a window finds CTRL synced without one (so a lost CTRL session
 * does not turn every historical answer into a "new" one), and the cap raises
 * it to the newest entry it drops, so pruning never turns an answer back to
 * unseen. Never pruned by presence: a window cannot tell a closed document, or
 * its own stale copy, from a reply that is gone. Residuals, accepted: two
 * windows pruning at once is last-writer-wins on the watermark, which can move
 * it back and re-mark a few old answers new; CTRL is persisted at clean
 * shutdown, so seen marks written since are lost in a crash. Both cost only a
 * card marker — the detector's synced baseline stops any re-announcement.
 */
export function createThreadAnswers(options: {
  getTabs: () => readonly ThreadAnswerTab[];
  getReplyBaselines: () => ReadonlyMap<Y.Doc, ReplyBaseline>;
  getCtrlYdoc: () => Y.Doc | null;
  getCtrlSynced: () => boolean;
  getActiveDocumentId: () => string | null;
  isWindowActive: () => boolean;
  onAnswers?: (answers: ThreadAnswer[]) => void;
}): ThreadAnswers {
  let docData = $state.raw<ReadonlyMap<Y.Doc, DocData>>(new Map());
  let seen = $state.raw<ReadonlyMap<string, number>>(new Map());
  let watermark = $state.raw<number | null>(null);

  // ---- Per-document observation, attached once per Y.Doc identity. ----
  const attached = new Map<Y.Doc, () => void>();

  function attach(tab: ThreadAnswerTab): () => void {
    const { ydoc, id } = tab;
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const read = () => {
      const replies: AnnotationReply[] = [];
      repliesMap.forEach((value) => {
        const reply = value as AnnotationReply | null;
        if (reply && typeof reply === "object" && typeof reply.id === "string") {
          replies.push(reply);
        }
      });
      replies.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      const parents = new Map<string, ParentInfo>();
      annotationsMap.forEach((value) => {
        if (!value || typeof value !== "object") return;
        // Silent: `yjsSync` already logs lossy records for the active tab,
        // and this runs for every tab on every change.
        const ann = sanitizeAnnotation(value as Annotation, () => {});
        parents.set(ann.id, {
          author: ann.author,
          type: ann.type,
          audience: ann.audience,
          status: ann.status,
        });
      });
      const answers = new Map<string, AnnotationReply[]>();
      for (const reply of replies) {
        if (!isThreadAnswer(reply, parents.get(reply.annotationId))) continue;
        const list = answers.get(reply.annotationId);
        if (list) list.push(reply);
        else answers.set(reply.annotationId, [reply]);
      }
      docData = new Map(docData).set(ydoc, { documentId: id, replies, parents, answers });
    };
    repliesMap.observe(read);
    annotationsMap.observe(read);
    read();
    return () => {
      repliesMap.unobserve(read);
      annotationsMap.unobserve(read);
      if (docData.has(ydoc)) {
        const next = new Map(docData);
        next.delete(ydoc);
        docData = next;
      }
    };
  }

  $effect(() => {
    const tabs = options.getTabs();
    untrack(() => {
      const live = new Set(tabs.map((tab) => tab.ydoc));
      for (const [ydoc, detach] of attached) {
        if (live.has(ydoc)) continue;
        detach();
        attached.delete(ydoc);
      }
      for (const tab of tabs) {
        if (!attached.has(tab.ydoc)) attached.set(tab.ydoc, attach(tab));
      }
    });
  });
  $effect(() => () => {
    for (const detach of attached.values()) detach();
    attached.clear();
  });

  // ---- Detection. ----
  const detector = createThreadAnswerDetector();
  $effect(() => {
    const data = docData;
    const baselines = options.getReplyBaselines();
    const onAnswers = options.onAnswers;
    if (!onAnswers) return;
    const fresh: ThreadAnswer[] = [];
    for (const [ydoc, doc] of data) {
      fresh.push(
        ...detector.observe({
          doc: ydoc,
          documentId: doc.documentId,
          baseline: baselines.get(ydoc) ?? null,
          replies: doc.replies,
          parents: doc.parents,
        }),
      );
    }
    if (fresh.length > 0) untrack(() => onAnswers(fresh));
  });

  // ---- Seen map on CTRL. ----
  $effect(() => {
    const ctrl = options.getCtrlYdoc();
    if (!ctrl) {
      seen = new Map();
      watermark = null;
      return;
    }
    const map = ctrl.getMap(Y_MAP_REPLY_SEEN);
    const read = () => {
      const next = new Map<string, number>();
      let mark: number | null = null;
      map.forEach((value, key) => {
        if (typeof value !== "number") return;
        if (key === Y_MAP_REPLY_SEEN_WATERMARK) mark = value;
        else next.set(key, value);
      });
      seen = next;
      watermark = mark;
    };
    map.observe(read);
    read();
    return () => map.unobserve(read);
  });

  // Seed the watermark the first time CTRL is synced without one.
  $effect(() => {
    const ctrl = options.getCtrlYdoc();
    if (!ctrl || !options.getCtrlSynced()) return;
    const map = ctrl.getMap(Y_MAP_REPLY_SEEN);
    if (typeof map.get(Y_MAP_REPLY_SEEN_WATERMARK) === "number") return;
    withBrowser(ctrl, () => map.set(Y_MAP_REPLY_SEEN_WATERMARK, Date.now()));
  });

  function readsSeen(
    entries: ReadonlyMap<string, number> | Y.Map<unknown>,
    mark: number | null,
    replyId: string,
    timestamp: number,
  ): boolean {
    return typeof entries.get(replyId) === "number" || (mark !== null && timestamp < mark);
  }

  function findDoc(documentId: string): DocData | undefined {
    for (const doc of docData.values()) if (doc.documentId === documentId) return doc;
    return undefined;
  }

  function prune(map: Y.Map<unknown>): void {
    const entries: [string, number][] = [];
    map.forEach((value, key) => {
      if (key !== Y_MAP_REPLY_SEEN_WATERMARK && typeof value === "number") {
        entries.push([key, value]);
      }
    });
    if (entries.length <= MAX_REPLY_SEEN_ENTRIES) return;
    entries.sort((a, b) => a[1] - b[1]);
    const dropped = entries.slice(0, entries.length - MAX_REPLY_SEEN_ENTRIES);
    // Strictly after the newest dropped answer, so it still reads seen.
    const raised = dropped[dropped.length - 1][1] + 1;
    const current = map.get(Y_MAP_REPLY_SEEN_WATERMARK);
    if (typeof current !== "number" || current < raised) {
      map.set(Y_MAP_REPLY_SEEN_WATERMARK, raised);
    }
    for (const [key] of dropped) map.delete(key);
  }

  return {
    get activeDocumentId() {
      return options.getActiveDocumentId();
    },
    isSeen(replyId, timestamp) {
      const ctrl = options.getCtrlYdoc();
      if (!ctrl) return false;
      const map = ctrl.getMap(Y_MAP_REPLY_SEEN);
      const mark = map.get(Y_MAP_REPLY_SEEN_WATERMARK);
      return readsSeen(map, typeof mark === "number" ? mark : null, replyId, timestamp);
    },
    unseenAnswerIds(documentId, annotationId) {
      if (!options.getCtrlSynced()) return [];
      const doc = findDoc(documentId);
      if (!doc || doc.parents.get(annotationId)?.status !== "pending") return [];
      const entries = seen;
      const mark = watermark;
      return (doc.answers.get(annotationId) ?? [])
        .filter((reply) => !readsSeen(entries, mark, reply.id, reply.timestamp))
        .map((reply) => reply.id);
    },
    markSeen(documentId, replyIds) {
      if (!options.isWindowActive()) return;
      const ctrl = options.getCtrlYdoc();
      if (!ctrl || !options.getCtrlSynced() || replyIds.length === 0) return;
      const doc = findDoc(documentId);
      if (!doc) return;
      // Re-validated here rather than trusted from the caller: a card left
      // over from the previous tab during a switch passes ids that are not
      // answers in `documentId`, and those must not be written.
      const wanted = new Set(replyIds);
      const toWrite = Array.from(doc.answers.values())
        .flat()
        .filter(
          (reply) => wanted.has(reply.id) && !readsSeen(seen, watermark, reply.id, reply.timestamp),
        );
      if (toWrite.length === 0) return;
      untrack(() => {
        const map = ctrl.getMap(Y_MAP_REPLY_SEEN);
        withBrowser(ctrl, () => {
          for (const reply of toWrite) map.set(reply.id, reply.timestamp);
          prune(map);
        });
      });
    },
  };
}
