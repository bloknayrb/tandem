# Sub-PR R — Rail collapse rebuild (always-mounted dual-layer)

> Status: PLAN (for adversarial review). Target branch: `design-impl/r-rail-rebuild` → `feat/design-system-impl`.
> Conflict-resolved ref: this is the one genuine structural delta in the refreshed bundle (per the
> 2026-05-27 replan). Supersedes the merged 1.4 `PeekStrip` *swap*; subsumes manifest surface C13.

## Surface header (plain English)

Today, collapsing a side rail is a **swap**: `{#if visible} <rail> {:else} <PeekStrip/>`. One element
unmounts as the other mounts. The refreshed bundle rebuilds this as an **always-mounted dual-layer**:
a single rail container that shrinks its *width* on collapse, with two layers that crossfade —
`.rail-full` (the panel content) and `.rail-peek` (a thin sliver showing contextual hints). The
viewport-edge stays put; only the inside edge retreats, so the panel reads as "tucking itself away
to its own edge" rather than being replaced by a separate strip.

**Contextual peek content (confirmed with Bryan 2026-05-27):**
- Left rail (outline) peek = **outline tick-marks** (h1/h2/h3 widths), decorative.
- Right rail (annotations) peek = **annotation dots**, one per annotation, colored by a type→token map.

Bundle source: `docs/design-system-impl/bundle/extracted/ui_kits/app/{LeftRail,SideRail,PeekStrip}.svelte`
+ `app.css` lines 245–376 (`.c7-rail`, `.rail-full`, `.rail-peek`, `.peek-tick`, `.peek-dot`).

## Production reality (verified against branch head, NOT bundle file names)

The rail is rendered **inline in `src/client/App.svelte`** — there is no `AppShell`/`LeftRail`/`SideRail`.
Verified anchors (branch `design-impl/w0-foundation`, head `ba8cf7c`):

- **L1239–1258** left block: `{#if effectiveLeftVisible} <div data-testid="left-outline-rail" transition:railSlide …> <PanelSlot kind="outline" …/> {@render edgeCollapse("left", …)} </div> {@render resizeHandle("left", …)} {:else} <PeekStrip side="left" onActivate={toggleLeftPanel}/> {/if}`
- **L1262–1326** right block: symmetric — resize handle, `<div transition:railSlide …>` with `edgeCollapse`, the `.rail-tabs-row` (Annotations/Chat tabs, `annotations-tab`/`chat-tab` testids), then `PanelSlot kind="chat"` + `PanelSlot kind="side"`; `{:else} <PeekStrip side="right" …/>`.
- **L617–630** `createDragResize({ side, initialWidth, getVisible: () => effectiveLeftVisible })` (and right). `getVisible` aborts an in-flight drag + gates width-persist (`useDragResize.svelte.ts` L29–38, L75, L92). **`getVisible` already means "rail is expanded"** — `collapsed === !effectiveLeftVisible`, so this needs NO redefinition.
- **L636–637** `effectiveLeftVisible/RightVisible = $derived(layoutModel.{left,right}Visible)` — the LayoutModel (ADR-037) owns the orphan-rail rule + solo-mode right-rail override. **R must not touch LayoutModel** — `collapsed` derives from these, the toggle paths stay as-is.
- **L642–652** `focusToggleTarget(side, nextVisible)`: `queueMicrotask` → focuses `panel-edge-collapse-${side}` (expanding) or `peek-strip-${side}` (collapsing).
- **L676–684** `railSlide` transition (applied L1244/L1267): only fires on mount/unmount.
- **L1461–1502** `resizeHandle` snippet; **L1510–1523** `edgeCollapse` snippet (`panel-edge-collapse-${side}`, `role=button`, `tabindex=-1`).
- **`src/client/panels/PeekStrip.svelte`** — the collapsed sliver. `peek-strip-${side}` testid, `tabindex=-1`, hover-grow 14→28px, rotated label, chevron. Its `:hover`/`:focus-visible` rules already encode the #859 "restoration focus must be visually inert" fix.
- **L188** `visibleAnnotations = $derived(yjsSync.annotations)` — **all** annotations (the per-type FilterBar lives *inside* `SidePanel`, not lifted to App).

## Target structure (REVISED post-review — full always-mounted, display-toggled for the snap)

**Decision (Bryan, 2026-05-27): full always-mounted dual-layer NOW** (honors the locked "structure
now, animation later"). Review surfaced that always-mounting with `opacity:0` regresses scroll + tab
order (see Blast §1). Resolution: always-mount both layers but **display-toggle** them for the snap
state — `display:none` has no layout box, so it neutralizes both regressions *and* keeps the component
instance alive (state/scroll-position persist across collapse — the real upgrade over today's unmount).
This **mirrors `PanelSlot.svelte`'s existing `display:${visible?'flex':'none'}` convention** rather than
inventing one. The `opacity:0` crossfade (which needs both layers simultaneously laid out, and the
panel-effect gating that then requires) is exactly the animation — it defers to **#798** with the rest
of the motion work.

Replace each `{#if visible}…{:else}<PeekStrip/>{/if}` with a single **rail shell** that is always mounted:

```
<div class="rail-shell rail-shell-{side}" class:collapsed={!effectiveVisible}>
  <div class="rail-full" style="display: {effectiveVisible ? 'flex' : 'none'}; …"> … existing rail content (PanelSlot etc.) … </div>
  <PeekStrip {side} collapsed={!effectiveVisible} onActivate={togglePanel}
             kind={side==="left" ? "outline" : "annotations"}
             annotations={side==="right" ? visibleAnnotations : undefined} />
</div>
```

Layout (mirrors bundle `app.css` 245–353, ported to production tokens — all already exist):
- `.rail-shell`: flex item, `flex-shrink:0`, `overflow:hidden`, `position:relative`, the existing
  `margin-top/bottom` clearances, `surface-muted` bg, inner-radius, rail shadow. Width =
  `effectiveVisible ? dragWidth+'px' : 'var(--tandem-peek-w, 14px)'`.
- `.rail-full`: pinned to the inside edge, `width: ${dragWidth}px`, **`display:none` when collapsed**
  (not `opacity:0` — that's the deferred crossfade). No `aria-hidden`/`inert` needed: `display:none`
  already removes it from the a11y tree + Tab order.
- `.rail-peek` (PeekStrip button): inside edge, `display:none` when expanded, shown when collapsed.
  Peek is pure-presentation (ticks/dots from a `$derived`, no DOM effects) so always-mounting it is free.
- **Resize handle stays gated to the expanded state** (rendered only when `effectiveVisible`), preserving
  the E2E visibility probe (see Blast radius §E2E).
- **`/* TODO motion #798 */`**: snap (display-toggle) → opacity-crossfade + 360ms width slide + the
  SidePanel/ChatPanel/OutlinePanel scroll-effect gating that simultaneous layout then requires.

## Blast-radius handling (the swap is load-bearing — all in the SAME PR)

1. **`focusToggleTarget` (L642–652):** unchanged logic, still correct, and the queueMicrotask
   post-mount race actually *disappears* (both targets always mounted — a reliability improvement).
   The helper focuses by *which is becoming active*, and `queueMicrotask` defers until after the
   display flip applies: when expanding, `panel-edge-collapse-${side}` is `display:flex` → focusable;
   when collapsing, `peek-strip-${side}` is `display:flex` → focusable. Keep both testids.
   **Review-found regression (svelte HIGH + adversarial), resolved by display-toggle:** with `opacity:0`
   always-laid-out, SidePanel's `activeAnnotationId` `scrollIntoView` (SidePanel ~L265–285) and
   filter-reset `scrollTo` (~L235–262) would fire on hidden cards inside the `overflow:hidden` shell and
   scroll the editor row (the L1225–1228 focus-pop the comment forbids); its focusable children would
   also stay in the Tab order. **`display:none` neutralizes both** (no layout box → `scrollIntoView`/
   `scrollTo` are no-ops; removed from Tab order + a11y tree). So for the snap, **no panel-effect gating
   and no `inert` are needed** — both move to #798 when the crossfade reintroduces simultaneous layout.

2. **`railSlide` (L676–684, applied L1244/L1267):** becomes dead under CSS-width collapse (no
   mount/unmount). **Remove** the function + its two `transition:` usages + the now-false block comment
   at L1264–1265 and the `onscroll` comment at L1232–1234 referencing the railSlide window. The
   collapse ships as a **snap** (instant width change, instant opacity swap) = the bundle's
   `prefers-reduced-motion` variant. Leave `/* TODO motion #798: rail width 360ms + rail-full/peek
   opacity crossfade (bundle app.css 263–353) */` where the transition would thread in.

3. **`createDragResize` getVisible (L620–630):** no change. `getVisible: () => effectiveLeftVisible`
   already returns "expanded". Drag handle only renders when expanded, so a drag can't start while
   collapsed; the in-flight-abort `$effect` still fires correctly if the rail collapses mid-drag (e.g.
   a keyboard toggle during drag).

4. **Testids + snapshot:** **no testid changes.** `left-outline-rail`, `panel-edge-collapse-{side}`,
   `peek-strip-{side}`, `left-panel-resize-handle`, `panel-resize-handle` all preserved. Peek
   ticks/dots are decorative (`aria-hidden`), **no testids added**. ⇒ `testid-set.snap.txt` and
   `testid-manifest.md` are untouched — zero snapshot churn, zero manifest edit. (If review decides a
   peek-content testid is warranted for coverage, that's the *only* thing that would touch the snapshot,
   and R would then commit the regenerated snapshot per the collision protocol.)

5. **E2E `tests/e2e/keyboard-shortcuts.spec.ts` (L253–305):** the test probes visibility via
   `leftHandle.count()` / `rightHandle.count()` on the **resize-handle** testid, then asserts
   `getByTestId(visible ? "panel-edge-collapse-X" : "peek-strip-X").toBeFocused()` + `expectNoFocusRing`.
   Because the resize handle stays **gated to the expanded state**, `.count()` still flips 1↔0 on
   toggle, so `expect.poll(count).not.toBe(initial)` still works. Both focus-target testids are always
   present but the assertion is `.toBeFocused()` (focus identity, not existence), so it still
   discriminates. **Prediction: the E2E test passes unchanged.** This is the single most important
   thing for the reviewer to stress-test — if the always-mounted resize handle or a focus-ring
   regression breaks it, the assertion model (not just testid names) must change in this PR.

6. **`PeekStrip.svelte`:** extend, don't rewrite. Add props `collapsed: boolean`,
   `kind: "outline" | "annotations"`, optional `annotations`. Render peek-content (`.peek-tick` ×N for
   outline, `.peek-dot` ×annotations for right). **Keep `tabindex=-1`** (do NOT adopt the bundle's
   `collapsed?0:-1`). Review (svelte HIGH) flagged that tab-reachable peek + the retained
   `:focus-visible{outline:none}` is the *inverse* of #859 — a keyboard user would Tab onto it and get
   no focus ring. Production's documented rail-toggle keyboard path is **Alt+Shift+Arrow** (PeekStrip
   L26–27), and the edge-collapse zone is also `tabindex=-1`; keeping peek out of the Tab sequence is
   consistent with that model and preserves the #859 inert-restoration-focus fix exactly. (Intentional
   divergence from bundle, which uses a Tab-reachable peek.) Preserve every existing `.peek-strip*`
   style + the #859 hover/focus comments. `aria-expanded={!collapsed}` is fine to add (semantic, no
   focus implication).

## Peek-content data (crdt + annotation-model constraints)

- **Right-rail dots:** `visibleAnnotations.map(dotClass)`. **dotClass FIXED for production taxonomy**
  (annotation-model CRITICAL: the bundle's `type==="suggest"` does NOT exist in production — real enum
  is `highlight|note|comment` per `src/shared/types.ts:16`; suggestions are `type:"comment"` +
  `suggestedText` per `sanitize.ts`). Correct map, in order:
  ```
  function dotClass(a) {
    if (a.type === "highlight") return "hl";
    if (a.type === "comment" && a.suggestedText != null) return "suggest"; // Claude suggestion (row 5)
    if (a.author === "claude") return "claude";
    if (a.author === "import") return "import";   // Word-imported reviewer comments — distinct from user
    return "user";                                 // user note / comment / (import handled above)
  }
  ```
  Colors via existing tokens: `--tandem-author-user|claude`, `--tandem-suggestion`,
  `--tandem-highlight-yellow` (verified to exist — resolves the `check:tokens` concern; bundle's raw
  `oklch(0.78 0.14 90)` is NOT used). **`import` decision:** Word-comment authors get their own dot
  class — confirm a token (e.g. reuse `--tandem-author-claude` or a neutral `--tandem-fg-muted`); pick
  during impl + flag in PR body. All six taxonomy cases (user note/comment/highlight, claude
  comment/suggestion, import) now covered; none fall through mis-colored.
  - **crdt:** dots derive from **list order + type only** — NO vertical alignment to text anchors, NO
    RelativePosition reads. Pure presentation; `annotation.ts`/`authorship.ts`/`positions.ts` untouched.
  - **annotation-model:** dots reflect `visibleAnnotations` **unfiltered** (matches the bundle, which
    does not filter peek dots by the FilterBar chip). NOT gated by the 1.13 editor decoration-mute
    (`DECORATION_VISIBILITY_KEY`) — that's an editor surface, the rail is independent. Notes ARE shown
    as dots: this is **not** an ADR-027 concern — the user already sees their own notes throughout the
    client; ADR-027's boundary is server→Claude (MCP/channel), which this never touches. **No
    `src/server/` changes.**
- **Left-rail ticks:** the bundle uses 5 static decorative ticks. Production has a live outline
  (`tandem_getOutline`/OutlinePanel). Decision for this PR: **static decorative ticks** (a fixed small
  set, `aria-hidden`) — deriving real heading levels into the peek sliver is scope creep with no
  coverage value, and the sliver is 14px. Flag if review prefers a lightweight live-heading map.

## Verification

- `npm run typecheck` (server+client) → `npm run check:tokens` clean (watch the highlight-yellow token)
  → targeted `vitest` → full `npm run test:e2e` (ubuntu CI authoritative; the keyboard-shortcuts spec is
  the gate). claude-in-chrome smoke both themes: collapse/expand both rails, confirm width snaps, peek
  ticks/dots render, resize handles intact, **no focus trap**, and the 1.13 decorations dropdown + 1.11
  popup still render unclipped over the editor (the shell's `overflow:hidden` must not clip them — they
  portal/overlay outside the shell, but verify).
- Mandatory reviewers: **svelte-migration-reviewer** (always-mounted `getVisible`/`$effect` interactions,
  `bind:this`/derived reactivity, transition removal), **annotation-model-reviewer** (right-rail dots
  derive correctly + ADR-027 boundary).
- a11y: peek button tab-reachability change (`tabindex` collapsed-gated), `aria-hidden`/`aria-expanded`
  correctness, focus restoration unchanged.

## Out of scope / deferred
- Width-slide + opacity-crossfade animation → Phase 4 #798 (TODO left in place).
- LayoutModel semantics, solo-mode rules, margin-view interaction (R only changes how the rail
  *renders* collapsed; `marginLeft/RightVisible` already derive from `effectiveVisible`).
- Cluster 3.5 (Margin Column) also edits App.svelte → serializes *after* R.
