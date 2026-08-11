# Plan: raise the probability that a first-use session arms wake monitoring

**Date:** 2026-08-11
**Branch:** to cut from `master` (product change; PR #1393 is spike-only)
**Measured driver:** natural first-use dispatch of the `tandem` skill was 3 of 6 across both
install shapes (PR #1393), with run-to-run variance — one trial declined twice then completed the
whole chain on an identical prompt.

## Scope correction, before anything else

Two of the three things I originally proposed are struck:

- **"Put the instruction in the `tandem_status` response" already exists.**
  `src/server/mcp/wake-advisory.ts` appends a trailing advisory pointing at the skill, rate-limited
  to once per "nothing attached" period, Solo-gated, fail-closed, carrying no counts and
  deliberately **no executable command** (emitting one into the same `content` array as document
  text would teach Claude that Tandem output legitimately carries commands to run, which an
  imported Word comment could imitate). Do not rebuild or duplicate it.

- **`when: "always"` is out of scope here.** It is the only model-independent option, but it
  reverses #1354 / the ADR-049 amendment from 2026-08-09 and needs its own decision.

## A measurement defect that bounds what we know

`takeWakeAdvisory` returns `null` when `externalConsumerCount > 0` (`wake-advisory.ts:99`). The
acceptance harness attaches a **decoy subscriber before the status call**, because
`subscriber_growth_proven` asserts `armed_count >= decoy_count + 1`. So the advisory fired in
**none** of the ten trials: the harness suppressed the product's only existing nudge toward arming.

Consequence: **3-of-6 is a lower bound on a real first-use session**, not an estimate of it. A real
user with no channel shim and no monitor has a zero count, gets the advisory, and is pointed at the
skill. The harness cannot currently observe that effect, and the decoy is load-bearing for the wake
assertion, so this is a genuine conflict rather than a bug to delete.

Tracked as follow-up, not fixed here (see "Follow-up" below). **No claim in this plan or its PR may
cite 3-of-6 as the rate a user experiences.**

## Change 1 — populate the MCP `instructions` field on the MAIN server

`src/server/mcp/server.ts:192` constructs `new McpServer({ name, version })` with no options
object, so `ServerOptions.instructions` is unset **on the main server**. It is *not* unused
repo-wide: `src/channel/run.ts:48-69` already ships one on the channel shim's low-level `Server`.
ADR-049 states this precisely — "Tandem's main server sends none today (only `src/channel/run.ts:58`
does)" — and an earlier draft of this plan wrongly generalised that to "currently empty".

### Resolving the UNVERIFIED status first (this was a P0)

ADR-049 (`docs/decisions.md:1227`) and `docs/spikes/monitor-self-arm-probe.md:106-110` both record,
in the project's own voice, that **whether Claude Code surfaces this field to the model is
UNVERIFIED — "it could not be probed because nothing sends one."** Shipping a change whose entire
mechanism rests on an unverified premise would be unfalsifiable: it could do nothing while everyone
believed it fixed the problem. So the premise is established *before* the design, on two
independent grounds:

1. **Documented.** Claude Code's MCP docs state that with tool search enabled (the default) **only
   tool names and server instructions load upfront**, full schemas deferred, and that server
   instructions exist to "help Claude understand when to search for your tools, similar to how
   skills work". They are truncated at **2KB** and delivered **once per session** at startup.
2. **Observed first-hand.** A live Claude Code session's context contains a section headed *"MCP
   Server Instructions — The following MCP servers have provided instructions for how to use their
   tools and resources"*, rendering the `instructions` strings of the attached servers verbatim.
   This is direct observation of the field being surfaced, not inference from a type comment.

**Therefore this plan must also correct the two artifacts carrying the stale claim** — ADR-049's
"Not decided here" bullet and `docs/spikes/monitor-self-arm-probe.md` — rather than leaving a
now-falsified UNVERIFIED in the decision record. A review that disproves a claim has to reach every
carrier of it.

The SDK supports the field (`server/index.d.ts:15`, *"Optional instructions describing how to use
the server and its features"*).

This is the only lever that reaches a session **before any tool call and before any skill
decision** — no discovery step, no model judgment about whether guidance is worth loading. It is
also client-agnostic: a non-Claude MCP client gets no `SKILL.md` at all and currently receives nothing
about wake monitoring. That is *compatible* with ADR-038 rather than demanded by it — the ADR says
other clients "use the same MCP tools, but the Claude-specific transports don't apply… best-effort,
MCP-contract-compatible, not validated today" (`docs/decisions.md:791`). An earlier draft said this is
"what ADR-038 wants", which overstates the ADR.

**This field is the *designed* mechanism for this exact problem, and it explains the declines.**
Claude Code's docs state that with tool search enabled (the default) **only tool names and server
instructions load upfront**, full schemas deferred, and that server instructions exist to "help
Claude understand when to search for your tools, similar to how skills work". Every declining trace
in PR #1393 shows `ToolSearch` *before* `tandem_status` — Tandem's tools were deferred. So at
session start the model had Tandem's tool names plus an **empty** instructions string: nothing
whatsoever about wake monitoring was in context at the moment the behaviour was decided. It
searched, found `tandem_status`, answered. The skill was never a candidate.

Two mechanical constraints from the same source: instructions are **truncated at 2KB** (put critical
details first), and they are delivered **once per session at startup**, which is exactly the
at-most-once semantics wanted here.

**Considered and rejected: `alwaysLoad: true`.** MCP servers can opt out of tool-search deferral,
putting every tool description in context from session start. Rejected: 29 active tools is a large
permanent context cost, and it does not address arming — the wake instruction is not in any tool
description. `instructions` buys the same upfront presence for two sentences.

Constraints on the text, each with a reason:

- **Must not assume Claude Code.** No `SKILL.md` reference as the sole route, no `Monitor` tool by
  name as a requirement. Phrase capability-first: *if your client offers a persistent watch*.
- **Must not carry the arm command.** Same reasoning as the advisory, and consistency matters more
  than the (weaker) channel argument — `instructions` is server metadata, not mixed with document
  text, but a second place that emits commands re-opens the pattern the advisory refuses.
- **Must be short.** It is in every session's context for the whole session. Target ≤ 60 words.
- **Must not duplicate the advisory's job.** The advisory speaks when nothing is attached; these
  instructions establish the *standing* expectation once, at start.
- **Must not state a coverage claim.** The server cannot know whether this session is armed
  (subscriber count is stale by construction since #1354). Phrase as a standing instruction with an
  at-most-once bound, never as "you are not covered".

- **Must carve out the launcher-spawned population (this was the second P0).** `SKILL.md:99` is
  load-bearing: *"Do not arm one if Tandem launched you. A launcher-spawned session is already woken
  directly on its input... A second watch double-wakes every message."* That caveat currently lives
  **only** in the skill body — which is read *second*, and only if the skill is invoked at all.
  `instructions` arrive at `initialize`, before any skill decision, so a model acting on them alone
  in a launcher-spawned session would arm a duplicate watch and double-wake every event. An
  unconditional "arm one" here would therefore introduce a regression in exactly the population that
  already works. The exception cannot be omitted for brevity.

Draft:

> Tandem is a collaborative document editor — the user edits the same document alongside you. Always
> treat `tandem_checkInbox` as the authority on user activity, and poll it every few tool calls.
> Nothing polls between your turns: if your client can hold a persistent watch, arm one (at most once
> per session) on the `wakeUrl` from `tandem_status`. Skip that if Tandem launched this session — it
> is already woken on its input, and a second watch double-wakes every event. In `solo` mode, hold
> annotations rather than surfacing them.

**Forward risk to record, not to solve here:** `instructions` rides on the `initialize` result, and
MCP `2026-07-28` removed the `initialize` handshake. Per ADR-045's 2026-07-30 amendment no SDK
implements that revision yet, so it works today — but this becomes a **second** thing keyed to the
legacy branch alongside `Mcp-Session-Id`. It must be named in #1249 so it is found by review rather
than by regression.

## Change 2 — rewrite the skill `description:` as a precondition, not an offering

`skills/tandem/SKILL.md` frontmatter today:

> Use when tandem_* MCP tools are available, the user asks about Tandem document editing, or
> iterating on text collaboratively. **Provides workflow guidance, annotation strategy, and tool
> usage patterns** for the Tandem collaborative editor.

The trigger clause is already maximally broad — `tandem_*` tools being available is exactly the
observed condition — and it was still declined half the time. **So breadth is not the defect.** The
second sentence is: it advertises what the skill *provides*, and a model that can answer "report the
current collaboration state" from a single `tandem_status` call correctly judges that it does not
need workflow guidance. Declining is the rational reading of this description.

The rewrite states an obligation positioned in time, pre-empts the specific rationalisation observed
(a lone status check felt too small to warrant the skill), and names what breaks silently:

> Use **before the first `tandem_*` call** in a session — including a lone status check. Covers
> being woken while idle so the user's comments and chat reach you between turns, plus annotation
> strategy, editing workflow, and tool usage patterns.

An earlier draft ended the first clause with *"skipping it leaves the session silently unwakeable"*.
Dropped: it is false for the launcher-spawned population, which is woken on its input regardless of
the skill. Lower stakes than the same overclaim in `instructions` (the skill body carries the correct
caveat, so a model that loads the skill self-corrects) but a frontmatter line that is wrong for a
whole population should not ship to state it.

**Counter-risk, which is the real review question:** a description that overstates the obligation
fires on every trivial mention and becomes noise — the objection #1354 was created to settle for the
monitor. "Before the first `tandem_*` call" is keyed to a tool call rather than a topic, which is the
intended discriminator — **but that discriminator is weaker than it reads.** Skill matching happens
semantically over the description at decision time, *before* any tool call exists; the model still
has to infer "I am about to call a `tandem_*` tool", which is the same class of judgment the current
description already requires. So this wording change is a **bet, not a fix**, and per Verification
below it is one we cannot currently falsify.

**Mechanical requirements:**

- Bump frontmatter `version: 10` → `11`. The installed copy at `~/.claude/skills/tandem/` only
  refreshes when the bundled version is newer (CLAUDE.md), so a change without a bump does not
  reach existing users.
- `tests/skill-instruction-contract.test.ts:26` pins `/^version:\s*10$/m` and must move with it.
- Check `tests/server/integrations/refresh-skill.test.ts`, `tests/cli/setup.test.ts` and
  `tests/plugin-manifest.test.ts` for other version or description assertions.

## What this deliberately does not claim

Neither change makes arming reliable. Skill invocation is a model judgment — **confirmed against
Claude Code's docs: there is no mandatory, always-loaded, or auto-invoked skill mechanism.** The only
frontmatter controls are `disable-model-invocation` and `user-invocable`, which restrict *who* may
invoke, never force invocation; `skills:` preloading exists for subagents only, not the main session.
Strengthening the description is the only documented lever. And `instructions` is context the model
may act on or not. The only
model-independent paths remain the supervisor writing to a launched session's stdin, the channel
shim, and `when: "always"`. If wake-on-idle must be a guarantee rather than a strong default, it
cannot be routed through a model's choice, and that is a different decision.

## Verification

1. `npm run typecheck` + `npm test`.
2. A test asserting `instructions` is non-empty, contains no shell command, and does not name a
   Claude-Code-specific tool as a requirement — mirroring the existing
   `wake-advisory` "what the text may never contain" block, which is the precedent for pinning
   prose constraints.
3. Confirm via an MCP client that the instructions actually surface (they appear in the client's
   session context, so this is observable by inspection, not inference).
4. **Do not re-run the ten-trial gate as an A/B of these changes yet.** With the decoy suppressing
   the advisory, the harness measures skill dispatch in a configuration no user is in, so a
   before/after would compare two numbers that both exclude the mechanism under test.

## Follow-up (separate, spike-side)

Resolve the decoy-vs-advisory conflict so the harness can measure first-use arming in the
configuration a real user is in. The obvious move — attach the decoy only *after* the first
`tandem_status` and derive subscriber growth from that later baseline — **is not free, and should not
be filed as an aside.** `subscriber_growth_proven` asserts `armed_count >= decoy_count + 1` from
counts sampled at specific instants. A model that calls `Monitor` in the same turn immediately after
`tandem_status` leaves no observable gap, so a decoy attach driven off a post-status hook event can
race the model's own arm and fail to attach in time — silently reinstating the suppression the fix
exists to remove. This needs its own design, and it is the gating work for measuring either change
above, or `when: "always"` if that is ever revisited.

**Until it lands, both changes here are unfalsifiable.** That is the honest status: the reasoning is
grounded (an empty `instructions` string at the exact moment the behaviour is decided, and a
description whose second sentence invites "I can answer without this"), but the harness cannot yet
tell us whether either helped. Do not let a subsequent green ten-trial run be read as validation
while the decoy still suppresses the advisory.
