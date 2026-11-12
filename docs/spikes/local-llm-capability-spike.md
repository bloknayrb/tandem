# Local-LLM Capability Spike (#1123 M0)

> **Status: COMPLETE.** Full-collaborator batch (306 trials) + FALLBACK batch (216 single-shot trials + lenient re-score + bounded-retry confirmation) run and scored. **Verdict:** no model clears the autonomous bar, but the capability **ships as an opt-in / experimental BYO-model feature** (chat default-on, editing opt-in, ≥14B recommended) because Tandem's human-in-the-loop accept/reject review is the safety net. Tables + decision below are final. Kill date 2026-07-02 — closed ahead of it.

> **2026-11-12: the instrument was rebuilt, and the numbers below are history.** The tables in this document were measured in June 2026 on prompts, a tool list and a loop that no longer ship. They are not evidence for switching local models on. See [The instrument, rebuilt (2026-11-12)](#the-instrument-rebuilt-2026-11-12) for what changed and where new results will go. ADR-039's 2026-11-12 amendment holds the pass rule.

## Goal

Decide whether a **local** LLM (via Ollama, OpenAI-compatible endpoint) can act as a *full collaborator* in Tandem — read the document, comment on quoted spans, propose replacements, and chat — through a tool-use loop, well enough to ship in v1.0 (ADR-039). Output: a GO / FALLBACK / NO-GO verdict with evidence, plus the resolved ADR-039 design decisions.

**Bar (binding, from #1123/ADR-039):** ≥80% task success over ≥20 trials/model, scored per operation (comment, replacement, chat) AND per multi-step sequence (read→decide→act→verify), with ≥1 trial set at the 50-page envelope. Tool schema uses **quote anchors (quoted_text + occurrence_index), never raw offsets**. FALLBACK (constrained structured-output) gets its own measured bar.

**Hardware (GO floor):** measured on the CPU-only dev box (Intel i7-1185G7, 31.7 GB RAM, no discrete GPU). Capability is hardware-independent and gates; latency is reported separately and does not gate. GO names the smallest ladder model clearing the bar.

## Harness (`probe/local-model-spike/`) — as it was in June

> The files in this table were the June harness. Its own copies of the client, tools, loop and prompts (`ollama.ts`, `tools.ts`, `loop.ts`, `prompts.ts`), its runners and reports (`batch.ts`, `report.ts`, `scoring.ts`, `smoke.ts`) and the forced-call runners were removed or replaced on 2026-11-12; `scenarios.ts` is now `harness/scenarios/june.ts`, and the June system prompt is kept frozen at `june-2026/prompts.ts`. The current files are listed in the 2026-11-12 section.

Throwaway; lives outside `tsup`/`vite`/`tsconfig` so it never touches the production build or `npm run typecheck`. Run with `npx tsx`. **Confirms the leading ADR-039 architecture hypothesis: a server-side loop calling the same internal operations the MCP tools wrap, NOT a spawned MCP client — and it needs no running server and no `src/` changes.**

| File | Role |
|---|---|
| `smoke.ts` | Phase A0 import gate — proves the standalone script can import the real internal ops |
| `ollama.ts` | Chat client; OpenAI-compat `/v1` with native `/api/chat` fallback (transport is a flag) |
| `tools.ts` | Quote-anchored tool registry (`get_outline`, `read_section`, `comment_on_quote`, `propose_replacement`, `reply_to_annotation`) + dispatch |
| `prompts.ts` | Locked system prompt; short fixtures inlined, windowed reading for the envelope |
| `loop.ts` | Turn loop, budgets, per-run metrics (tool calls, JSON-parse failures, anchor failures, flat-only anchors, wall time) |
| `scenarios.ts` | Self-grading scenario bank (51 scenarios) |
| `scoring.ts` | Deterministic scorer + Wilson CI |
| `batch.ts` | Resumable JSONL runner + fail-fast gold-anchor validation |
| `report.ts` | Aggregation + verdict decision tree |
| `generate-envelope.ts` | Generates the ~54-page envelope fixture |

**Reuse, not reinvention:** `findOccurrence` (`navigation.ts:59`) already implements the exact quote→range contract AND doubles as the scoring oracle (model output and gold span resolved by identical code — eliminates the false-NO-GO from offset arithmetic). "Replacement" is a comment carrying `suggestedText` (`createAnnotation`, `annotations.ts:274`), so no `tandem_edit` extraction was needed.

## Methodology

- **Scenario bank:** 12 comment + 12 replacement + 12 chat (across 3 medium fixtures), 3 no-op-discipline, 6 read→decide→act→verify sequences, 6 envelope. Each is a self-grading record (gold anchor + content/replacement predicates). Run × 2 seeds (temp 0.0 / 0.4) → ≥20 trials/op; seed 2 is a flakiness probe. Stratified by target location, occurrence-index disambiguation, quote length, instruction phrasing, distractors.
- **Span scoring:** character IoU via `findOccurrence`; ≥0.5 (comments) / ≥0.6 (replacements) against gold or any acceptable anchor. Raw IoU logged.
- **Content:** per-scenario semantic-family keyword predicates (broad, not exact-word) + min length.
- **Replacement:** non-degenerate (≠ original) + per-scenario instruction predicate (regex / length ratio).
- **Chat:** deterministic gates only for now (min length, must-cite keywords, no spurious annotations). *The blind Claude judge + Claude-as-control calibration the plan specifies are DEFERRED (decision 2026-06-16): chat reported on the deterministic floor; the Anthropic-API judge/control to be wired before the verdict is finalized if chat is close to the bar.*
- **Envelope:** separate, mandatory gating column — never blended into medium rates (blending manufactures a false GO). Windowed reading (`get_outline` → `read_section`); targets seeded at controlled depths in topically-aligned sections; cross-section budget contradiction; a repeated phrase across distant sections for occurrence-at-scale.
- **Aggregation:** per (model, op) pass rate with 95% Wilson CI; op clears iff rate ≥ 0.80 AND Wilson lower bound ≥ 0.70 (guards a noisy small-n 80%). Per-model GO requires every op + sequence + envelope to clear.

## Preliminary findings (validation slices — NOT the verdict)

- **Architecture validated:** standalone import of the real ops resolves clean; offsets align end-to-end; `pushNotification` is a harmless in-memory no-op. No `src/` changes.
- **Models:** qwen2.5:7b-instruct, llama3.1:8b, qwen2.5:14b-instruct pulled. Tool-call gate over `/v1` passed for qwen7b + llama8b (14b pending re-test).
- **Prompt matters a lot:** untuned, qwen7b paraphrased the user instruction instead of quoting the document → ANCHOR_NOT_FOUND, then gave up. Tuned prompt (inline short docs; hammer verbatim-quote + retry-on-ANCHOR_NOT_FOUND) flipped it to clean success on medium scenarios.
- **Scorer calibration caught a false-negative** (a too-narrow keyword list failed a correct "discrepancy" comment) — fixed to semantic-family keywords. See lesson; this is exactly the false-NO-GO the issue warns about, found in the scorer.
- **Envelope is the likely 7B blocker:** on the 54-page fixture with fair (topically-aligned) placement and natural headings, qwen7b navigated via outline/section reads but **failed deep retrieval** — it checked the wrong sections and gave up rather than reaching the obvious one. Since the envelope is a mandatory gating column, this likely blocks a full 7B GO regardless of medium scores. (To be confirmed across trials.)
- **Latency (informational):** qwen7b ~25–50s/medium trial, llama8b ~115s, envelope multi-turn ~150–200s; 14b slower. Full batch is a multi-hour CPU background job.

## Results — full-collaborator bar (306 trials)

Bar: pass rate ≥ 0.80 AND Wilson 95% lower bound ≥ 0.70, per op. Envelope is a separate mandatory gating column (never blended into medium rates). `report.ts` over `spike-1123-trials.jsonl`.

| Model | comment | replacement | chat | no-op (n=6) | sequence | **envelope** |
|---|---|---|---|---|---|---|
| qwen2.5:7b-instruct | ❌ 58% | ✅ 92% | ✅ 100% | ❌ 100%¹ | ❌ 50% | ❌ 50% |
| llama3.1:8b | ✅ 92% | ✅ 92% | ❌ 63% | ❌ 33% | ❌ 33% | ❌ **0%** |
| qwen2.5:14b-instruct | ❌ 79% | ✅ 92% | ✅ 100% | ❌ 100%¹ | ❌ 50% | ❌ 42% |

¹ no-op scored 6/6 but n=6 cannot clear the Wilson lower-bound floor; reported honestly as not-cleared rather than padded.

**No model clears the full-collaborator bar.** The wall is the *agentic* columns: multi-step **sequences** (≤50% every model) and **50-page deep retrieval** (≤50%; llama8b 0%). llama8b additionally fails action discipline (spurious annotations during chat/no-op → EXTRA_ACTION). Core single-shot capability is strong — replacement ≥92% across the board, chat 100% for both qwen models — but autonomous planning, deep navigation, and act/no-act judgment are not there at 7B–14B on this setup. Failure-mode histogram: NO_ACTION 25, OFF_TOPIC 18, WRONG_LOCATION 17, EXTRA_ACTION 13, WRONG_SPAN 6, NO_VERIFY 2.

## Results — FALLBACK bar (constrained single-shot, 216 trials)

FALLBACK = one forced structured-output call, no loop (sequence/no-op/envelope excluded by definition). Same scorer, same Wilson gate. Three measurement columns, increasingly generous, to bracket the answer and guard against a **false NO-GO** (the issue warns about both directions):

- **strict** — exactly one forced call, no retry (`spike-1123-fallback.jsonl`).
- **+lenient** — the product resolver applied to the *model's* anchor only (gold stays strict): markdown-unescape, and occurrence-clamp **gated on `matchCount === 1`** (a redundant occurrence_index is information-free on a unique quote; the gate makes mis-anchoring structurally impossible). The *optimistic upper bound* on anchor-artifact rescue.
- **+retry1** — one bounded re-emit fired **only** on a structured `ANCHOR_NOT_FOUND`/`HEADING_OVERLAP` (a deterministic anchor-repair protocol, not a content re-roll — still FALLBACK).

| Model | op | strict | +lenient | +retry1 | best clears 80%+Wilson |
|---|---|---|---|---|---|
| qwen2.5:7b-instruct | comment | 83% | 83% | **92%** | ✅ (retry) |
| qwen2.5:7b-instruct | replacement | 54% | 79% | 79% | ❌ |
| qwen2.5:7b-instruct | chat | 100% | 100% | 100% | ✅ |
| llama3.1:8b | comment | 71% | 83% | 79% | ❌ (lo 64%) |
| llama3.1:8b | replacement | 75% | 88% | 71% | ❌ (lo 69%) |
| llama3.1:8b | chat | 100% | 100% | 100% | ✅ |
| qwen2.5:14b-instruct | comment | 79% | 79% | 79% | ❌ |
| qwen2.5:14b-instruct | replacement | 88% | 88% | **92%** | ✅ (retry) |
| qwen2.5:14b-instruct | chat | 100% | 100% | 100% | ✅ |

The three columns bracket the answer rather than cherry-pick: strict is the floor, +lenient the optimistic ceiling on anchor-artifact rescue, +retry1 the realistic "model self-corrects once" middle. **Chat clears for every model. Comment clears for qwen7b; replacement clears for qwen14b — but no single model clears all three at once, and the marginal ops sit right at the Wilson floor.** Capability is clearly *present and uneven*, not absent. Note params predict imperfectly: llama3.1:**8B** trails qwen2.5:**7B** on comments — architecture/tool-training dominates raw size at this scale, so a parameter floor is a rough heuristic, not a guarantee.

**Diagnosis (false-NO-GO investigation, adversarially reviewed).** Strict single-shot replacement (54–88%) was *worse* than the agentic loop (92%), which is a red flag for a measurement artifact. Of 36 strict FALLBACK failures: **15 are anchor artifacts** (the model emitted the verbatim-correct quote AND the correct edit but a redundant `occurrence_index > 1` on a quote appearing exactly once — mechanically verified `matchCount === 1` — plus one markdown-escaped `\$`), **3 are no-tool-call** despite forced `tool_choice` (a reliability floor — see below), and **18 are genuine** (wrong content, wrong location, or a *real* multi-occurrence deficit: picking the wrong existing copy of a repeated quote). A corpus-wide audit confirmed the lenient clamp never touches a repeated quote, so it cannot silently mis-anchor a document.

**Even under +lenient (the generous ceiling), no model clears.** Comment caps at ~79–83% and replacement at 88% (Wilson lower bound 69%, just under the 70% floor) for every model. The residual is genuine capability, not artifact.

**Reliability floor (separate, governing metric).** 3/144 forced comment/replacement calls emitted **no tool call at all** despite forced `tool_choice` on Ollama — i.e. a constrained-output feature would silently do nothing ~2% of the time. Retry and lenient resolution cannot fix this; it counts against FALLBACK at full weight.

## Verdict — below the autonomous bar; SHIP as opt-in experimental (human-reviewed)

Two distinct questions, two distinct answers:

**1. Does any tested model clear the autonomous full-collaborator bar?** **No.** On the ladder (qwen2.5:7b / llama3.1:8b / qwen2.5:14b, CPU dev box, quote-anchored loop, tuned prompt): full-collaborator is blocked by multi-step sequencing and 50-page deep retrieval (≤50% everywhere; envelope, a mandatory gating column, fails for all three), and the constrained single-shot bar isn't cleared on all three ops by any one model even with the lenient resolver or one retry.

**2. Should the capability ship anyway?** **Yes — as an opt-in, experimental, BYO-model feature**, because the 80%/Wilson bar measures *autonomous* quality, and **Tandem is not autonomous**: every local-model comment and replacement is a *proposal anchored to visible text that the user accepts or rejects* (ADR-027 / annotation model). The human-in-the-loop review IS the safety net. A wrong-location anchor surfaces on the wrong sentence in front of the user and gets dismissed; a weak suggestion is reviewed before it's applied — the failure mode is "you reject an off proposal," not "your document silently corrupts." That reframes the spike's measured gaps from *blocking defects* into *expected experimental-quality variance under human review*.

Three signals confirm the capability is present, not aspirational: **chat is 100%** across qwen models (shippable as-is); **comment clears for qwen7b and replacement for qwen14b** (per-op the bar is reachable, just not all-at-once in one model); and the model under test **never touched the network** — the offline premise held end to end. Residual genuine weaknesses to disclose to users: repeated-phrase / occurrence disambiguation, multi-step and 50-page-document work (out of scope), and a ~2% silent no-tool-call rate on forced calls.

### Shipping decision (→ ADR-039)
- **GO as opt-in / experimental BYO-model.** Not a default; not positioned as a Claude-equivalent collaborator. MCP-first / Claude-default (ADR-038) is unchanged.
- **Capability tiers (set user expectations in-product):**
  - **chat** — solid on any tool-capable local model (~7B+); **enabled by default** once a local model is configured.
  - **comment / replacement** — usable but experimental; **behind an explicit opt-in toggle** with an "experimental — review every suggestion" note and the known-weaknesses list.
  - **multi-step / 50-page autonomous** — explicitly **out of scope**, not recommended.
- **Guidance:** a recommended **parameter floor (≥14B for editing)** plus an "Experimental — quality varies" label. (Honest caveat retained in docs: params predict imperfectly; the floor is a heuristic.)
- **Reusable gate:** the harness, scenario bank, and scorer (`probe/local-model-spike/`) are retained as the measurement tool to re-run on any future/candidate model and to publish a capability statement.

### Reproduce / re-test (June commands; they no longer exist)

These were the June commands. The scripts they name were removed on 2026-11-12; the current commands are in [The instrument, rebuilt](#the-instrument-rebuilt-2026-11-12).

```
# full collaborator
npx tsx probe/local-model-spike/batch.ts --models <m1,m2,…> --seeds 2
npx tsx probe/local-model-spike/report.ts
# constrained fallback (strict / lenient / retry)
npx tsx probe/local-model-spike/batch-fallback.ts --models <…> --seeds 2
npx tsx probe/local-model-spike/report-fallback.ts
npx tsx probe/local-model-spike/rescore-fallback-lenient.ts
npx tsx probe/local-model-spike/batch-fallback.ts --models <…> --seeds 2 --retry 1
```

## ADR-039 design decisions (resolved by this spike)

These are determined by the harness design + first principles, independent of the pass-rate numbers; they populate ADR-039's "Reserved" section:

1. **Loop architecture — CONFIRMED:** server-side loop over the same internal operations the MCP tools wrap (`createAnnotation`, `addReplyToAnnotation`, `anchoredRange`), not a spawned MCP client. Verified runnable with no server wiring and no `src/` changes. Diverges from ADR-038 §3's "Agent SDK adapter" wording (which was written for the cloud slice).
2. **Tool contract — quote anchors:** tools take `quoted_text` + `occurrence_index`; the server resolves to a range via `findOccurrence` + `anchoredRange({rejectHeadingOverlap:true})`. The model never sees or emits offsets. Resolution failures (`ANCHOR_NOT_FOUND`/`HEADING_OVERLAP`) are returned as structured tool errors so the model retries. **M0 finding:** occurrence-index / repeated-phrase disambiguation is the dominant editing weakness — the v0.17.0 implementation should harden resolution (markdown-unescape; clamp a redundant occurrence_index to the sole match when `matchCount === 1`; one bounded `ANCHOR_NOT_FOUND` repair round-trip), gated to never mis-anchor a repeated quote.
3. **Origin-tag contract:** local-model writes reuse **`withMcp`/`MCP_ORIGIN`** (verified in the harness). Consequence across the five ADR-031 skip-sets: identical to Claude writes — channel-event-skipped (the loop must not echo to itself), durable-synced, tombstoned. This is correct under the v1.0 "one active agent at a time" constraint; a dedicated `withLocalAgent` helper is only needed if/when concurrent Claude + local (#438/#452, v1.1+) requires per-agent channel routing.
4. **Context-window budget / windowed reading:** short documents are primed fully into context; long documents use `get_outline` → `read_section` windowed reads. The envelope set measures whether small models can navigate this — a real failure point (see preliminary findings).
5. **Endpoint reachability — RESOLVED:** loopback-only default for v1.0; LAN-with-opt-in deferred (changes the SSRF/DNS analysis materially; a separate gated decision, NOT inherited from `IntegrationConfig.url`).
6. **Conversation-state persistence & event ingestion:** M1 implementation detail — leading design: in-memory per-run conversation state; the loop wakes on `chat:message` via the in-process `events/queue.ts` `subscribe()` mechanism.
7. **Identity:** v0.17.0 uses `author: "claude"` as a placeholder; provider-keyed authorship is deferred to #1123 M3. ADR-027 (notes private from ALL models) unchanged.

## The instrument, rebuilt (2026-11-12)

**No model was run in making this change.** It was built in a sandbox with no Ollama. Everything in this section describes the instrument; none of it is a result.

### What was wrong

- The harness had stopped loading. Its `tools.ts` imported `createAnnotation` and `addReplyToAnnotation`, which the product no longer exports, and nothing typechecked `probe/`, so nothing noticed.
- Even loading, it measured neither tier that ships. It kept its own copies of the chat client, the tool list, the loop and the prompts. Since June the product gained a chat tier with its own prompt and only the two reading tools, an editing tier behind an opt-in, an editing gate in the dispatch, lenient anchor resolution, a five-minute run deadline, streaming, and tool results that say "proposed, not changed".
- Its batch runner skipped any trial whose id was already in the June log, its "seed" only chose a temperature the product never sends, and its report hard-coded the three June models.

### What it is now

- **A trial is the product's own chat path.** `harness/trial.ts` builds a document, hands a `chat:message` event to the shipped `createLocalModelCollaborator`, and injects a turn runner that calls the shipped `runLocalModelTurn` and keeps each turn's streamed text. Whether the document is inlined, how a selection is worded, the temperature, the transport, streaming, the response cap, the per-turn timeout, the run deadline and the turn and tool-call budgets are decided by product code on the way through. The harness defines no loop, prompt, tool schema or chat request; a source pin in `tests/server/local-model/harness/source-pin.test.ts` holds that.
- **What is scored is what the user sees.** The reply scored for a trial is the text the chat row holds after the run, including on a timeout, a step-limit exit or an error, where the product flushes partial text. Every turn's text is kept as well, because a preamble shown for a moment can carry a false claim.
- **Scenarios.** Chat tier: three gating groups — questions the document answers (24), questions it does not answer (22), requests only the editing tier can carry out (22) — on new fixtures with planted distractors, a quarter of group one on documents too long to inline; plus six messages that need no action. Editing tier: June's 12 comment, 12 replacement, 12 chat (as questions) and 3 no-op scenarios, unchanged, plus two thread scenarios. June's 6 sequences and 6 fifty-page scenarios are kept in an extended bank that is out of a default run.
- **Every reply is read.** `read.ts` writes a reading file (suspects first) and a verdict template; the reader records a false-claim verdict for every trial and agrees with or overrides the scorer for each gating-group trial, against the rubric in `harness/rubric.ts`. `report.ts` prints PASS, FAIL or INCONCLUSIVE for a full chat-tier run, REPORTED for the editing tier and SCREEN for a screen.
- **It cannot silently stop loading again.** `probe/**/*.ts` is in the test typecheck, the dry run (scripted streamed responses, no model, no network) runs in `check`, and a fingerprint of everything the model sees or is limited by is pinned in `probe/local-model-spike/fingerprint.json`.

### What was removed, and what was kept as history

- **Removed: the forced single-call runners** — `fallback.ts`, `batch-fallback.ts`, `report-fallback.ts`, `rescore-fallback-lenient.ts`, `analyze-fallback-fails.ts`. They measured a constrained structured-output path that does not ship. The "FALLBACK bar" section above is their record.
- **Removed: the copies of product code** — `ollama.ts`, `tools.ts`, `loop.ts` — and the scripts built on them: `batch.ts`, `report.ts`, `scoring.ts`, `run.ts`, `smoke.ts`, `check-envelope.ts`. Their jobs are done by `measure.ts`, `report.ts` (new), `harness/score.ts`, the typecheck, and the start-up validation, which checks every gold anchor through the product's own dispatch.
- **Kept as history, under `probe/local-model-spike/june-2026/`:** the three June result files (`spike-1123-trials.jsonl`, `spike-1123-fallback.jsonl`, `spike-1123-fallback-retry1.jsonl`), unchanged, and the June system prompt (`prompts.ts`), frozen. No run reads them.
- **Kept:** the four June fixtures (`fixtures/*.md`), `generate-envelope.ts` (how the 50-page fixture was made), and `dogfood-m1.ts` at its path with its flags and exit codes; it now calls the product the same way a trial does, and `--model` is required.

### Files

| File | Role |
|---|---|
| `measure.ts` | Run a screen or a full run of one model in one tier; resumable |
| `read.ts` | Write the reading file and the verdict template for a run |
| `report.ts` | Print the outcome for a run |
| `dogfood-m1.ts` | One message through the shipped collaborator, for the hardware checklist |
| `harness/trial.ts` | One trial through the shipped collaborator |
| `harness/fetch-tap.ts` | Observes the shipped client's traffic (reasoning fields, error frames, token counts); sends nothing |
| `harness/classify.ts` | How a trial ended; what is and is not a scored trial |
| `harness/score.ts`, `harness/claims.ts`, `harness/signals.ts` | Deterministic scorer; the claim check that orders the reading; signals that are reported and never gate |
| `harness/rubric.ts`, `harness/reading.ts`, `harness/verdicts.ts`, `harness/report-core.ts` | The reader's rubric, the reading file, the verdict file, the report |
| `harness/scenarios/` | The scenario bank and the new fixtures |
| `harness/runner.ts`, `harness/run-store.ts`, `harness/preflight.ts`, `harness/ollama-meta.ts` | The run loop, the run on disk, the checks before the first trial |
| `harness/fingerprint.ts`, `fingerprint.json` | The fingerprint of what is measured, and the tracked copy |
| `june-2026/` | June's result files and system prompt, as history |

### Commands

One model per invocation. Results go to `probe/local-model-spike/runs/<run id>/`, which is gitignored.

```
# a screen of one candidate (20 trials)
npx tsx probe/local-model-spike/measure.ts --model <tag> --tier chat --screen --hardware "<what it ran on>"

# a full run of the chosen model, each tier
npx tsx probe/local-model-spike/measure.ts --model <tag> --tier chat --hardware "<what it ran on>"
npx tsx probe/local-model-spike/measure.ts --model <tag> --tier editing --hardware "<what it ran on>"

# continue a run that was stopped
npx tsx probe/local-model-spike/measure.ts --model <tag> --tier chat --hardware "<what it ran on>" --resume <run id>

# read it, then report it
npx tsx probe/local-model-spike/read.ts --run <run id>
npx tsx probe/local-model-spike/report.ts --run <run id>
```

### Results of the new measurement

**Empty on purpose.** No model has been measured with the rebuilt instrument. The review session's results PR fills this section: the model, its digest and size, the hardware, the run ids, the outcome of the chat tier, the editing tier's reported rates, and the re-derived size floor. Until then nothing in this document says how the shipped tiers behave on any model.

## Deferred (noted, not silently cut)
- The blind Claude judge + Claude-as-control for chat quality — chat scored on its deterministic floor (100%, so the judge was not the deciding factor); wire it before relying on chat *quality* gradations finer than the floor.
- A live mid-loop-mutation anchor-recovery sequence (current sequences test distractor precision and no-op discipline instead).
