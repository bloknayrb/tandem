# #1123 M3 — Provider-keyed authorship (built dark)

**Status:** REVISED after 3-agent prose review (annotation-model / architecture-dark / crdt-decoration). Agent feedback incorporated — see "Plan-review corrections" below. Phase **M3** of the local-model collaborator (#1123, ADR-039). Stacks on M2b (`feat/1123-m2b-models-ui-mount`, PR #1221) → M2a (#1220). Branch: `feat/1123-m3-provider-authorship`. Ships **DARK** behind `BYO_MODELS_ENABLED` (literal `const false`) — runtime byte-identical while dark. Flag flips at **M4 (v1.0)**.

## Plan-review corrections (applied)

- **§0 factual fix — the loop writes NO authorship ranges.** `document.ts:256/593` (authorship-range stamping) are Claude-**via-MCP** paths (`tandem_open` / `tandem_edit`). The local-model loop's tool registry (`tools.ts:68-142`) is get_outline / read_section / comment_on_quote / propose_replacement / reply_to_annotation — it has **no direct-text-edit tool**; `propose_replacement` creates a *comment-with-`suggestedText`* annotation (`tools.ts:294-302`), not an edit. So the loop authors exactly three record kinds: **annotation (comment), reply, chat message** — and **zero** `AuthorshipRange`s. All three reviewers converged on this; it collapses the decoration debate (see below).
- **The identity source does not exist yet (High).** `LocalModelConfig` is `{endpoint, modelId, transport}` (`config.ts:17-24`); `resolveLocalModelConfig` READS `entry.provider`/`entry.displayName` (`config-source.ts:34`, both exist on `ModelsEntry`, `contract.ts:71-72`) but **discards** them (`:65-72`). M3 must extend the resolver's return to carry `{provider, displayName}`. Prerequisite, not assumed-done.
- **`sanitizeAnnotation` is an ALLOWLIST, not passthrough (the one load-bearing gap).** `sanitize.ts:90-111` copies only enumerated `AnnotationBase` fields; unlisted fields are **stripped on every read**, and client cards read sanitized records (`yjsSync.svelte.ts:202`, `annotation.ts:102`). `agentIdentity` is a **required allowlist add** — without it the byline fix silently no-ops on the client. (Persistence itself is safe: `AnnotationRecordSchemaV1` is `.passthrough()`, `schema.ts:124`.)
- **Threading needs two signature changes.** `DispatchCtx` (`tools.ts:40-45`, currently `{ydoc, isLicenseRestricted}`) must carry `agentIdentity`; `addReplyToAnnotation` (`annotations.ts:137`) builds the reply inline with no identity param → add an **optional** `agentIdentity` defaulted `undefined` so the MCP `tandem_annotationReply` caller stays byte-identical. `createAnnotation`'s `extras: Partial<Annotation>` (`annotations.ts:293`, spread last `:309`) carries it cleanly. `appendClaudeChatMessage` (`awareness.ts:55`) gains an optional identity param; `updateClaudeChatMessage` re-sets `{...existing, text}` so a streamed delta preserves it.
- **Decoration re-scoped — ALL per-agent color → M4 (see §4.4).** The loop authors no `AuthorshipRange`, so the inline authorship-underline/gutter path (`authorship.ts`) is moot for it. A local-model *comment* does render three annotation-`author`-keyed surfaces (card dot, comment-body underline `annotation.ts:155`, margin leader `marginLeaderGeometry.ts:81`), all Claude-orange today. Because the whole feature is **dark until M4**, none of these are user-visible before the flag flips, so there is **no shippable half-state** to avoid by landing color early. M4 already owns the AuthorshipRange decoration + the flag flip + final choreography; folding the annotation-color surfaces into M4 designs the per-`provider` palette + token set + all surfaces as **one coherent, reviewed unit** and avoids two token passes. **M3 = identity + byline core only.** (Engineering-sequencing call; identical dark outcome to landing colors in M3. Reversible — flag Bryan if he wants the annotation colors in M3.)
- **Privacy note added (§5):** when a user accepts/dismisses a local-model annotation, the notification routes to whatever agent is on the channel / MCP inbox (real Claude), not the local model — a cross-identity wrinkle, **not** an ADR-027 violation, moot while dark; M4 concern.

---

## 1. The gap & the dark guarantee

**Gap.** The loop stamps its annotation/reply/chat writes `author:"claude"` (via `createAnnotation`/`addReplyToAnnotation`/`appendClaudeChatMessage`) — identical to real Claude. And the byline doesn't even read the record: `getAuthorLabel` (`annotation-card-helpers.ts:10-13`) and the chat byline (`ChatPanel.svelte:226`) resolve the agent name from `agentLabelSource()` — the user's **active/default** model — so an annotation already shows whatever model is currently default, not the one that wrote it (confirmed by all three reviewers). M3 carries the authoring agent's identity **on the record** so the byline reflects it.

**Dark guarantee (every commit).** With `BYO_MODELS_ENABLED=false` the loop never runs → no record ever gets an `agentIdentity`. The field is optional; every read-path change falls back to today's exact output when it is absent (which is always, while dark, and for all pre-M3 + all real-Claude records). Verify per commit: absent-field byline is byte-identical; `check:tokens` + `typecheck` + `svelte-check` clean; existing suites green.

## 2. Design decision (SETTLED — Option B)

Keep `author:"claude"` as the **agent-role** marker (all privacy/channel/gating semantics unchanged — a local model IS an agent for gating). Add an optional identity the writer stamps:

```
// shared/types.ts
export interface AgentIdentity { provider: ModelProvider; displayName: string }
// on AnnotationBase, AnnotationReply, ChatMessage:
agentIdentity?: AgentIdentity;
```

Add a code comment at the `author` type: **`"claude"` = agent-role, not literally Claude — the specific agent is `agentIdentity` when present.** Option B advantages the reviewers confirmed: zero union churn → zero compile break, zero privacy-gate reasoning (every `author` branch behaves exactly as today), **leaves the `assertNever` switch untouched** (`marginLeaderGeometry.ts:65-67`), backward-compatible (absent ⇒ today's `agentLabelSource()` fallback), and dark-safe by construction (only the flag-gated loop ever sets it). Option A (new `author` variant) rejected: ~20 role-branch sites incl. ADR-027 privacy (`mode.ts:83`, observers), the `assertNever` switch, three narrow unions — high blast radius + privacy-misbucket risk, and it still wouldn't say *which* model.

Identity shape `{provider, displayName}` (not a registry `modelId` ref): records persist on disk and outlive the user-mutable registry — a ref would dangle on edit/delete; a self-contained snapshot also correctly **freezes who authored this at the time**.

## 3. Scope (SETTLED)

- **M3 (this plan) = identity + byline core.** Data model + config-identity plumbing + loop write-site stamping + byline read resolution. Fully additive, anchoring-orthogonal, dark-safe.
- **M4 = all per-agent decoration color**, as one coherent unit: annotation card dot (`AnnotationCardHeader.svelte:39`), comment-body underline (`annotation.ts:155`), margin leader (`marginLeaderGeometry.ts:81` / `MarginColumn.svelte:272`), AND the AuthorshipRange underline/gutter (`authorship.ts` — loop writes none, pure M4). Keyed on the bounded `agentIdentity.provider` enum (NOT free-text `displayName`), via a new `data-tandem-agent` attribute + per-provider `--tandem-agent-*` tokens; the binary `author` gate at `authorship.ts:59` and `leaderColorForAuthor` stay untouched (color threads at the call sites). Plus the M4 notification-routing wrinkle (§5).

## 4. Changes (M3-core)

### 4.1 Type + schema + sanitize (`src/shared/`, `src/server/annotations/`)
- `types.ts`: define `AgentIdentity` (import `ModelProvider` from `shared/models/contract.ts`); add optional `agentIdentity?` to `AnnotationBase` (:109), `AnnotationReply` (:67), `ChatMessage` (:401). Add the `author`-is-role comment.
- `annotations/schema.ts`: add `agentIdentity: z.object({ provider: <the models provider enum>, displayName: z.string().max(120) }).optional()` to the annotation record (:106/:124 area) AND the reply record (:141) so it survives the durable round-trip + LWW `rev` merge (`types.ts:129`). Reuse the provider enum from the models contract (single source).
- **`sanitize.ts` — REQUIRED allowlist add:** add `agentIdentity` to the `base` allowlist (`:90-111`) via a conditional spread of the absent field (dark-safe: adds nothing when absent). Verify the reply object's stored/read path carries it too. (Chat is read raw from the Y.Map — NOT allowlist-sanitized — so no chat strip hazard.)

### 4.2 Identity source + threading (`src/server/local-model/`, `src/server/mcp/`)
- **Extend the resolver:** `resolveLocalModelConfig` (`config-source.ts`) builds a prebuilt `agentIdentity: AgentIdentity` ONCE and carries it on `LocalModelConfig` (replacing the flat `provider`/`displayName` the resolver previously read and discarded). Both write paths read `config.agentIdentity` whole — no re-bundling, no per-dispatch allocation (post-`/simplify` altitude fix).
- **Thread it:** `collaborator.ts` puts `agentIdentity` into `DispatchCtx` (`tools.ts:40-45`) for the loop turn; `annotateFromQuote`/`createAnnotation` pass it via `extras`; `addReplyToAnnotation` gains an optional `agentIdentity` param (defaulted `undefined`); chat via a new optional `appendClaudeChatMessage(..., agentIdentity)` param threaded from `collaborator.ts:145/150`.
- **Real Claude-via-MCP writes leave `agentIdentity` undefined** (the MCP tools don't set it) → today's behavior preserved. Origin/self-wake unchanged (guards are origin-based `shouldSkipChannel`, not identity).

### 4.3 Byline read resolution (`src/client/`)
- `annotation-card-helpers.ts:10-13` `getAuthorLabel(author, agentLabel, agentIdentity?)`: `author==="claude"` AND `agentIdentity` present → `agentIdentity.displayName`; else today's `agentLabel.family`. Update the one call site (`AnnotationCardHeader.svelte:34`).
- `ChatPanel.svelte:226`: per-message byline — `msg.agentIdentity?.displayName ?? agentLabel.family` when `author==="claude"`.
- `annotation.ts:69-71` aria-label: same fallback (thread `agentIdentity` into the decoration read).
- No other label site changes; absent identity = byte-identical today.

## 5. Privacy invariants (ADR-027 — confirmed by review, must not regress)
- Keeping `author:"claude"` preserves every privacy gate (agent can't write into note threads `annotations.ts:170`; note defense-in-depth `observers/annotations.ts:94`; Solo hold keys on `author==="user"` `mode.ts:83` and the loop self-holds in Solo `collaborator.ts:301`; note filters key on `type` not author). `agentIdentity` rides only on already-agent-authored records; never on a user note/comment; contains NO secret (provider enum + user-chosen displayName; never endpoint/apiKeyRef).
- **Acknowledged disclosure:** `tandem_exportAnnotations` spreads `...ann` (`annotations.ts:714`), so `agentIdentity` appears in the exported sidecar/MCP result — acceptable (non-secret; notes are filtered out first at `:706`).
- **M4 note (not M3):** accept/dismiss notifications for a local-model annotation route to whatever agent is on the channel/inbox (real Claude), not the local model — cross-identity wrinkle, not a privacy break, moot while dark.

## 6. Testing
- **Type/schema round-trip:** `agentIdentity` survives Zod (present + absent) and the durable `.passthrough()` + LWW `rev` merge; a record without it validates (backward-compat).
- **Sanitize allowlist:** a sanitized annotation with `agentIdentity` set RETAINS it (regression guard for the load-bearing gap); absent stays absent.
- **Byline:** `getAuthorLabel` returns `agentIdentity.displayName` when present, the active `agentLabel.family` when absent (today path); chat byline the same.
- **Config identity:** the resolver surfaces `{provider, displayName}` from the registry default entry; the loop stamps it onto its three write kinds.
- **Dark guarantee:** an `agentIdentity`-absent fixture renders byte-identical byline to pre-M3; the loop only stamps identity when a local config resolves.
- **Privacy:** `agentIdentity` never attaches to a user note; the sanitize note-boundary is unaffected.
- Full client + server suites green; typecheck + svelte-check + tokens clean.

## 7. Decisions (all SETTLED by review)
1. Option A vs B → **B** (additive field; unanimous).
2. Scope → **M3 = byline/identity core; all per-agent color → M4** (dark ⇒ no shippable half-state; consolidates decoration). Reversible product call.
3. Identity shape → **`{provider, displayName}`** (unanimous).
4. Chat per-message identity → **add to `ChatMessage`** (unanimous; chat unsanitized so no strip hazard).

## 8. Out of scope (M4)
Flip `BYO_MODELS_ENABLED`; ALL per-agent decoration color (card/underline/leader/AuthorshipRange, per-`provider` palette + tokens); accept/dismiss notification routing to the authoring agent; final choreography/copy; chip loading-gate; E2E vs a stub OpenAI-compatible server; any `author:"claude"`→`"agent"` generalization.
