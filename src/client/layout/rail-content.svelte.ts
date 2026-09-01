import type { Editor as TiptapEditor } from "@tiptap/core";
import { toPmPos } from "../../shared/positions/types";
import { SNAPSHOT_CAP } from "../../shared/snapshot";
import type { Annotation, CapturedAnchor } from "../../shared/types";
import { pmSelectionToFlat } from "../positions";
import type { RailTab } from "./model.svelte";

/**
 * What the right rail is currently SHOWING, as opposed to whether it is shown.
 *
 * ADR-035 Unit 10c. `createLayoutModel` (Unit 10b) owns rail visibility and
 * which of the two fixed tabs is selected; this owns the two things that live
 * inside the rail and outlive a tab switch — the transient chat reveal with its
 * captured selection anchor, and the annotation-review selection.
 *
 * **Why a sibling module rather than a fold into `createLayoutModel`.** The
 * first draft argued that `createLayoutModel` is chartered as a store over
 * *persisted* settings and that unpersisted state therefore belongs elsewhere.
 * That argument is recorded here because it is wrong twice over and someone
 * will reach for it again: the premise is false (`pendingAnnotationBadge`
 * derives from an injected annotation list and is neither persisted nor seeded
 * from a setting), and it does not discriminate — "layout means over settings"
 * disqualifies a sibling in `layout/` just as thoroughly. The two reasons that
 * do discriminate:
 *
 * 1. **Effect and listener ownership.** `createLayoutModel` registers zero
 *    effects and zero listeners; it is derivations plus actions. This model owns
 *    three `$effect`s and two capture-phase `window` listeners with a teardown.
 * 2. **Scope.** `activeAnnotationId` is per-document. Every member of
 *    `createLayoutModel` is app-global.
 *
 * Within `layout/`, `editor-stage.svelte.ts` is the `$effect` precedent (it
 * returns no teardown); the teardown-returning window-listener precedent is
 * `hooks/useDocumentWorkspace.svelte.ts`.
 *
 * **A factory, not a module singleton**, so the effects register in the
 * caller's effect root and tear down with the component.
 *
 * **Every injected read is a thunk, and that is not style.** Four of them break
 * silently as by-value captures: a frozen `activeRailTab` makes
 * `captureSelectionForChat` refuse always or never, a frozen
 * `effectiveRightVisible` makes the reveal never or always open, a frozen
 * `findBarOpen` re-creates the exact stray-deselect bug its guard was written
 * for, and `editor` is `$state(null)` at mount — so a by-value capture is
 * *guaranteed* permanently null and Escape would stop returning focus to the
 * editor.
 */
export interface RailContentOptions {
  /** Which right-rail tab is selected. From `createLayoutModel`. */
  getActiveRailTab: () => RailTab;
  /** Is the right rail pinned open? A reveal only opens over a rail that is not. */
  getEffectiveRightVisible: () => boolean;
  /** Is the find bar open? Suppresses the Escape deselect — see `onEscapeDeselect`. */
  getFindBarOpen: () => boolean;
  /** The live editor, or null before mount. */
  getEditor: () => TiptapEditor | null;
  /** The active document id, used to close a reveal that has outlived its document. */
  getActiveTabId: () => string | null;
  /** The annotations currently rendered. */
  getVisibleAnnotations: () => Annotation[];
  /** First remaining review target, for `activeOrFirstPending`'s fallback branch. */
  getFirstReviewTarget: () => Annotation | undefined;
}

export interface RailContentModel {
  /** Is the transient chat reveal open? */
  readonly revealOpen: boolean;
  /** Selection anchor attached to the next chat message, if any. */
  readonly capturedAnchor: CapturedAnchor | null;
  /** The annotation the review UI is focused on. */
  readonly activeAnnotationId: string | null;
  setCapturedAnchor(anchor: CapturedAnchor | null): void;
  setActiveAnnotationId(id: string | null): void;
  /** Open the reveal over a collapsed rail, remembering which document it belongs to. */
  openReveal(): void;
  /** Tear the reveal down. Idempotent. */
  closeReveal(): void;
  /** Attach the editor's current selection to the next chat message. */
  captureSelectionForChat(): void;
  /** The focused annotation, or the first review target when nothing is focused. */
  activeOrFirstPending(): Annotation | undefined;
}

export function createRailContentModel(opts: RailContentOptions): RailContentModel {
  // Command-driven Chat-only float. Unlike `railFloat` (hover), this never
  // mutates saved panel visibility and has an explicit send/Escape/outside/
  // tab/pin lifecycle.
  let chatReveal = $state(false);
  // **Deliberately a plain variable, not `$state`, and it must not appear on
  // the interface.** It is a write-once companion read in exactly one place,
  // under a guard that reads `chatReveal` first. A getter over a plain `let` is
  // a permanently frozen read, which is the failure this comment exists to stop
  // someone from introducing while "finishing" the interface.
  //
  // The reason is NOT that promoting it would change the effect's dependency
  // set into a self-trigger. That was the plan's stated risk and it is wrong:
  // the document-switch effect already writes one of its own dependencies
  // (`chatReveal`, read unconditionally) and converges anyway.
  let chatRevealDocumentId: string | null = null;
  let capturedAnchor = $state<CapturedAnchor | null>(null);
  let activeAnnotationId = $state<string | null>(null);

  function closeReveal(): void {
    if (!chatReveal) return;
    chatReveal = false;
    chatRevealDocumentId = null;
  }

  function openReveal(): void {
    // A command reveal is intentionally independent from hover-float state and
    // saved rail/Solo preferences. Pinned rails simply switch to Chat, so this
    // is a no-op when the rail is already up.
    if (opts.getEffectiveRightVisible()) return;
    chatRevealDocumentId = opts.getActiveTabId();
    chatReveal = true;
  }

  function captureSelectionForChat(): void {
    if (opts.getActiveRailTab() === "chat") return;
    const editor = opts.getEditor();
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const range = pmSelectionToFlat(editor.state.doc, { from: toPmPos(from), to: toPmPos(to) });
    const text = editor.state.doc.textBetween(from, to, "\n");
    capturedAnchor = {
      ...range,
      // Keeps the in-band ellipsis that annotations shed in #1486, deliberately.
      // Not because it stays on this machine — it is rendered in the message
      // history and travels to the AI in the `tandem_checkInbox` payload — but
      // because nothing ever writes it BACK into the document. That is the whole
      // of why the ellipsis was dangerous on annotations: undo restored it as
      // three literal characters. With no restore path there is no such hazard,
      // and a visible "there's more" is worth more to a reader than a flag.
      // `SnapshotBearing` requires an `id` specifically so this cannot be handed
      // to `isSnapshotTruncated` by mistake — see `shared/snapshot.ts`.
      textSnapshot: text.length > SNAPSHOT_CAP ? `${text.slice(0, SNAPSHOT_CAP - 3)}...` : text,
    };
  }

  // Reveal teardown: an outside click or an Escape closes it.
  //
  // Both listeners are CAPTURE-phase on purpose. Escape has to beat the chat
  // composer's own textarea handler, and the pointerdown has to run before any
  // component-level click handling can re-render the thing being measured.
  $effect(() => {
    if (!chatReveal) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const rail = document.querySelector(".rail-shell-right");
      // A click inside the rail is a click on the reveal itself.
      if (target && rail?.contains(target)) return;
      closeReveal();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeReveal();
      opts.getEditor()?.view.focus();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onEscape, true);
    };
  });

  // A reveal belongs to the document it was opened over; switching documents
  // ends it. Tracked deps are exactly {active tab id, chatReveal}.
  $effect(() => {
    const activeId = opts.getActiveTabId();
    if (chatReveal && activeId !== chatRevealDocumentId) closeReveal();
  });

  // Escape deselects the focused annotation.
  //
  // NOT capture-phase, and not merged with the reveal's Escape handler: this one
  // must lose to anything that handles Escape first. A modal or the slash menu
  // closes on Escape and calls `preventDefault` without stopping propagation, so
  // this listener DOES run and `e.defaultPrevented` is what skips it.
  // `findBarOpen` is explicit because the find bar closes on Escape WITHOUT
  // `preventDefault`, so with focus back in the editor (e.g. after jumping to a
  // match) while find is still open, neither guard above would catch the stray
  // deselect. Reads happen at event time, outside any tracking scope, so the
  // effect registers once and never re-registers.
  $effect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (activeAnnotationId === null || opts.getFindBarOpen()) return;
      const el = document.activeElement as HTMLElement | null;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      const inEditingSurface =
        !el ||
        el === document.body ||
        !!el.closest(
          '.ProseMirror, [data-testid="editor-root"], [data-testid="annotation-list-scroll-container"]',
        );
      if (!inEditingSurface) return;
      e.preventDefault();
      activeAnnotationId = null;
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  });

  return {
    get revealOpen() {
      return chatReveal;
    },
    get capturedAnchor() {
      return capturedAnchor;
    },
    get activeAnnotationId() {
      return activeAnnotationId;
    },
    setCapturedAnchor(anchor: CapturedAnchor | null) {
      capturedAnchor = anchor;
    },
    setActiveAnnotationId(id: string | null) {
      activeAnnotationId = id;
    },
    openReveal,
    closeReveal,
    captureSelectionForChat,
    // **A plain function, not `$derived`, and #768 is why.** The fallback branch
    // returns `getReviewTargets()[0]`, always a Claude target, but the active
    // branch returns WHATEVER is selected — which can be a user highlight
    // overlapping a Claude comment. The `author !== "user"` guard at the call
    // sites is load-bearing for that branch, and turning this into a cached
    // derivation invites folding the guard in here, where it would also filter
    // the fallback and change behaviour.
    activeOrFirstPending(): Annotation | undefined {
      return activeAnnotationId
        ? opts.getVisibleAnnotations().find((a) => a.id === activeAnnotationId)
        : opts.getFirstReviewTarget();
    },
  };
}
