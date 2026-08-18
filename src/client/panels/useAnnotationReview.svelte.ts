import type { JSONContent, Editor as TiptapEditor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { onDestroy } from "svelte";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { isPlaintextFormat } from "../../shared/plaintext-format";
import type { SanitizationEvent } from "../../shared/sanitize";
import { sanitizeAnnotation } from "../../shared/sanitize";
import { isSnapshotTruncated } from "../../shared/snapshot";
import type { Annotation } from "../../shared/types";
import { isPendingReviewTarget } from "../../shared/types";
import { AUTHORSHIP_ORIGIN_META } from "../editor/extensions/authorship";
import type { RestoreBreak } from "../editor/utils/literal-content";
import { literalInlineContent, literalRestoreContent } from "../editor/utils/literal-content";
import { annotationToPmRange } from "../positions";

/** Why undo refused, permanently. See `onUndoFailed`. */
export type UndoDeclineReason = "truncated-snapshot" | "block-structure";

/**
 * Is this position inside a node that stores newlines literally?
 *
 * `codeBlock` declares `code: true` and does not admit `hardBreak` in its
 * content expression, so the two contexts need different representations of the
 * same newline. See `literalInlineContent`.
 */
function isCodeContext(editor: TiptapEditor, pos: number): boolean {
  try {
    // Not named `$pos` despite the ProseMirror convention: this is a
    // `.svelte.ts` module and the Svelte compiler reserves the `$` prefix.
    const resolvedPos = editor.state.doc.resolve(pos);
    // Depth 0 — parent is the DOC rather than a textblock — is reachable: it is
    // where `flatOffsetToPmPos` clamps an over-long flat offset, at
    // `doc.content.size`. `doc.spec.code` is undefined there so this answers
    // "prose", and that is CORRECT rather than a gap: `insertContentAt` at the
    // document end appends a NEW PARAGRAPH, so the receiving node is a paragraph
    // even when the last block is a code block. Reading the preceding node
    // instead looks more careful and is wrong — it puts a literal newline, i.e.
    // a soft wrap, into that paragraph. Measured, not reasoned.
    return resolvedPos.parent.type.spec.code === true;
  } catch {
    // A position that will not resolve is about to fail the surrounding
    // transaction anyway; prose is the safe assumption.
    return false;
  }
}

/**
 * The flat text a PM range covers, in the SERVER's flat-text projection.
 *
 * Both separators are load-bearing, and they are the same argument made twice.
 * `suggestedText` and `textSnapshot` come from `extractText()`, which spells a
 * hard break "\n" (`leafText`) AND joins blocks with "\n" (`blockSeparator`).
 * Drop the first and every multi-line suggestion looks edited-since-accept;
 * drop the second and a range that has DRIFTED across a block boundary can
 * concatenate to exactly the snapshot, passing a guard that exists to stop
 * precisely that — after which undo deletes across the boundary and merges two
 * blocks.
 */
export function rangeText(editor: TiptapEditor, from: number, to: number): string {
  return editor.state.doc.textBetween(from, to, "\n", "\n");
}

/**
 * Can a recorded block boundary be restored HERE without inventing structure?
 *
 * Only when the receiving textblock is a direct child of the doc (#1486). The
 * restore works by splitting that textblock, which produces siblings of its own
 * type — right at the top level, wrong anywhere else, and measurably so:
 *
 *   inside a list item, splitting yields ONE item holding two paragraphs
 *   where two list items were; inside a table cell it is worse still.
 *
 * The recorded `"block"` kind means "a gap between container children" and does
 * not say which container, so nothing in the record can distinguish those cases
 * — which is exactly why this asks the DOCUMENT instead of the record. Where
 * the answer is no, undo declines. Refusing is recoverable; silently rewriting
 * a list into a loose paragraph pair is not.
 *
 * Deliberately conservative, and a blockquote is the known cost: splitting a
 * paragraph inside one yields two paragraphs inside the same blockquote, which
 * IS the right answer, and this still declines. Widening the predicate needs a
 * per-container argument about what the recorded break could have meant, and a
 * false decline loses an undo while a false accept rewrites the document.
 */
function canRestoreBlockBoundary(editor: TiptapEditor, pos: number): boolean {
  try {
    const resolvedPos = editor.state.doc.resolve(pos);
    // depth 1 ⇒ parent is a textblock whose own parent is the doc. depth 0 is
    // the document end, where `insertContentAt` appends a fresh top-level
    // paragraph — also fine, and reached by the same reasoning as `isCodeContext`.
    return resolvedPos.depth <= 1;
  } catch {
    return false;
  }
}

/**
 * The marks spanning a range, as JSON, for `literalInlineContent` to stamp.
 *
 * `marksAcross` returns null when the endpoints disagree, which is the right
 * answer: a replacement straddling a bold boundary should not pick a side.
 */
function marksAcrossRange(
  editor: TiptapEditor,
  from: number,
  to: number,
): JSONContent["marks"] | undefined {
  try {
    const { doc } = editor.state;
    return doc
      .resolve(from)
      .marksAcross(doc.resolve(to))
      ?.map((m) => m.toJSON());
  } catch {
    return undefined;
  }
}

/** Browser DevTools breadcrumb — only forensic trail client-side when sanitize coerces. */
const devSanitizeWarn = (event: SanitizationEvent): void => {
  console.warn("[sanitize]", event);
};

/** Matches a line ending in any of the three conventions. Mirrors `literal-content.ts`. */
const LINE_ENDING_TEST = /\r\n|[\r\n]/;

/**
 * How a multi-line suggestion lands in a plaintext document at `pos`: one entry
 * per block, and whether those entries collapse into a single block.
 *
 * Shared by accept and by undo's did-the-text-change guard, and it has to be, for
 * a reason that cost a real regression. That guard compares the range's current
 * flat text against `suggestedText` and declines permanently when they differ. The
 * heading branch means accept no longer writes `suggestedText` verbatim — it
 * writes the lines joined with spaces — so a heading accept became un-undoable:
 * the `"\n"` the guard looks for is gone from the document forever, the decline
 * takes the *transient* path, and the user gets a live-looking Undo button that
 * silently does nothing. Found in review.
 *
 * The same reasoning covers a CRLF suggestion, which was wrong before the heading
 * branch existed: the flat projection spells every line ending `"\n"`, so a
 * suggestion carrying `"\r\n"` never matched its own accepted text either.
 */
function plaintextBlockPlan(
  editor: TiptapEditor,
  pos: number,
  newText: string,
): { lines: string[]; collapse: boolean } {
  const lines = newText.split(LINE_ENDING_TEST);
  let host: { isTextblock: boolean; type: { name: string } } | null = null;
  try {
    host = editor.state.doc.resolve(pos).parent;
  } catch {
    host = null;
  }
  // A heading COLLAPSES to one block, joined with spaces, exactly as the server's
  // Save-As flatten does — and for the same measured reason: `extractText` runs
  // heading text through `flattenHeadingText`, which maps every newline to a
  // space, so a two-line heading serializes as `# one two`. Splitting would invent
  // a second heading and a second line that the file will not contain.
  return { lines, collapse: host?.isTextblock === true && host.type.name === "heading" };
}

/**
 * In a plaintext document, every newline in a snapshot is a BLOCK boundary —
 * `null` when that does not apply.
 *
 * Undo's other half of #1460, and the mirror of the accept path. Without this, a
 * snapshot whose recorded structure is absent (a record written before #1486, or
 * one whose range was relocated so the offsets no longer land on newlines) falls
 * to `literalRestoreContent`'s inline branch, which puts the raw `"\n"` back as a
 * LITERAL newline inside one textblock — the forbidden shape, restored by the
 * feature meant to put the document back. Found in review.
 *
 * Overriding a recorded `"hard"` here is deliberate, not a loss: a hard break is
 * unrepresentable in this file, so whatever the record says, the bytes said
 * boundary and the next open will too.
 */
function plaintextRestoreBreaks(
  oldText: string,
  format: string | undefined,
): RestoreBreak[] | null {
  if (!isPlaintextFormat(format) || !oldText.includes("\n")) return null;
  const breaks: RestoreBreak[] = [];
  for (let i = oldText.indexOf("\n"); i !== -1; i = oldText.indexOf("\n", i + 1)) {
    breaks.push({ at: i, kind: "block" });
  }
  return breaks;
}

/** The flat text that accepting `newText` at `pos` actually writes. */
function appliedProjection(
  editor: TiptapEditor,
  pos: number,
  newText: string,
  format: string | undefined,
): string {
  if (!isPlaintextFormat(format) || !LINE_ENDING_TEST.test(newText)) return newText;
  if (isCodeContext(editor, pos)) return newText;
  const { lines, collapse } = plaintextBlockPlan(editor, pos, newText);
  return lines.join(collapse ? " " : "\n");
}

/**
 * Accept a multi-line suggestion into a plaintext document as separate blocks.
 *
 * Uses an OPEN slice for the same reason the undo path does: `insertContentAt`
 * given closed block nodes at an inline position routes to `tr.replaceWith` →
 * `new Slice(frag, 0, 0)`, which splits the host block *around* the insertion
 * instead of merging into it — so replacing the middle of `pre|X|post` yields
 * four paragraphs where two belong. `openStart`/`openEnd` of 1 says "these ends
 * are cut, join them to whatever they land beside".
 *
 * Marks are stamped explicitly, matching `literalInlineContent`: `tr.replace`
 * does not inherit `marksAcross` the way `tr.insertText` does, so leaving them
 * off would make the same suggestion keep its bold on one line and lose it on
 * two.
 */
function applyAsBlocks(
  editor: TiptapEditor,
  from: number,
  to: number,
  newText: string,
  marks: JSONContent["marks"],
): boolean | null {
  const { schema } = editor.state;
  // The HOST block's type and attributes, not a hardcoded paragraph. Producing
  // paragraphs inside a heading would drop the `#` run from the file — the same
  // defect `flattenPlaintextBreaks` had when it built bare elements, and the same
  // class as the table-alignment loss in #1448: a block rebuilt without its
  // attributes serializes as a different block.
  const host = editor.state.doc.resolve(from).parent;
  const type = host.isTextblock ? host.type.name : "paragraph";
  const attrs = host.isTextblock ? host.attrs : undefined;

  const { lines, collapse } = plaintextBlockPlan(editor, from, newText);
  const asBlocks = collapse ? [lines.join(" ")] : lines;

  // Splitting is only correct where the receiving textblock is a direct child of
  // the doc — the same predicate, and the same measured reason, as the undo path's
  // `canRestoreBlockBoundary`: inside a list item a split yields ONE item holding
  // two paragraphs where two items belong, and inside a table cell it is worse.
  // The undo path has refused this since #1486; accept did not, which made two
  // halves of one feature disagree about the same document shape. Declining lets
  // the caller fall back to the hard-break path.
  //
  // A heading needs no check: it collapses to a single block, so there is no
  // boundary to invent.
  if (asBlocks.length > 1 && !canRestoreBlockBoundary(editor, from)) return null;

  const nodes = asBlocks.map((line) =>
    schema.nodeFromJSON({
      type,
      ...(attrs ? { attrs } : {}),
      // A zero-length text node is invalid in ProseMirror, so an empty line is
      // an empty paragraph — which is what an empty line in the file is.
      content: line.length > 0 ? [{ type: "text", text: line, ...(marks ? { marks } : {}) }] : [],
    }),
  );
  return (
    editor
      .chain()
      .focus()
      // Claude wrote this text; without the tag `Authorship.onTransaction` stamps
      // it as the user's (#1388). Inside the chain so it tags the same transaction.
      .setMeta(AUTHORSHIP_ORIGIN_META, "claude")
      .command(({ tr }) => {
        tr.replace(from, to, new Slice(Fragment.from(nodes), 1, 1));
        return true;
      })
      .run()
  );
}

/**
 * Apply an annotation's replacement text in the editor.
 *
 * Exported for tests only. The hook's own suite drives it through a fully
 * mocked editor, which cannot observe the transaction — and a mutation that
 * deletes the authorship tag below passes every assertion there. The real
 * behaviour is pinned in `tests/client/authorship-stamp.test.ts` against a
 * live Tiptap editor.
 */
export function applySuggestion(
  ann: Annotation,
  editor: TiptapEditor,
  ydoc: Y.Doc | null,
  format?: string,
): boolean {
  if (ann.suggestedText === undefined) return false;

  const newText = ann.suggestedText;
  const resolved = annotationToPmRange(ann, editor.state.doc, ydoc);
  if (!resolved) {
    console.warn("[SidePanel] Could not resolve range for suggestion", ann.id);
    return false;
  }

  try {
    const inCode = isCodeContext(editor, resolved.from);
    const marks = marksAcrossRange(editor, resolved.from, resolved.to);

    // #1460: in a plaintext document a multi-line suggestion has to become
    // BLOCKS, not hard breaks.
    //
    // `literalInlineContent` renders every newline as a `hardBreak`, which is
    // right for markdown — that is what a suggestion string means, and the
    // serializer writes it as a trailing `\`. A plaintext file has no way to
    // spell it: save joins blocks with `\n`, so a hardBreak and a block boundary
    // produce identical bytes, and the next open reads the bytes. Accepting a
    // two-line suggestion would leave a document whose model disagrees with its
    // own file.
    //
    // A code block is exempt on both counts — it stores newlines literally and
    // its content expression admits no hardBreak, so there is nothing to convert.
    if (isPlaintextFormat(format) && !inCode && LINE_ENDING_TEST.test(newText)) {
      const asBlocks = applyAsBlocks(editor, resolved.from, resolved.to, newText, marks);
      // `null` = declined because splitting there would invent structure. Fall
      // through to the hard-break path rather than refusing the accept: inside a
      // list or a table the plaintext file has already lost that structure on the
      // next reload, so a hardBreak there is no new loss, while a split would
      // rewrite the container in a way the user did not ask for.
      if (asBlocks !== null) return asBlocks;
    }

    // Inline JSON, never the raw string: `insertContentAt` HTML-parses a string
    // argument, which downgraded every hard break to a soft wrap and let markup
    // in a suggestion restructure the document (#1477).
    const content = literalInlineContent(newText, inCode, marks);
    let chain = editor
      .chain()
      .focus()
      // Claude wrote this text; without the tag `Authorship.onTransaction`
      // stamps it as the user's, which is #1388. The tag must live INSIDE the
      // chain — a chain batches every step into one transaction, and a
      // separate dispatch would tag a different one.
      .setMeta(AUTHORSHIP_ORIGIN_META, "claude")
      .deleteRange({ from: resolved.from, to: resolved.to });
    // An empty suggestion is a deletion. Inserting `[]` would not be a clean
    // no-op — `createNodeFromContent` gates its array branch on a non-empty
    // length, so `[]` falls through to `schema.nodeFromJSON([])`, throws, and is
    // caught into an empty fragment plus a `[tiptap warn]: Invalid content.`
    if (content.length > 0) chain = chain.insertContentAt(resolved.from, content);
    return chain.run();
  } catch (err) {
    console.error("[SidePanel] Editor mutation failed for suggestion", ann.id, err);
    return false;
  }
}

export interface UseAnnotationReviewParams {
  /** Getter for current Y.Doc — avoids React-style ref ceremony. */
  getYdoc: () => Y.Doc | null;
  /** Getter for current editor instance. */
  getEditor: () => TiptapEditor | null;
  /** Reactive annotations array. */
  getAnnotations: () => Annotation[];
  onActiveAnnotationChange: (id: string | null) => void;
  getScrollBehavior: () => ScrollBehavior;
  /**
   * Getter for the current active annotation id. The auto-advance effect uses
   * this to AVOID clobbering an externally-set active id (e.g., from the
   * Alt+]/Alt+[ keyboard shortcut). Without this, every reactive read of
   * `getAnnotations()` would re-fire the effect and reset the active id to
   * `targets[reviewIndex]`.
   */
  getActiveAnnotationId?: () => string | null;
  /**
   * The ACTIVE document's format, re-read on use (#1460). A plaintext document
   * cannot hold a newline inside a block, so a multi-line suggestion has to be
   * accepted as separate blocks rather than as hard breaks.
   *
   * A getter, not a value, for the same reason the editor extensions take one:
   * Save-As promotes a document in place, so a format captured once outlives its
   * own truth. Omitted ⇒ `undefined` ⇒ treated as not plaintext, leaving accept
   * exactly as it was.
   */
  getFormat?: () => string | undefined;
  /**
   * Called when accepting a suggestion fails because its range could not be
   * resolved (e.g. the underlying text changed since the suggestion was
   * created). The annotation has already been reverted to `"pending"` by the
   * time this fires. Callers use this to surface a toast — keep any message
   * generic per ADR-027 (never echo annotation content here).
   */
  onApplyFailed?: (ann: Annotation) => void;
  /**
   * Called when undoing an accepted suggestion is refused because the stored
   * `textSnapshot` is a truncated prefix (#1486) — restoring it would delete
   * everything past the 200-character cap.
   *
   * Separate from `onApplyFailed` because the two failures differ in kind, and
   * the difference is what the user needs told. An apply failure is transient:
   * the text moved, and retrying after a scroll or an edit can succeed. This
   * one is a property of the stored record, so it will refuse identically
   * forever — a message promising a retry would be a lie. The annotation stays
   * `accepted` and the document keeps the suggested text; the editor's own
   * Ctrl+Z is the remaining route back.
   *
   * ADR-027 applies as above: never echo annotation content into the message.
   *
   * `reason` exists because the two permanent declines fail for unrelated
   * reasons and a single message would be wrong for one of them: a truncated
   * snapshot is missing text, while a block boundary inside a container has
   * every character and nowhere correct to put the split.
   */
  onUndoFailed?: (ann: Annotation, reason: UndoDeclineReason) => void;
}

export interface UseAnnotationReviewReturn {
  resolveAnnotation: (id: string, status: "accepted" | "dismissed") => void;
  undoResolveAnnotation: (id: string) => boolean;
  handleAccept: (id: string) => void;
  handleDismiss: (id: string) => void;
  scrollToAnnotation: (ann: Annotation) => void;
  getRecentlyResolved: () => Set<string>;
  getReviewIndex: () => number;
  getReviewTargets: () => Annotation[];
}

export function useAnnotationReview({
  getYdoc,
  getEditor,
  getAnnotations,
  onActiveAnnotationChange,
  getScrollBehavior,
  getActiveAnnotationId,
  onApplyFailed,
  onUndoFailed,
  getFormat,
}: UseAnnotationReviewParams): UseAnnotationReviewReturn {
  // Reactive state
  let reviewIndex = $state(0);
  let recentlyResolved = $state(new Set<string>());
  const pendingRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastResolvedId: string | null = null;

  // Cleanup timers on component destroy
  onDestroy(() => {
    for (const timer of pendingRemovalTimers.values()) clearTimeout(timer);
    pendingRemovalTimers.clear();
  });

  function getReviewTargets(): Annotation[] {
    return getAnnotations().filter(isPendingReviewTarget);
  }

  function resolveAnnotation(id: string, status: "accepted" | "dismissed") {
    const y = getYdoc();
    if (!y) return;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw) return;
    // Idempotency: if the annotation has already been resolved (accepted or
    // dismissed), no-op. Defends against any future double-fire path —
    // critically, prevents `applySuggestion` from running twice and inserting
    // the suggested text twice.
    if (raw.status !== "pending") return;
    const ann = sanitizeAnnotation(raw, devSanitizeWarn);
    map.set(id, { ...ann, status });

    if (status === "accepted" && ann.suggestedText !== undefined) {
      const editor = getEditor();
      if (editor) {
        const applied = applySuggestion(ann, editor, y, getFormat?.());
        if (!applied) {
          // Revert annotation status — text replacement failed
          map.set(id, { ...ann, status: "pending" });
          onApplyFailed?.(ann);
          return;
        }
      }
    }

    lastResolvedId = id;
    recentlyResolved = new Set(recentlyResolved).add(id);
  }

  function scheduleRemoval(id: string) {
    const existing = pendingRemovalTimers.get(id);
    if (existing) clearTimeout(existing);
    pendingRemovalTimers.set(
      id,
      setTimeout(() => {
        pendingRemovalTimers.delete(id);
        const next = new Set(recentlyResolved);
        next.delete(id);
        recentlyResolved = next;
      }, 3000),
    );
  }

  function removeFromResolved(id: string) {
    const timer = pendingRemovalTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      pendingRemovalTimers.delete(id);
    }
    const next = new Set(recentlyResolved);
    next.delete(id);
    recentlyResolved = next;
  }

  function undoResolveAnnotation(id: string): boolean {
    const y = getYdoc();
    if (!y) return false;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw || raw.status === "pending") {
      removeFromResolved(id);
      return false;
    }
    const ann = sanitizeAnnotation(raw, devSanitizeWarn);
    const editor = getEditor();

    if (ann.status === "accepted" && ann.suggestedText !== undefined && editor) {
      try {
        const newText = ann.suggestedText;
        const oldText = ann.textSnapshot;
        if (typeof newText === "string" && typeof oldText === "string") {
          // A truncated snapshot is a PREFIX of what was there (#1486).
          // Restoring it would delete everything past the 200-char cap, which
          // is the opposite of what undo is for — decline instead.
          //
          // `isSnapshotTruncated` also catches records written BEFORE this
          // change, which carry no flag and are marked only by the old trailing
          // ellipsis. Without that arm the fix would protect new annotations
          // while leaving every existing one corrupting on undo.
          //
          // Unlike the two declines below this one is DETERMINISTIC and
          // permanent — no later click will ever undo this annotation — so it
          // reports through `onUndoFailed` rather than only `console.warn`.
          if (isSnapshotTruncated(ann)) {
            console.warn(
              `[undo] Snapshot for annotation ${id} was truncated at capture; refusing to restore a partial revert`,
            );
            onUndoFailed?.(ann, "truncated-snapshot");
            // `removeFromResolved`, not `scheduleRemoval` like the transient
            // declines below. Those reschedule the 3s window because a retry
            // might succeed; this one never will, and rescheduling would keep
            // a dead Undo button on screen for another three seconds after
            // every click. Retiring it immediately matches the toast.
            removeFromResolved(id);
            return false;
          }
          const resolved = annotationToPmRange(ann, editor.state.doc, y);
          if (!resolved) {
            console.warn(`[undo] Cannot resolve range for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
          }
          const currentText = rangeText(editor, resolved.from, resolved.to);
          // Compared against what accept ACTUALLY WROTE, not against
          // `suggestedText` — in a plaintext document those differ (#1460): a
          // heading's lines are joined with spaces, and every line ending is
          // normalized to `"\n"`. Comparing the raw suggestion made a heading
          // accept permanently un-undoable while looking like a transient
          // "text changed" decline.
          const expectedText = appliedProjection(editor, resolved.from, newText, getFormat?.());
          if (currentText !== expectedText) {
            console.warn(`[undo] Text changed since accept for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
          }
          // Deliberately NOT tagged with AUTHORSHIP_ORIGIN_META, so this falls
          // to the `"user"` default. `textSnapshot` is the document's PRIOR
          // content, whose author this site does not know: usually the user,
          // but Claude if an earlier `tandem_edit` wrote it and then suggested
          // a revision on top. The correct answer is to restore the authorship
          // entry the accept reaped, which needs the durable/`relRange` work in
          // #1471 — until then the common case is right and the rare one is
          // #1388's inversion in miniature. Tracked there, not silently left.
          // Same literal-content treatment as accept (#1477): restoring through
          // a raw string put back a literal newline where the snapshot recorded
          // a hard break as "\n", so undo could not restore what accept took
          // away even when the range was right.
          //
          // What accept and undo need differs, though, and `literalRestoreContent`
          // is where they part (#1486). Accept reads a suggestion string, where
          // every "\n" can only mean a hard break. Undo restores what was
          // ACTUALLY there, and a flat "\n" could have been a block boundary, a
          // hard break or a soft wrap — three things that serialize three
          // different ways. `textSnapshotBreaks` carries the distinction the
          // string threw away; absent (a record written before this, or the
          // common single-block annotation) means "all literal", which is what
          // the code here did before.
          const inCode = isCodeContext(editor, resolved.from);
          const restored = literalRestoreContent(
            oldText,
            // A code block's content expression does not admit `hardBreak`, and
            // inside one a newline is genuinely a newline — so the recorded
            // structure is deliberately ignored rather than used to build
            // schema-invalid content. Mirrors `asCodeText` on the accept path.
            inCode
              ? []
              : (plaintextRestoreBreaks(oldText, getFormat?.()) ?? ann.textSnapshotBreaks),
            marksAcrossRange(editor, resolved.from, resolved.to),
          );
          // Checked BEFORE `restored.blocks`, because an opaque boundary produces
          // no `"block"` entries and would otherwise fall through to the inline
          // path — restoring a literal newline where a heading boundary was,
          // which the serializer writes as a setext underline. The server marks
          // a boundary opaque when the two blocks were not both plain paragraphs;
          // this builder can only emit paragraphs, so there is nothing correct to
          // build. Same permanent-decline treatment as the guards below.
          if (restored.opaque) {
            console.warn(
              `[undo] Annotation ${id} spans a boundary between unlike blocks; refusing to restore`,
            );
            onUndoFailed?.(ann, "block-structure");
            removeFromResolved(id);
            return false;
          }
          if (restored.blocks) {
            // A recorded block boundary can only be honoured where splitting the
            // receiving textblock yields the right siblings — at the top level.
            // Anywhere else the split invents structure (a list item gains a
            // second paragraph instead of a second item), so decline. Same
            // permanent-decline treatment as the truncation guard above.
            if (!canRestoreBlockBoundary(editor, resolved.from)) {
              console.warn(
                `[undo] Annotation ${id} spans a block boundary inside a container; refusing to restore`,
              );
              onUndoFailed?.(ann, "block-structure");
              removeFromResolved(id);
              return false;
            }
            // NOT `insertContentAt`. Given closed block nodes at an inline
            // position it routes to `tr.replaceWith` → `new Slice(frag, 0, 0)`,
            // which SPLITS the host block around the insertion instead of
            // merging into it: "pre|MERGED|post" came back as four paragraphs
            // where it should be two. An open slice (openStart/openEnd = 1)
            // says "these ends are cut, join them to what they land beside",
            // which is exactly what accept's deletion did in reverse.
            const { schema } = editor.state;
            const nodes = restored.content.map((json) => schema.nodeFromJSON(json));
            const slice = new Slice(Fragment.from(nodes), 1, 1);
            editor
              .chain()
              .focus()
              .command(({ tr }) => {
                tr.replace(resolved.from, resolved.to, slice);
                return true;
              })
              .run();
          } else {
            let chain = editor
              .chain()
              .focus()
              .deleteRange({ from: resolved.from, to: resolved.to });
            if (restored.content.length > 0) {
              chain = chain.insertContentAt(resolved.from, restored.content);
            }
            chain.run();
          }
        }
      } catch (err) {
        console.warn(`[undo] Failed to revert text for annotation ${id}:`, err);
        scheduleRemoval(id);
        return false;
      }
    }

    map.set(id, { ...ann, status: "pending" as const });
    removeFromResolved(id);
    if (lastResolvedId === id) {
      lastResolvedId = null;
    }
    return true;
  }

  function handleAccept(id: string) {
    resolveAnnotation(id, "accepted");
  }

  function handleDismiss(id: string) {
    resolveAnnotation(id, "dismissed");
  }

  function scrollToAnnotation(ann: Annotation) {
    const ed = getEditor();
    if (!ed) return;
    const resolved = annotationToPmRange(ann, ed.state.doc, getYdoc());
    if (!resolved) return;
    ed.chain().focus().setTextSelection({ from: resolved.from, to: resolved.to }).run();
    const domAtPos = ed.view.domAtPos(resolved.from);
    const el = domAtPos.node instanceof HTMLElement ? domAtPos.node : domAtPos.node.parentElement;
    el?.scrollIntoView({ behavior: getScrollBehavior(), block: "center" });
  }

  // Empty selection is a valid resting state — there's no dedicated review mode
  // anymore, so we never force-select on null (that was the old bulk-review
  // model that always parked a target on the first pending annotation). We only
  // AUTO-ADVANCE: when the currently-active annotation stops being a live pending
  // one (deleted/accepted/dismissed), move selection to the FIRST remaining
  // review target. (`reviewIndex` has no sequential cursor anymore — nothing
  // increments it, so it sits at 0 and `targets[reviewIndex]` is `targets[0]`;
  // the second effect below only ever clamps it back down.) When no targets
  // remain that fallback is null, so selection naturally lands on empty. A
  // deliberate deselect (Escape / click-off) sets null and stays null here.
  //
  // #768 Bug 2 nuance preserved: "still live" checks the full pending annotation
  // set, not just review targets, so a user-clicked highlight overlapping a Claude
  // comment (author === "user", excluded from getReviewTargets) stays focused
  // instead of being clobbered back to the comment.
  $effect(() => {
    const currentActive = getActiveAnnotationId?.() ?? null;
    if (currentActive === null) return;
    const stillLive = getAnnotations().some(
      (a) => a.id === currentActive && a.status === "pending",
    );
    if (!stillLive) {
      const targets = getReviewTargets();
      onActiveAnnotationChange(targets[reviewIndex]?.id ?? null);
    }
  });

  // Keep review index in bounds when annotations change
  $effect(() => {
    const targets = getReviewTargets();
    if (reviewIndex >= targets.length) {
      reviewIndex = Math.max(0, targets.length - 1);
    }
  });

  return {
    resolveAnnotation,
    undoResolveAnnotation,
    handleAccept,
    handleDismiss,
    scrollToAnnotation,
    getRecentlyResolved: () => recentlyResolved,
    getReviewIndex: () => reviewIndex,
    getReviewTargets,
  };
}
