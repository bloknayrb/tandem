# Plan: Local Models Return to v1.0 (D4 second amendment)

**Branch:** `claude/local-models-v1-scope` (new PR) · **Date:** 2026-06-11 · **Origin:** Bryan, hours after merging PR #1122: "local models need to be working in 1.0." Scope pinned via AskUserQuestion: **local-only** providers (Ollama / LM Studio / llama.cpp via OpenAI-compatible local endpoints; cloud BYO keys stay v1.1), **full-collaborator** depth (the local model does what Claude does: read doc, create/edit annotations, propose replacements, chat — via a tool-use loop), slotted **v0.17.0 after licensing** (v0.15.0 install matrix → v0.16.0 licensing → v0.17.0 local models → v1.0.0; date floats per thesis).

## What this PR is (and isn't)

This PR is the **re-scoping**: a D4 second amendment across every surface PR #1122 just touched, a new engineering tracking issue with a kill-gated PR sequence, wave/cadence/exit-criteria updates. It does NOT implement the client (that's the tracked work, ~M0–M4 below).

## Ground truth (verified in repo 2026-06-11)

- Models registry already supports `local-ollama` / `local-llamacpp` (`ModelProvider`, `useTandemSettings.ts:63`), endpoint field for local providers (no keychain needed), `agentLabel.ts` brand map ("Local model"), Settings → Models CRUD + first-run picker — all shipped v0.13.0, hidden behind `BYO_MODELS_ENABLED=false` since v0.14.0.
- What does NOT exist: any server-side outbound LLM client, any agent loop, any non-Claude author identity. `author: "user"|"claude"|"import"` is baked into the annotation model (ADR-026/027); ADR-038's consequences already anticipate provider-keying it.
- ADR-039 is Reserved ("targeted v1.1" as of PR #1122 — to be re-amended).

## DD-L1 (the decision): D4 amended a second time

- **2026-06-11a (PR #1122):** registry+adapter → v1.1. **2026-06-11b (this PR, Bryan):** the **local-provider slice returns to v1.0** at full-collaborator depth; OpenAI/Gemini cloud slice stays v1.1. Record both amendments; never silently rewrite the first one.
- Consequence rewrite (replaces "v1.0 charges while the audience is Claude-gated" everywhere it was stated — roadmap D4 bullet, ADR-040 §1 note, positioning.md): v1.0's reachable audience = Claude users **+ anyone who can run a local model**; strengthens ADR-040 §2 (BYO-local-LLM + one-time license = zero-subscription stack) and §1 (breadth mechanism partially restored to v1.0).
- **Depth bar with explicit fallback (must be in the amendment text):** full collaborator is the target; the M0 spike is the kill-gate. If 8–14B-class local models cannot reliably anchor ranges / drive tools, the fallback is the constrained structured-output path (chat + comment/replacement suggestions), and that renegotiation **returns to Bryan with spike evidence** — it does not happen silently.

## Work items

### W1 — Tracking issue: "v1.0 local models: outbound LLM client + tool-use loop (#477 PR 5, local slice)"
PR sequence (each lands separately; M0 gates everything):
- **M0 — capability spike + ADR-039 draft (kill-gate).** Prototype loop driving 2–3 reference models via Ollama's OpenAI-compatible endpoint (e.g. Llama-3.1-8B-class and Qwen-2.5-14B-class) against the real operations: read text, place a comment on a quoted range (exact-anchor test), propose a replacement, chat reply. Output: ADR-039 drafted in its reserved slot — architecture decision (server-side loop calling the same internal operations the MCP tools wrap, NOT a spawned MCP client; tool-schema shape; context budget; streaming), the capability bar, and GO / FALLBACK / NO-GO. Timebox + kill date like #576's.
- **M1 — outbound client + agent loop (server).** OpenAI-compatible chat-completions client (base URL from the registry entry, loopback-constrained like `IntegrationConfig.url`), internal tool dispatch, loop budget/timeouts/abort, streaming into chat, failure surfacing (reuse #1018 loud-failure pattern, provider-aware CTA). Security notes for the RC gate: SSRF posture of user-supplied base URLs, no key material for local providers, the new outbound surface gets a security review before merge.
- **M2 — registry re-enable (local slice).** `BYO_MODELS_ENABLED` → conditional enable for local providers only (cloud rows stay hidden); wizard "AI models — coming soon" row becomes the local-model setup path; Settings → Models + default-model chip + first-run picker re-enabled for local kinds; Ollama/LM Studio detection nicety if cheap.
- **M3 — identity + attribution.** Provider-keyed author (or `provider` sidecar field per ADR-038 consequences) so local-model annotations aren't labeled "claude"; `agentLabel` wiring; authorship color question (`--tandem-author-claude` token rename or shared "AI" color — small ADR or D-decision); channel-event + solo/tandem semantics for a non-Claude agent; ADR-027 unchanged (notes stay private from ALL models — state it).
- **M4 — UX + docs + E2E.** Chat target selection when >1 agent configured; typing-presence; tutorial/welcome copy; user-guide; E2E with a stub OpenAI-compatible server (CI can't run real models).

### W2 — Docs re-scope (this PR's diff)
- `docs/roadmap.md`: wave table — new **Wave 5M / v0.17.0** row (after 5L); cadence table v0.17.0 row + v1.0.0 row mention of the local-model gate; Key Decisions D4 bullet — append amendment (b) with consequence rewrite + fallback clause; Locked Decisions D4 row — same, terse; PR-5 row — local slice → v0.17.0 (issue #), cloud → v1.1; "Out of scope for v1.0" — local removed, cloud-only remains; v1.0 Core scope line; Deferred-milestones MCP-bridge bullet — split local/cloud; **exit criteria**: new functional gate (named reference model via Ollama on smoke hardware, offline: wizard/Models connect → reads doc → places comment on selected text → replacement proposed and accepted → chat round-trip) and revise the 2026-06-11a wizard criterion (BYO-hidden clause now applies to cloud only; keychain round-trip check stays); Future Extensions "Additional model providers" line.
- `docs/v10-triage.md`: D4 rows — second dated note (pointer style).
- `docs/decisions.md`: ADR-039 status — local slice v1.0/v0.17.0 (drafted by M0), cloud v1.1; ADR-040 §1 note — consequence rewrite; ADR-038 Context note — update.
- `docs/positioning.md`: distribution-friction paragraph — rewrite (local models restore non-Claude reach in v1.0).
- `README.md`: "additional providers planned for v1.1" → local models in v1.0 (coming in v0.17.0), cloud v1.1. Present-tense honesty: don't claim it works today.
- `CLAUDE.md` Status: "Remaining to v1.0" gains v0.17.0.
- `sample/welcome.md` + snapshot: current "Support for additional model providers is on the way" stays accurate — no change (verify).

### W3 — Adversarial review of this plan (before any edit)
Two agents: (1) contrarian — attack the v0.17.0 slot (riskiest item scheduled last?), the full-collaborator bar vs small-model reality, the M-sequence, and whether re-amending D4 twice in one day needs stronger guard-rails; (2) doc fact-checker — every W2 surface against the post-#1122 repo state (line numbers moved; the consequence sentence locations; whether any #1122 text contradicts the new state).

### W4 — Implement, commit, push `-u origin claude/local-models-v1-scope`, PR
PR body: decision summary (Bryan-initiated, so no veto checklist needed — but state the fallback clause and the "amendment b does not erase amendment a" record), link the new issue + #1116/#1117 (sequencing unchanged), note licensing calendar unaffected.

## Risks
- **Schedule honesty:** this adds the largest unbuilt feature on the v1.0 path *after* licensing; the M0 kill-gate + fallback is the only protection. Stated in roadmap risk line.
- Small-model tool-use reliability is the central unknown — M0 exists precisely to convert it to evidence.
- Identity/attribution (M3) touches the annotation data model (Critical Rule territory) — sequenced after M0/M1 so the ADR governs it.

## Rev 2 — adversarial review incorporated (2026-06-11)

Two blockers + 8 should-fixes accepted in full; deviations from rev 1:

- **M0 pulled forward**: runs immediately, parallel with v0.15.0 (same rationale as Wave 5L), concrete kill date 2026-07-02; doc surfaces asserting the capability ship marked "gated on M0". M1–M4 stay v0.17.0.
- **New M1a**: registry persistence relocation — `ModelRegistryEntry` lives only in client localStorage (`tandem:settings`); server gains authoritative storage + migration + gated mutation route. Ground-truth bullet corrected.
- **M0 bar quantified**: server-resolved quote anchors (quoted text + occurrence), never raw offsets; ≥N% over ≥20 trials per op + full sequence, at the 50-page envelope; FALLBACK has its own measured bar; GO names exact model+quant per smoke machine (exit criterion inherits the names).
- **M1 input side added**: event-queue ingestion triggers, conversation-persistence decision, windowed doc reading. **One active agent at a time** — concurrent Claude+local is #438/#452, v1.1+.
- **Origin-tag decision** (reuse `MCP_ORIGIN` vs new helper; consequences across all five ADR-031 skip-sets) is a named ADR-039 deliverable.
- **M2 enable lands dark; flip moves to M4** after M3 attribution — no main-branch state has local output labeled `author:"claude"`.
- **Canonical record moves into ADR-039's reserved slot NOW** (status Accepted-scope/Reserved-design, both 2026-06-11 amendments verbatim, depth bar, fallback clause, license-applies-identically, open design decisions incl. endpoint LAN-vs-loopback for Bryan); all other surfaces become pointers. ADR-038 §3 gets a mechanism note (loop-vs-adapter = M0 hypothesis, ADR-039 owns it).
- **Monetization edges stated**: license/trial gate applies identically with local models (ADR-040 §3 note + README); M4 docs name the tested-model floor. ADR-040 §1 "MCP-capable LLM" audience sentence + positioning.md platform-risk "MCP-capable AI you bring" lines added to W2.
- **Security gate**: outbound LLM client surface explicitly in scope despite route-diff enumeration being inbound-only.
- **W2 additions from fact-check**: roadmap :506 #477 bullet, :522 hop sentence (v0.16.0→v0.17.0 becomes the first endpoint-transition rehearsal — an improvement), :555 cadence prose + doubly-stale Bryan-local wave-plan note. `docs/plans/2026-06-11-v1-roadmap-reconciliation.md` is deliberately left untouched as the dated record of amendment (a).
