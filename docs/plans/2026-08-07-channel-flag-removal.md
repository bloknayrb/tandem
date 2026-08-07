# Delete the inert dev-channels flag; fix what the docs claim about push

**Status:** Proposed — not implemented. Opened for a second pair of eyes before any code lands.
**Date:** 2026-08-07
**Claude Code version read:** 2.1.223 (statically, from the installed binary — no session was run)
**Refs:** [#1266](https://github.com/bloknayrb/tandem/issues/1266), [ADR-028](../decisions.md#adr-028-plugin-monitor-url-and-auth-resolution--userconfig-over-hardcoded-default), `docs/spikes/channel-push-stream-json.md`, [anthropics/claude-code#42486](https://github.com/anthropics/claude-code/issues/42486)

**How to read this.** Stage 1 is ready to implement. Stage 1b is a separate PR of security defects found while reviewing Stage 1 — its file:line citations came from a security-review pass and one verification sweep over them was still running when this was opened, so confirm each before acting. Stages 2–4 are decisions and deferrals, not work items.

**Sequencing — this plan depends on [#1316](https://github.com/bloknayrb/tandem/pull/1316) (`fix/hand-launched-push-honesty`).** That PR is code+docs over six of the same files and is not yet merged. Implementation must follow it and be rebased: `src/cli/setup.ts:191` no longer exists there, `doctor.ts` line numbers shift by ~100, and `troubleshooting.md` / `architecture.md` / `roadmap.md` / `decisions.md` all move. **Every `file:line` below is against `master` as of 2026-08-07 and must be re-confirmed post-rebase** — the caveat this plan already applies to Stage 1b applies to Stage 1 too.

**Consistency note, so nobody over-reads "the flag is inert."** It is inert under `-p`, which is how the launcher spawns. Hand-launched sessions are interactive, where the flag is the *only* mechanism that works. #1316's copy telling hand-launched users to pass it is correct and must not be deleted on the strength of the inertness finding.

**Evidence caveat that applies throughout.** Every claim about Claude Code's internals here comes from reading a minified 278 MB binary with `grep -a`. That method already produced one wrong answer in this very plan (see Context). Treat each fragment as provisional and re-verify before relying on it.

## Context

Bryan asked who to contact about getting Tandem onto Claude Code's channel allowlist so users don't need `--dangerously-load-development-channels server:tandem-channel`. Research found no application process — the allowlist is Anthropic-curated and keyed on `plugin@marketplace`, so a bare `server:` entry has no listing shape that could ever satisfy it.

A first draft of this plan then claimed a way around it. **That claim was wrong and has been removed.** I extracted the gate from the Claude Code 2.1.223 binary and stopped one branch too early. The real ending:

```js
if (i.kind === "plugin") { /* marketplace match; then allowlist check unless i.dev */ }
else if (!i.dev) return { action:"skip", kind:"allowlist",
  reason:`server ${i.name} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)` };
return { action:"register" }
```

`else if (!i.dev)` rejects **every** non-dev `server:` entry unconditionally. `dev:true` is set at exactly two sites in the binary, both in the interactive onboarding block. So `--channels server:tandem-channel` fails in both modes, always. The binary even ships the rule in English — `"server: entries need --dangerously-load-development-channels"` — one grep away from where I was looking.

**For a non-plugin MCP server, the dangerous flag is not a wart to route around. In 2.1.223 it is the only mechanism that exists**, it works only in interactive mode, and it is not carried across respawn, resume, or background dispatch.

Security review then found that the refuted route was not merely useless but **actively unsafe**. The permission relay selects its targets with a different, weaker filter than the message gate: `pIp(...)` checks connection state, both capability keys, and protocol era, then tests membership with `findChannelEntry` — list membership only, no `dev` check, no allowlist, no policy or provider check. `gateChannelServer` is never called on that path. So under `--channels server:tandem-channel`, events would be skipped with `kind:"allowlist"` while `notifications/claude/channel/permission_request` — carrying `tool_name`, `description`, and up to ~30 KB of `input_preview` — would **still** be relayed to Tandem. The command the first draft wanted to put in the README would have left exactly one channel capability live, and it is the dangerous one.

One finding does survive, with strong corroboration:

> **The flag is inert in non-interactive mode.** Startup does `if (!Ke) { …parse dev channels… }` where `Ke = bn()` is isNonInteractiveSession — confirmed by four sibling error strings gated on `!Ke` ("can only be used with --print mode") and two structural uses. The launcher spawns with `-p --input-format stream-json --output-format stream-json`, so the flag it passes today does nothing. Independently, `--dangerously-load-development-channels` appears in none of the respawn/dispatch flag-carry sets, while `--channels` does.

That matches Tandem's own measurement in `docs/spikes/channel-push-stream-json.md` (#1266), which is why `supervisor.ts` writes wake turns on stdin instead.

So the deliverable is smaller and more honest than the original plan: **delete a flag that does nothing, and fix the documentation that says it does something.** Several doc surfaces have asserted since #1266 that auto-launched sessions get channel push; they don't, and haven't. That is the real bug here.

Adversarial review also surfaced a separate defect worth filing: **the channel permission relay is a stub.** Nothing in `src/client/` reads `pendingPermissions`; the shim registers `permission_request` as an MCP *notification* handler (`src/channel/run.ts:161`), and notifications cannot be answered; `POST /api/channel-permission-verdict` (`src/server/mcp/channel-routes.ts:152`) deletes the entry and `console.error`s the verdict, so it cannot reach Claude Code. It is documented as a shipped API in `docs/mcp-tools.md:1202-1226` and `docs/roadmap.md:265`. This matters here because it was **rationale (1)** for ADR-028's keep-the-channel-canonical decision.

---

## Stage 1 — Ship it (no probe needed; static evidence is sufficient)

### Code

- **`src/shared/launcher/contract.ts:187-196`** — delete `"--dangerously-load-development-channels"` and `"server:tandem-channel"` from `CLAUDE_STREAM_JSON_FLAGS`. Rewrite the doc comment to record *why*, citing #1266 and the `!isNonInteractive` gate, so nobody re-adds them.
  - Verified safe: `tests/server/launcher/supervisor.test.ts:491,516` and `tests/server/launcher/stream-json-protocol.test.ts:280-283` both import the const and slice by its length. They stay green.
  - Safe regardless of the inertness finding: even if the flag registered, #1266 measured directly that no turn results under `-p`. The only thing lost is the permission-request notification, which per Context is a stub with no consumer and no return path.

### Statements that are false, not merely stale

Each of these is a **rewrite**, not a string swap. The failure mode to avoid is producing "the auto-launcher passes `--channels` automatically."

| Location | Currently says | Reality |
|---|---|---|
| `docs/architecture.md:348` | "the desktop auto-launcher passes it automatically" | Auto-launched sessions use the supervisor's stdin wake and register no channel |
| `docs/architecture.md:354` | "no separate `--channels` flag is needed" + "not *yet* on the official channel allowlist" | Both wrong. `server:` entries are **not allowlistable in principle** — the allowlist is keyed on `plugin@marketplace`, and a non-dev `server:` entry is rejected unconditionally regardless of any list |
| `docs/troubleshooting.md:143` | "Sessions Tandem starts always get the flag" | They get an inert flag; after this change, none |
| `README.md:110`, `:253` | launched sessions "already have" the channel shim / get both connections | Second connection is the stdin wake, not the channel |
| `docs/user-guide.md:314` | the flag "stays necessary while the Channels API is still experimental" | Necessary for hand-started sessions, but for a reason that has nothing to do with experimental status |
| `src/cli/doctor.ts:1071` | "(the desktop app's Relaunch Claude button does this)" | No longer true |
| ~~`src/cli/setup.ts:191`~~ | ~~"the channel shim is registered; Claude Code receives events in real time"~~ | **Already delivered by #1316** — `printPushStatus` was rewritten to report per-target writes that actually succeeded, for this reason plus one this plan missed: it checked a *file* (`existsSync(CHANNEL_DIST)`), not a *write*, so `--target=claude-desktop` announced a shim it had never registered |

**A live bug found by #1316's author, confirmed here on `master`.** `src/cli/index.ts:135` passes `withChannelShim: args.includes("--with-channel-shim")` — always a boolean, never `undefined` — and `shouldRegisterChannelShim` (`src/server/integrations/apply.ts:1012`) short-circuits on `if (override !== undefined) return override`. So `validateChannelShimPrereq` is unreachable from plain `tandem setup --apply`, and **it has been registering no channel shim for Claude Code at all**. Fixed in #1316; recorded here because it changes what "the channel shim is the registered default" has actually meant in practice.

Also sweep the flagless-monitor phrasing, which describes the monitor's differentiator against a flag: `docs/cli.md:87`, `docs/architecture.md:405` and `:411`, `src/cli/setup.ts:196`, `src/monitor/run.ts:10`. Grep for the abbreviated `--dangerously-...` form too. **Leave** archived plans, superseded spikes, released CHANGELOG entries, committed probe scripts, and `docs/roadmap.md:437` — those are historical record per house convention. **Correction from #1316's review: `:476` is not.** It and `:465` cite #1201 *forward*, as live justification for the current keep-both decision, and that citation is circular — #1201's own body defers the probe it is credited with resolving. Qualify both; `:437` is genuinely historical and stays. `.mcp.json.example`, `CLAUDE.md`, and `skills/tandem/SKILL.md` need no change (verified: zero hits).

### Lead with the flagless option

The plugin monitor needs no flag and is the better recommendation for the audience this reaches (people who type `claude` by hand) — **but only with a precondition stated, and this plan originally got that wrong.**

Per #1316 and `docs/spikes/plugin-delivery.md`, the published plugin's monitor fails **`exit 127` in every Claude Code session** for a class of users. Monitors are spawned `spawn(cmd, [], { shell: true, … })`, and `shell: true` on POSIX is a **non-login** `/bin/sh -c` — no profile is sourced, so PATH is whatever Claude Code itself started with. A terminal launch inherits the user's shell PATH and works; a GUI launch inherits the OS default, has no Node, and `npx -y tandem-editor@<v> monitor` cannot resolve. There is no manifest-level fix: the monitor command is one static string for every platform, and the form that would pick up a login shell's PATH (`sh -lc '…'`) doesn't exist under the `cmd.exe` that `shell: true` resolves to on Windows.

So: flip the ordering, but **condition the recommendation on a terminal-launched session** rather than presenting the monitor as unconditionally flagless. Leading with it unqualified would be a new over-claim of exactly the kind this plan exists to remove.

This also weakens the reviewer argument recorded below against Stage 1 — "the only audience reached already has a flagless option." That option is broken for an unknown fraction of them.

Surfaces: `README.md:113` and `:253-262`, `docs/troubleshooting.md:135-145`, `src/cli/doctor.ts:1069-1074`, `IntegrationWizardModal.svelte:852-857`. Keep the double-delivery warning and raise its prominence — `.claude-plugin/plugin.json` ships both `tandem-channel` and `experimental.monitors[]`, so a plugin user who also passes the flag trips it.

`tests/cli/doctor.test.ts:1277` is the only test hardcoding the flag string; update its regex.

### Decision records

- **Mint ADR-047 — "Claude Code push-transport activation."** ADR-028 is titled "Plugin Monitor URL and Auth Resolution"; its `**Status:**` line has never been touched by any of the four canonical-transport amendments it has accumulated, so a reader consulting it normally learns nothing about the transport decision. House precedent (ADR-004, ADR-027, ADR-029, ADR-039, ADR-040) is a new ADR plus a pointer when the subject changes. ADR-047 owns:
  - the **gate map**: capability → protocol era → provider (`firstParty`) → feature availability → org policy → session registration → for `plugin:` entries, marketplace match then allowlist; for `server:` entries, unconditional rejection unless dev. This is what makes a future regression diagnosable instead of mysterious, and it belongs in `docs/architecture.md:346-354` too, as the replacement for the false sentences there.
  - which transport is canonical for which session kind, including the launcher's stdin-wake path.
  - that **ADR-028's rationale (1) is void** — the permission relay is unimplemented client-side and unanswerable on the wire. Rationale (2) was already retracted by the 2026-08-04 correction. Only (3) survives, and it is an install-cost argument, not a capability one. Do not write "the keep-both decision stands"; whether that reopens monitor-canonical is a separate decision, but the record must not claim a capability leg that is a stub.
  - Add `**Superseded in part by ADR-047**` under ADR-028's Status.
  - **Absorb, don't sit beside, #1316's `Correction (2026-08-06)` block.** That PR establishes the 2026-07-17 ADR-028 update overstated its evidence: it asserts `--plugin-dir` activation (unreproduced on 2.1.223) and calls double-delivery "confirmed", while #1201 defers both P1 and P2. If ADR-047 supersedes that section, leaving the correction as a separate adjacent block re-creates the amendment-chain problem ADR-047 exists to end.
- **`docs/roadmap.md:465`** — rewrite, don't append. The strikethrough is compound ("plugin monitor is canonical; launcher drops the dev-channels flag") and this change resurrects the second conjunct while the first stays overridden; that can't be expressed by another override layer. Point at ADR-047 and let it narrate. Same for `:511`.
- **`CHANGELOG.md`** `## [Unreleased]` → `### Changed`, past-tense user-facing prose (match the file, not the changelog skill's imperative guidance).
- **`docs/lessons-learned.md` `## 92.`** — the lesson is mine: I inferred a gate's behaviour from minified control flow and stopped one branch short, when the binary shipped the rule as a plain-English user-facing string. *Grep the error strings before reading the control flow — a gate that rejects you usually explains itself in English somewhere.*

---

## Stage 1b — Security defects surfaced by review (separate PR, but do not defer)

These are independent of the flag work. They were found while reviewing it, and two of them are live disclosure issues.

**All citations in this section were re-verified against `master` on 2026-08-07** — the capability declaration (`run.ts:52-55`), all three permission-route handlers, the oversize-frame throw, the `import`→`user` relabel at `annotation-actions.ts:77`, the ungated `onEvent` forward, and `authMiddleware`'s loopback bypass (documented at `middleware.ts:149`: *"Bypasses auth for loopback requests (Claude Code zero-config)"*). They hold as written.

One refinement from that pass: the relay's incompleteness is **acknowledged in-code**, not accidental. `channel-routes.ts` carries *"Pending requests stored for browser polling (SSE push to browser is a follow-up)"* and *"Store verdict for the channel shim to poll (or push via SSE in follow-up)."* So this is a capability that was **declared before its implementation landed**, and the follow-up never came. That changes the framing but not the consequence — and it argues for withdrawing the declaration rather than treating it as a bug to patch, since the code already knows what's missing.

1. **Drop `"claude/channel/permission": {}` from `src/channel/run.ts:53-54`.** Tandem declares a capability it cannot honor: the shim registers `permission_request` as a *notification* handler, and `POST /api/channel-permission-verdict` (`src/server/mcp/channel-routes.ts:151-162`) deletes the entry, logs, and returns to the browser — the verdict never reaches Claude Code. Declaring it buys nothing and costs the prompt contents. If it is ever finished instead, note that the resolve map is keyed on a 5-character code over a 25-letter alphabet, matched case-insensitively, with no sender binding — so the return leg must not be built on today's ungated route.
2. **Stop serving `inputPreview` from `GET /api/channel-permission`** (`channel-routes.ts:141-148`), and stop `console.error`-ing it at `:136`. `authMiddleware` bypasses on loopback, so any local process can currently read pending Claude Code tool-approval prompts — for a `Write` that is file content, for a `Bash` the command line.
3. **Cap event content.** No cap exists on annotation `content`, chat `text`, or `selectedText`. Beyond context flooding, a frame over `CHANNEL_MAX_SSE_BUFFER_BYTES` (1 MB) throws in `src/shared/sse-consumer.ts:382-386` *before* parsing, so `lastEventId` never advances, the reconnect replays the same frame, and after `CHANNEL_MAX_RETRIES` the shim calls `process.exit(1)`. One oversized Word comment permanently kills push until restart. Cap in `formatEventContent`, and make the oversize branch advance `lastEventId` like the other unparseable-frame branches. **This bug currently fails silently; after #1316 it won't** — the shim's exit drops `push.subscribers` to 0, which is exactly the condition of that PR's new "Claude is connected but isn't being notified" notice. It becomes user-visible for free, which raises the priority of fixing it rather than lowering it.
4. **Imported Word comments are relabeled as user-authored.** `src/client/panels/annotation-actions.ts:77` maps `author === "import"` to `"user"`, which satisfies the observer's user-only gate and emits `annotation:created`. `formatEventContent` then renders verbatim, uncapped, third-party document text as `User created comment on "…": …`, dropping `importSource.author`. A `.docx` someone emails you carries text that arrives in the model's context attributed to the user, one click away, with no network exposure required. This is the concrete reason the dev-channel consent dialog is not ceremony for Tandem specifically — the stream is a conduit for documents Tandem did not author.
5. **Record that the shim performs no sender gating.** `src/channel/event-bridge.ts:19-33` forwards whatever `/api/events` yields; the only upstream filters are privacy filters (Solo mode, notes), not sender filters. Auth on `/api/events` gates readers, not producers. `docs/security.md` should state the honest boundary: any process on the machine can produce an event.
6. **The permission-relay stub is documented as a shipped API** in `docs/mcp-tools.md:1202-1226` and `docs/roadmap.md:265`. Correct those whichever way (1) resolves.

Also worth writing down in ADR-047 rather than leaving accidental: **a supervised session has no approval surface at all.** `buildClaudeArgs` passes no `--permission-mode`, no `--allowedTools`, no skip flag; under `-p` the dev flag is not parsed, the channel permission callbacks are wired only on the interactive path, and there is no TTY. The flag deletion is the moment that becomes documented instead of incidental.

---

## Stage 2 — The one cheap check worth doing (replaces the probe)

**Do not build `scripts/spikes/probe-channels-flag.ts`.** The 4-cell matrix in the previous draft is void: both `--channels` cells now fail statically at the gate, and both dev-flag `-p` cells fail at parse, so no cell reaches the delivery question. Tandem's own history argues against the ceremony too — the most formal spike in the repo (399-line script, full house format) produced the *wrong* answer and locked a roadmap decision for two months because the harness baked `-p` mode in; the correct finding came from the hand-run one with controls.

Instead, one read on Bryan's machine: **`tengu_harbor` and `tengu_harbor_ledger` from the GrowthBook feature cache in the Claude config.** The allowlist is a remotely-served, per-account, disk-cached feature payload — not a static curated list — so it can differ between accounts and between runs. That read tells us whether channels are enabled for his account at all and what the live allowlist actually contains. Ten minutes, no script, and it's the only thing that would change any of the above.

---

## Stage 3 — Outreach (now with a real case)

- **Comment on [#42486](https://github.com/anthropics/claude-code/issues/42486)** — the canonical thread (#47767 and #58152 were duped into it). The corrected mechanism makes a much stronger argument than the original draft: for a non-plugin MCP server the dangerous flag is the *only* mechanism that exists, it works only in interactive mode, it isn't carried across respawn/resume/background dispatch, and there is no allowlist shape a `server:` entry could ever be listed under. Tandem is a concrete shipping product in exactly that position.
- **Do not file the docs-discrepancy report.** It rested on the refuted reading and would be filed against code that says the opposite in a shipped string.
- **Report the permission-relay filter asymmetry to Anthropic privately, not as a public issue.** The genuine finding is that relay target selection uses `findChannelEntry` (list membership) rather than `gateChannelServer`, so a channel that is allowlist-, policy-, or provider-blocked for *messages* remains eligible for *tool-approval relay*. Today it is dampened by a remote feature gate and interactive-only wiring, neither of which Tandem controls — a flag flip changes that. Use Anthropic's security reporting channel; do not describe it in a public GitHub thread, and do not build any documented Tandem install path on top of it in the meantime.
- **Do not file the #71792 correction.** My replacement diagnosis was also wrong: registration happens at the dialog's accept handler *or* silently, without a dialog, when channels are unavailable (feature off / third-party provider / org-policy-blocked). Correcting one wrong line-pointer with another is worse than silence.
- Console plugin submission: still no. It lands in `claude-community`, which is not on the channel allowlist.

Attribution footer on anything posted.

---

## Stage 4 — What this reopens (investigate later; not this PR)

Two facts found during review materially change the `plugin:`-spelling calculus I dismissed earlier, and they deserve their own design cycle:

- **`plugin.json` has a first-class `channels` field** (`{ server, displayName?, userConfig? }`), and Claude Code ships a scaffold generator for channel plugins. This is the supported authoring path; Tandem's manifest doesn't use it.
- **A `channel_enable` SDK control request registers a channel at runtime** over the stream-json control channel — under `-p --input-format stream-json`, the launcher's exact mode. It gates on `pluginSource`, requiring a marketplace plugin. That makes it the only known path to real channel push in auto-launched sessions, which could retire the supervisor's stdin wake entirely.

Together those are a genuine argument for the plugin route that didn't exist when I advised against it. They're also speculative and would need their own probe. Note them in ADR-047 as the open direction; don't act on them here.

**Its reachability is bounded by the plugin-install path, which is itself unreliable.** `channel_enable` gates on `pluginSource`, requiring a marketplace-installed plugin — and #1316's motivating field report is a user who could not complete that install: Claude Code's anti-PATH-hijack guard rejects any bare-name tool resolving under cwd, so a per-user Git plus a home-directory launch fails. Whatever Stage 4 becomes, it inherits that ceiling. `docs/spikes/plugin-delivery.md` is the current evidence.

---

## Verification

- `npm run typecheck`
- `npm test` — attention to `tests/server/launcher/supervisor.test.ts`, `tests/server/launcher/stream-json-protocol.test.ts`, `tests/cli/doctor.test.ts`, `tests/cli/setup.test.ts`. The CHANGELOG round-trip test (lesson 91) gates prose formatting.
- `npm run doctor` — confirm the push-path guidance reads correctly and leads with the plugin.
- **Manual:** `npm run dev:standalone`, then the desktop app's **Relaunch Claude** button; leave a comment in the editor and confirm the session still wakes via the supervisor's stdin turn after the flag deletion. This is the one behavioural risk in the whole change.
- No E2E unless the wizard copy edit touches a `data-testid`-covered assertion.

## Risks

- **The launcher deletion is the only behavioural change**, and its safety rests on the flag being inert under `-p`. That finding has five independent corroborations plus #1266's direct measurement, but the Relaunch Claude manual check is what confirms it end to end.
- **The allowlist is remotely served per-account**, so anything we write about it should be phrased as "as of 2.1.223 on this account," not as a permanent fact.
- **Don't re-derive gate behaviour from minified code without grepping the user-facing strings first.** That error is what this plan had to be rewritten around.
