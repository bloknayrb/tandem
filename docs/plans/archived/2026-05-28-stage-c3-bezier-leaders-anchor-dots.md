# Stage C-3 — Bezier leaders + anchor dots (V2)

> **Status:** V2, post-adversarial-review. Replaces V1 (which proposed extending `useMarginPositions` to emit `{top, anchorX}` per id). V2 collapses to pure visual upgrade — zero hook changes.
> **Branch:** sub-PR off `feat/design-system-impl` (proposed: `design-impl/3.5-c3-bezier-leaders`).
> **Inputs:**
> - `docs/plans/2026-05-28-stage-c-cleave-locks.md` (cleave + locks; two locks tombstoned this turn).
> - `~/.claude/plans/the-current-way-we-compiled-thimble.md` §4 / §10 / §12 (bundle reference + anchor-jitter rule).
> - 3-agent adversarial review of V1 (CRDT / Svelte / annotation-model).
> - Primary-source check of `MarginFrame.svelte` (the C4 bundle) to verify endpoint semantics.
> **Order in Stage C envelope:** FIRST. Independent of C-1 / C-2.

## 0. What changed from V1

V1 proposed `MarginPositions.byId: ReadonlyMap<string, {top, anchorX}>` to make X/Y reads atomic. Three reviewers converged on rejecting this:

1. **`coordsAtPos(range.from).left` is glyph-X, not text-edge-X.** Per `MarginFrame.svelte:97` (the C4 bundle source), leader endpoints derive from `doc.getBoundingClientRect().right` — the text container's geometric right edge, NOT a per-anchor glyph position. So `anchorX` was always the wrong number.
2. **Adding `anchorX` to `mapsEqual` doubles per-frame re-render rate** (per-component 0.5px tolerance on independent jitter sources).
3. **Pure-function helpers can't be exported from `<script lang="ts">`** and imported by vitest — V1's test plan was un-runnable.

V2 drops `anchorX` entirely, matches the bundle's geometric column-X endpoints, extracts helpers to a sibling `.ts` file, and uses per-AUTHOR stroke color (also bundle-faithful, also reversing a cleave-locks lock).

Net: touch surface shrinks from V1's ~200 LOC / 3 core files to ~130 LOC / 2 core files. `useMarginPositions.svelte.ts` is completely untouched.

## 1. Goal

Replace today's straight-line `<line>` leaders (`MarginColumn.svelte:163-174`) with cubic-bezier `<path>` leaders matching the C4 bundle's `MarginFrame.svelte:151-156` shape, add per-bubble `<circle>` anchor dots at the text-edge endpoint, and color each leader+dot pair by the annotation's `author` field (per `MarginFrame.svelte:135-137`).

User-visible delta:
- Leader curves gently into the bubble title row instead of cutting across in a straight line.
- A small filled circle marks the text-edge endpoint.
- Import-authored annotations (`.docx` comments) render with a neutral `--tandem-fg-subtle` color instead of Claude's orange — distinguishable from Claude's own comments at a glance.

Non-goals (explicit C-1 / C-2 / Stage D scope):
- Mode continuum (`Mode: 'full' | 'narrow' | 'stub' | 'off'`).
- Density variants (clamp-until-active, stub-pill).
- Geometry constant table (`MARGIN_TRACK_GEOMETRY`).
- Animated track-width transitions (Stage D).
- Hook return-shape changes.

## 2. Touch surface (file:line evidence)

### 2.1 NEW: `src/client/panels/marginLeaderGeometry.ts`

Pure module. Sibling pattern matches `src/client/panels/marginCollision.ts`. Importable from both `.svelte` template and vitest.

```ts
/**
 * Cubic-bezier leader geometry for margin-view annotation connectors.
 *
 * Endpoints + control-point placement match `MarginFrame.svelte` from the C4
 * design bundle (`docs/design-system-impl/bundle/extracted/c4-margin-column/`):
 * horizontal tangents at both endpoints, control points offset 10px / 8px
 * inward from the endpoint columns. The result is a smooth "lays into" curve
 * even at large vertical deltas (collision-pushed bubbles).
 *
 * Endpoints are GEOMETRIC column-X — per side, the leader runs from the
 * text-track edge to the margin-column edge. NOT glyph-X. Anchor dot sits at
 * the bezier's text-edge endpoint and inherits the same X.
 */

export type LeaderSide = "left" | "right";

export interface LeaderEndpoints {
  /** SVG-local X at the text-edge endpoint (= dot center X). */
  readonly startX: number;
  /** SVG-local Y at the text-edge endpoint (= dot center Y = raw anchor top). */
  readonly startY: number;
  /** SVG-local X at the bubble-edge endpoint. */
  readonly endX: number;
  /** SVG-local Y at the bubble-edge endpoint (= bubble title row baseline). */
  readonly endY: number;
  /** Which side the bubble column sits on — flips control-point sign. */
  readonly side: LeaderSide;
}

/**
 * Build the SVG path `d` attribute for one bezier leader. Mirrors the bundle's
 * `M ax,ay C cx1,ay cx2,by bx,by` shape (MarginFrame.svelte:151-156).
 *
 * Control points sit 10px inward from startX and 8px inward from endX along
 * the X axis, sharing the endpoint Y. "Inward" flips with side: for a
 * right-side bubble, the leader runs left→right, so cx1 = startX + 10 and
 * cx2 = endX − 8. For a left-side bubble it's mirrored.
 *
 * All coordinate values are rounded to 1 decimal (`toFixed(1)`) — matching
 * the bundle, and stable across float-arithmetic jitter for snapshot tests.
 */
export function bezierLeaderPath(e: LeaderEndpoints): string {
  const inward = e.side === "right" ? 1 : -1;
  const cx1 = e.startX + 10 * inward;
  const cx2 = e.endX - 8 * inward;
  return (
    `M ${e.startX.toFixed(1)},${e.startY.toFixed(1)} ` +
    `C ${cx1.toFixed(1)},${e.startY.toFixed(1)} ` +
    `${cx2.toFixed(1)},${e.endY.toFixed(1)} ` +
    `${e.endX.toFixed(1)},${e.endY.toFixed(1)}`
  );
}

/**
 * Per-annotation stroke + dot color, keyed on annotation `author`. Matches
 * `MarginFrame.svelte:135-137`. Imports get the neutral fg-subtle tone so a
 * Word-comment-derived annotation reads distinct from a Claude comment at a
 * glance. The strings are CSS `color` values (CSS custom properties), used
 * directly on `stroke` / `fill` attributes.
 *
 * Exhaustiveness: the `assertNever` final branch breaks the build if
 * `Annotation.author` grows a fourth value — without this guard, a new
 * author silently buckets into fg-subtle (the import treatment), which is
 * the WRONG default for whatever the new value would mean.
 */
type AnnotationAuthor = "claude" | "user" | "import";

function assertNever(value: never): never {
  throw new Error(`unhandled annotation author: ${String(value)}`);
}

export function leaderColorForAuthor(author: AnnotationAuthor): string {
  switch (author) {
    case "claude":
      return "var(--tandem-author-claude)";
    case "user":
      return "var(--tandem-author-user)";
    case "import":
      return "var(--tandem-fg-subtle)";
    default:
      return assertNever(author);
  }
}
```

### 2.2 `src/client/panels/MarginColumn.svelte`

**Hook return shape unchanged.** `positions: ReadonlyMap<string, number>` continues to emit scalar Y offsets. No prop-type change.

**`leaderStyle` change.** Drop the `--tandem-author-{authorVar}` inheritance (line 71) — color is now per-element. Keep the rest of the inline-style (positioning, pointer-events, dims). `authorVar` and `editorX`/`columnX` `$derived` blocks (lines 67-72) collapse to just `editorX`/`columnX`:

```svelte
const editorX = $derived(side === "right" ? 0 : gap);
const columnX = $derived(side === "right" ? gap : 0);
const leaderStyle = $derived(
  `position: absolute; top: 0; bottom: 0; ${side}: ${edgeInset + width}px; ` +
  `width: ${gap}px; pointer-events: none;`,
);
```

**Import the new helpers:**

```ts
import { bezierLeaderPath, leaderColorForAuthor } from "./marginLeaderGeometry";
```

**SVG markup replacement** (lines 153-177):

```svelte
<svg data-testid="margin-leaders-{side}" aria-hidden="true" style={leaderStyle}>
  {#each placeable as ann (ann.id)}
    {@const rawTop = positions.get(ann.id)}
    {@const adjTopRaw = adjustedPositions.get(ann.id)}
    {#if rawTop !== undefined}
      {@const isActive = ann.id === activeAnnotationId}
      {@const adjTop = adjTopRaw ?? rawTop}
      {@const endY = adjTop + LEADER_BUBBLE_INSET_PX}
      {@const color = leaderColorForAuthor(ann.author)}
      {@const d = bezierLeaderPath({
        startX: editorX,
        startY: rawTop,
        endX: columnX,
        endY,
        side,
      })}
      <path
        data-annotation-id={ann.id}
        data-tandem-author={ann.author}
        d={d}
        stroke={color}
        stroke-width={isActive ? 1.8 : 1.1}
        stroke-opacity={isActive ? 0.82 : 0.38}
        stroke-linecap="round"
        fill="none"
      />
      <circle
        data-testid="margin-anchor-dot"
        data-annotation-id={ann.id}
        data-tandem-author={ann.author}
        cx={editorX}
        cy={rawTop}
        r={isActive ? 3 : 2}
        fill={color}
        fill-opacity={isActive ? 0.72 : 0.42}
      />
    {/if}
  {/each}
</svg>
```

Key fixes incorporated from the V1 review:
- `adjTop = adjTopRaw ?? rawTop` fallback handles the one-frame race where `placeable` updates before `adjustedPositions` `$derived.by` re-runs. Consistent with line 185's existing pattern.
- `data-tandem-author` on each `<path>` and `<circle>` for ADR-026 attribute-queryable authorship (annotation review F2).
- Per-element `stroke`/`fill` color resolved via the pure helper.

**`adjustedPositions` reads unchanged.** Lines 93-100 continue to read `positions.get(a.id) ?? 0` (scalar). No shape-change cascade through the collision sweep.

**Bubble-render reads unchanged.** Line 185's `{@const top = adjustedPositions.get(ann.id) ?? positions.get(ann.id) ?? 0}` survives as-is.

### 2.3 `useMarginPositions.svelte.ts`

**Untouched.** Hook return shape, `_computeNextPositionsForTesting`, `mapsEqual`, `createScheduler` — all preserved. The pre-existing layer-rect-precedes-loop atomicity bug (CRDT review HIGH-2) is filed as issue #918 to address separately; documenting it as preserved behavior, not regressed.

### 2.4 No App.svelte / docx-path changes

Same as V1: this PR only touches the non-docx `MarginColumn` render path.

## 3. Why per-author color instead of per-side (reversal of cleave-locks decision)

Cleave-locks doc locked per-side stroke color. Primary source (`MarginFrame.svelte:135-137`) is per-author: `claude` → claude token, `user` → user token, ELSE → `--tandem-fg-subtle`. Per `feedback_bundle_vs_production`: bundle-faithful for decoration; stroke color carries authorship information per ADR-026 → bundle-faithful is correct.

Cost of per-author over per-side: one extra attribute per SVG element (`data-tandem-author={ann.author}`, plus per-element `stroke`/`fill`). No structural complexity.

Benefit: Word-comment-derived annotations render as visually distinct from Claude comments (was the annotation review F3 "import gets Claude tone by silence" concern). Doesn't add a token — uses existing `--tandem-fg-subtle`.

## 4. Tests

### 4.1 NEW: `tests/client/marginLeaderGeometry.test.ts`

Pure-function unit tests. `bezierLeaderPath` + `leaderColorForAuthor` test cases use `it.each` with `why` column per `feedback_iteach_equivalence_classes`:

- **`leaderColorForAuthor` equivalence classes:** `claude` / `user` / `import` → respective CSS-var strings. Coverage of every value of `Annotation.author` (the `assertNever` branch is unreachable under TS — coverage proof is that all three cases exist).
- **`bezierLeaderPath` side flip:** right side → cp1.x > startX, cp2.x < endX; left side → cp1.x < startX, cp2.x > endX. Snapshot 4 endpoint shapes (small ΔY, large ΔY, ΔY = 0, negative ΔY for collision-up-pushed bubbles).
- **`bezierLeaderPath` rounding stability:** `(startX, startY, endX, endY) = (0.001, 0.001, 50.001, 100.001)` produces same `d` as the integer-equivalent input (verifies 1dp rounding eliminates float jitter).

### 4.1b NEW: `tests/client/MarginColumn.import-author.test.ts`

Integration: mount `MarginColumn` with a synthetic `author: "import"` annotation prop. Assert the rendered `<path>` and `<circle>` carry `data-tandem-author="import"` AND `stroke` resolves to `var(--tandem-fg-subtle)`. Closes the "no .docx fixture in welcome.md" gap from V1 §4.2 without requiring a docx pipeline mock. Tests the integration path that the pure-function `leaderColorForAuthor` test alone can't prove: that `ann.author` actually reaches the helper unmutated.

### 4.2 `tests/e2e/margin-view.spec.ts` (extends existing file)

- **Anchor dot count == bubble count per side.** Open `sample/welcome.md` with margin view on. Assert `[data-testid="margin-leaders-left"] [data-testid="margin-anchor-dot"]` count matches left placeable count; same for right. (Per-id selectors use `data-annotation-id`, NOT testid — note IDs aren't a queryable testid surface per ADR-027.)
- **Per-author color.** Assert one Claude comment's `<path stroke>` resolves to `var(--tandem-author-claude)`, one note's path resolves to `var(--tandem-author-user)`. (Imported annotation case: deferred — `sample/welcome.md` has no `.docx` import; cover in a future fixture or pure-function-only.)
- **`data-tandem-author` attribute exposed on path and circle** for both Claude- and user-authored placeables (ADR-026 attribute-queryable surface).

### 4.3 Visual baseline

Regenerate `tests/e2e/screenshots/margin-view-*.png` baselines, Linux-gated per `feedback_playwright_pixel_diff_platform_gating`. The bezier + dot change is the user-visible point of this PR — baseline update is the deliverable, not a regression.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Bezier control points at `±10` / `±8` look squashed for small `endX - startX` (narrow gap zone) | The gap zone is 24px today (Plan §5 `MARGIN_VIEW_GAP_PX`); `+10` and `-8` leave 6px of "straight" middle, well-shaped. C-1's narrower modes shrink the gap → if it gets <20px, control-point offsets need to scale. C-1 owns that; for C-3 (no mode change), it doesn't arise. |
| Anchor dot at `(editorX, rawTop)` could collide with bubble border when `placeable` includes a bubble whose `adjTop ≈ rawTop` (no collision push) | Dot sits at the TEXT-edge X (column 0 or `gap`), bubble starts at column-X + `edgeInset`. They're separated by `gap + edgeInset` minimum (24 + 8 = 32px today). Cannot collide. |
| Per-author color leaves `author === "user"` notes with the EXISTING `data-annotation-id` left-side surface unchanged | Today's `<line data-annotation-id={ann.id}>` already exposes per-note IDs as an attribute, but NOT as a testid. V2 originally proposed `data-testid="margin-anchor-dot-{ann.id}"` which WOULD have been a new privacy regression (testids are the documented, stable, queryable surface per CLAUDE.md). Fixed in V2 post-review: testid is non-id-bearing (`data-testid="margin-anchor-dot"`); per-id queries continue to use `data-annotation-id` for E2E selector continuity. Per-element `data-tandem-author="user"` adds zero new identity bits — only a per-author bucket, which LEFT-side placement already encodes. |
| Bundle-faithful `+10` / `-8` offsets are baked into a pure helper, hiding the dependency | Document the bundle source (`MarginFrame.svelte:151-156`) in the helper's JSDoc (done above). A future bundle update to those numbers requires editing one helper. |
| Pre-existing layer-rect atomicity bug (CRDT review HIGH-2) | Filed as issue #918. C-3 preserves the bug; documenting that the bezier curve doesn't make it worse than today's straight line (both render with the same Y values). |
| Snapshot test for `bezierLeaderPath` could drift on font-rendering changes | The helper is pure (no DOM, no fonts). Snapshot is over the `d` STRING, not over a rendered path. Stable across platforms. |
| Removing `--tandem-author-{authorVar}` from `leaderStyle` (line 71) silently regresses something that depends on the SVG root inheriting that color | Confirmed unused: `<line>` at line 169 uses `stroke="currentColor"` which only resolves through the inheritance — V2 replaces that with explicit per-element `stroke={color}`. No other consumer reads `style.color` on the SVG root. |

## 6. Verification gates

- `npm run typecheck` — catches any prop-shape drift.
- `npm test -- marginLeaderGeometry` — pure-function tests.
- `npx svelte-check src/client/panels/MarginColumn.svelte` — Svelte template type-check + `<style>` validity.
- `npm run test:e2e -- margin-view` — selector + computed-style assertions cross-platform; pixel-diff Linux-only.
- Manual dogfood: `npm run dev:standalone` from this worktree → `sample/welcome.md` with margin view on → bezier curves visible, anchor dots visible, Claude/user color distinction holds. If a `.docx` is convenient, verify import = fg-subtle.
- `npm run check:tokens` — confirm no raw hex slipped in.

## 7. Out of scope

- **`anchorX` glyph-position reads.** If a future stage needs per-glyph X (e.g. C-2 review-target highlight that points at the EXACT word), it extends `useMarginPositions` then. C-3 doesn't pay that complexity tax up front.
- **Anchor dot click-to-scroll.** SVG retains `pointer-events: none`. Bubble's existing `onClick` handles navigation.
- **A new `--tandem-author-import` token.** Use existing `--tandem-fg-subtle` (matches bundle). If a future product need wants a distinct import tone, add the token in that PR.
- **Animated path morphing on collision-resolve.** Stage D.
- **Issue #918's atomicity fix.** Filed; not blocking C-3.

## 8. PR description scaffolding

```
feat(margin-view): cubic-bezier leaders + per-author anchor dots (C-3)

Stage C-3 of Phase 3.5. See docs/plans/2026-05-28-stage-c-cleave-locks.md
and docs/plans/2026-05-28-stage-c3-bezier-leaders-anchor-dots.md (V2).

- Replaces straight `<line>` leaders with cubic-bezier `<path>` matching the
  C4 design bundle's shape.
- Adds `<circle>` anchor dots at the text-edge endpoint.
- Per-author stroke color (claude / user / fg-subtle) — `.docx` imports
  render distinct from Claude comments.
- `data-tandem-author` exposed on path + circle per ADR-026.

Pure visual upgrade: zero hook changes. `useMarginPositions` return shape
preserved. The original V1 plan's `anchorX` extension was reversed during
plan review (bundle endpoints are geometric column-X, not glyph-X) —
detail in the V2 plan §0.

Refs: #909, #918 (pre-existing atomicity bug to address separately).
```

## 9. Next steps

1. **One annotation-model re-review of V2** (per advisor: CRDT + Svelte findings collapsed with the scope cut, only annotation-model concerns remain load-bearing — testid privacy doc note, ADR-026 attribute, import-tone decision documented).
2. Reconcile any V2-specific findings.
3. Code.
4. `/pr-review-toolkit:review-pr` cycle.
