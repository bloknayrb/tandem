# 1123 M4 — Finish the local-model dark mechanism

**Status:** dark mechanism IMPLEMENTED (unmerged, Bryan-gated) · **Agent feedback incorporated** (4 adversarial plan reviews: design / dark-safety / scope / test — 2026-07-22) · **Branch:** `feat/1123-m4-dark-mechanism` off M3 head (`fc179b1`, PR #1222) · stacks M2a #1220 ← M2b #1221 ← M3 #1222 ← **M4**.

**What shipped in this PR (all dark, byte-identical):** `agentColor()` per-provider token helper + 4 new `--tandem-agent-*` tokens; per-agent color on card dot / comment underline / margin leader / reply byline / chat author / peek dot; chip loading-gate (extracted `resolveDefaultModelChip`); first-run picker decoupled from the tutorial + persisted dismissal (extracted `resolveModelFirstRunNeeded`); (d) AuthorshipRange-zero tripwire; skip-guarded E2E. **What remains for M4-true-completion (out of this PR):** the `BYO_MODELS_ENABLED` flag flip (Bryan's v1.0 call) and the two documented flip-time deliverables — accept/dismiss per-agent routing/delivery and the E2E stub-server loop harness. CLAUDE.md Status + the `annotation-author-dot-{id}` testid-registry line are deferred to merge (the working tree carries an unrelated uncommitted DS edit to CLAUDE.md).

## The guarantee (unchanged from M1a–M3)

The track ships **DARK** behind `BYO_MODELS_ENABLED` — a hard literal `const false` at `src/shared/constants.ts:18`, **no env/define/function seam** (a client-bundled `define` read crashes the vite bundle; rejected in M2b). The flag flips **only** at v1.0, and that flip is **explicitly Bryan's launch call (ADR-039)** — **out of scope** for this or any autonomous PR.

Every change is **runtime byte-identical while dark.** The mechanism activates only when a record carries `agentIdentity` (the optional `{provider, displayName}` snapshot from M3), set **solely by the flag-gated collaborator loop** — so when dark, no record carries it and every new branch falls through to the exact current color/behavior. Verified airtight at the data level by the dark-safety + scope reviews: `agentIdentity` is set only at the loop's `dispatch`/chat writes, always on `author:"claude"` `type:"comment"`/reply/chat records, never on a note; `sanitizeAnnotation` only passes it through, never adds it.

**M4's target:** implement the remaining dark mechanism so the *only* step left for v1.0 is flipping the one const.

## Color design — per-`provider` CSS tokens (revised per design review)

`provider` is a **closed 5-enum** (`src/shared/models/contract.ts:35`: `anthropic | openai | gemini | local-ollama | local-llamacpp`), so per-agent color keys on it via **CSS tokens**, not a hashed inline color. This dissolves three problems the hashed approach had: theme adaptation is free (tokens carry light/dark values like `--tandem-author-*`, which lift ~+0.09 L for dark — they are *not* single-color), the token lint is sidestepped, and it's rename-stable (`agentIdentity` is a frozen snapshot, so hashing the editable `displayName` would repaint one agent across a rename). Same-provider collision is a non-issue: the M3 byline already distinguishes agents textually and the loop is single-stream (ADR-039).

`src/client/utils/agent-color.ts`:
```ts
import type { AgentIdentity, ModelProvider } from "../../shared/types.js";
const AGENT_COLOR_VARS: Record<ModelProvider, string> = {
  anthropic: "var(--tandem-author-claude)",   // Claude family → existing coral (reuse, no new token)
  openai: "var(--tandem-agent-openai)",
  gemini: "var(--tandem-agent-gemini)",
  "local-ollama": "var(--tandem-agent-local-ollama)",
  "local-llamacpp": "var(--tandem-agent-local-llamacpp)",
};
export function agentColor(identity?: AgentIdentity): string {
  if (!identity) return "var(--tandem-author-claude)"; // exact current literal ⇒ byte-identical dark
  return AGENT_COLOR_VARS[identity.provider] ?? "var(--tandem-author-claude)";
}
```
New tokens `--tandem-agent-{openai,gemini,local-ollama,local-llamacpp}` in `index.html` `:root` + `[data-theme="dark"]` blocks, hand-tuned like `--tandem-author-claude` (distinct hues; local-* tuned clearly apart from the coral so a local agent reads as visually distinct from Claude-via-MCP). Only `local-*` are exercised by the loop today (cloud BYO is v1.1); the full 5-entry map is cheap and bounded.

## Scope — decided, with rationale

### IN — per-agent decoration/name color on the reachable surfaces
All gate `agentColor` **inside the existing `claude` branch**; `identity === undefined` → exact `var(--tandem-author-claude)` ⇒ byte-identical dark. Tests assert the **full** emitted style string/DOM equals today (not just the color token — the underline interpolates the token mid-string).

- **(a) Card dot** — `AnnotationCardHeader.svelte:40-42` `dotColor` `$derived`, claude branch → `agentColor(annotation.agentIdentity)`. **Prereq:** the dot span (~:91) has no stable selector — add a `data-testid` so a render test can read its `style`.
- **(b) Comment underline** — `annotation.ts:159` (plain-comment claude branch; `ann.agentIdentity` already in scope at :166). Swap the token in the inline `style`.
- **(c) Margin leader** — `marginLeaderGeometry.ts` `leaderColorForAuthor` + `MarginColumn.svelte:272`. Add a **required** `agentIdentity: AgentIdentity | undefined` param (required so a call site passing only `author` fails typecheck — converts a silent regression to a compile error), claude branch → `agentColor`.
- **(e) Reply byline color** — `CommentThread.svelte` `.ct-author.is-claude` / `.ct-author-dot--claude` (~:84-102). Replies carry `agentIdentity` and the name already renders (M3); convert the class-driven claude color to an inline `agentColor(reply.agentIdentity)` so color follows the name.
- **(f) Chat author color** — `ChatPanel.svelte` (~:269,:274). Chat carries `agentIdentity`, name renders (M3); same class→inline treatment.
- **(g) Peek-strip dot** — `PeekStrip.svelte:169-170` `.peek-dot.claude`, **if** a trivial dot recolor; assess at implementation — document-exclude if it needs disproportionate restructuring.

### EXCLUDED — with concrete rationale (documented so un-excluding can't silently ship a hole)
- **(d) AuthorshipRange per-agent color — unreachable, not deferred.** The loop's dispatch (`tools.ts:289-344`) is reads + `comment_on_quote` + `propose_replacement` + `reply_to_annotation`; it **never writes document body text** (grep `authorship` in `src/server/local-model/` = zero). `propose_replacement` is a *comment carrying `suggestedText`*, not body text; when a human accepts it, `applySuggestion` attributes the inserted text `author:"user"` (`useAnnotationReview.svelte.ts` → `authorship.ts:276`), and the server resolve path is a pure status flip. So the loop emits **zero** `AuthorshipRange` entries. `AuthorshipRange` also carries only `author:"user"|"claude"` (no `agentIdentity`) and is CSS-attribute-driven → coloring needs a durable-schema addition + CSS→inline conversion for a path with no data. **Tripwire test** (`tools.test.ts`): assert the dispatch tool set writes no `AuthorshipRange`, so adding a body-edit tool later breaks a test pointing here.
- **Suggestion underline stays violet** — a claude comment *with* `suggestedText` renders the `--tandem-suggestion` violet branch (`annotation.ts:144-154`), author-agnostic **by design** (M3's byline didn't touch it either). So an agent's `propose_replacement` shows an agent-colored card dot but a violet underline — intentional, not an oversight.
- **Claude focus-paragraph gutter** (`--tandem-claude-focus-bg`) — unreachable: the loop never sets typing-presence/focus awareness (`withTypingPresence` is MCP-only; the collaborator writes only the CTRL_ROOM chat map). Same class as (d); revisit only if the loop ever sets focus presence.

### DEFERRED to flip-time (documented obligations, NOT built now)
- **Accept/dismiss routing to the authoring agent — dropped from M4.** Two reviews showed this is unbuildable-with-meaning dark: the collaborator subscription **ignores accept/dismiss entirely** (`collaborator.ts:298-310` — it wakes only on `chat:message`), ADR-039 is **single-agent** so "route to *the* authoring agent" has no multi-agent target, and the on-accept behavior is undefined. The earlier plan's "add a `provider` payload now to avoid a later wire change" justification is **wrong** — the accept/dismiss event is a *transient* channel event (not durable, not a versioned wire schema), so adding a meta field at flip costs nothing (consumers ignore unknown keys, no migration). Building it now is speculative surface with zero consumer. **Left as a named flip-time deliverable**, treated exactly like (d)'s "revisit" discipline. `formatEventContent`/`formatEventMeta` stay untouched this PR.
- **E2E stub-server loop harness** — the M4 E2E (below) is a skip-guarded skeleton that, even at flip, only covers the byline/color *rendering* path against injected records. Standing up a stub OpenAI-compatible server to drive the loop end-to-end (a real model turn → annotation) remains a **flip-time deliverable**; named here so it isn't silently assumed done.

### OUT — the flag flip. Bryan's v1.0 call.

### IN — titlebar chip loading-gate
`defaultModelLabel` (`App.svelte:656-661`) ignores `models.loading` → empty→label pop on a lit boot (Settings→Models already gates on loading; the chip is the asymmetric gap). **Extract** the derivation to a pure `resolveDefaultModelChip({ defaultModelId, models, loading })` returning `null` while `loading` — inline-in-App is untestable, and extraction lets a unit test prove the pop is gone. Keep the `BYO_MODELS_ENABLED ? … : null` prop wrapper (`App.svelte:1881`) so dark stays `null`.

### IN — first-run choreography decouple
`shouldShowModelPicker` (`App.svelte:1849-1866`) borrows `tutorial.tutorialActive`, giving two edges: a no/completed-tutorial user never sees the picker; a tutorial replay re-summons it (session-scoped `modelPickerDismissed`). Check whether `useFirstRunNeeded.svelte.ts` (exists, unit-tested) already models this and **wire the picker to it** / extend it; the new signal takes explicit `{ byoEnabled, hasConfiguredDefault, dismissed }` and has **no tutorial input** (the structural proof of decoupling). **`BYO_MODELS_ENABLED &&` must stay the leading short-circuit conjunct.** Persist `dismissed` if edge (b) requires it survive a replay.

## Steps (granular commits, one M4 PR on #1222)

1. `index.html` agent tokens + `agent-color.ts` + `tests/client/agent-color.test.ts`.
2. (a) card dot + `data-testid` + `tests/client/annotation-card-header.test.ts`.
3. (b) comment underline + extend `tests/client/annotation-decoration.test.ts` (full-string assertion).
4. (c) margin leader (required param) + extend `tests/client/marginLeaderGeometry.test.ts` (`it.each`: claude+identity distinct; claude+undefined == today; user/import ignore identity).
5. (e) reply color + (f) chat color + (g) peek dot [if trivial] + tests (`reply-thread.test.ts`, chat/peek render tests).
6. Chip gate: extract `resolveDefaultModelChip` + wire App/TitleBar + test (loading→null; loaded→label; no-default→null).
7. First-run decouple: wire/extend `useFirstRunNeeded`; two **separate** edge tests (no-tutorial-user sees; replay doesn't re-summon).
8. (d) tripwire test (zero AuthorshipRange from dispatch) in `tools.test.ts`.
9. E2E skip-guarded spec (`tests/e2e/agent-identity.spec.ts`) — selectors must resolve against current markup (grep testids); body asserts the *lit* behavior (agent byline + agent-distinct decoration color vs a real-Claude annotation in the same doc).
10. Docs: CLAUDE.md Status + roadmap/ADR-039 note (mechanism complete; only the flag flip + the two named flip-time deliverables remain) + this plan → done.

## Test non-negotiables (from test review — the M3 "delete a line, suite stays green" trap)

- **Every wiring site needs a LIT assertion** (identity present → NOT `var(--tandem-author-claude)`), not just the helper's unit test — a dark-only test passes even if the site is never wired.
- **agentColor:** `expect(agentColor(undefined)).toBe("var(--tandem-author-claude)")` (exact literal — the byte-identical gate in miniature) + a pinned `(provider) → exact token` vector (guards silent map drift; self-comparison misses it).
- **Full style string** asserted at (b) (mid-string interpolation).
- **Required leader param** (step 4) is itself a compile-time guard on the call site.
- **Chip + first-run** tested via the extracted pure helpers (inline-in-App is unreachable); first-run edges are **two separate** cases.
- **(d) tripwire** as above.

## Verify

`npm run typecheck`, svelte-check (edited `.svelte`), biome, `npm run check:tokens` (tokens/`var()` pass — no raw hex/rgba), client + server unit suites, E2E spec compiles + selectors resolve. Each color/gate/first-run test asserts the dark fallback equals today.

## Invariants / risks

- **Byte-identical dark** is the gate: assert the fallback, not just the lit path.
- **No new durable schema, no CRDT/origin/Y.Map change** (dark-safety review confirmed): decoration edits are pure render derivations; `agentIdentity` already lives on records (M3); AuthorshipRange untouched; accept/dismiss event untouched (deferred).
- **Token lint**: `agentColor` emits `var(--tandem-*)` only.
- **Stack depth 4** (M2a←M2b←M3←M4), all Bryan-gated, merge in order; rebase M4 if M3 changes.
