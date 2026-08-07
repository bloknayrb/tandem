# Findings: push delivery, connection honesty, and the idle-wake primitive

**Date:** 2026-08-07
**Branch:** `fix/hand-launched-push-honesty` (PR #1316)
**Tandem:** 0.20.1 · **Claude Code:** 2.1.223 · **Platform:** win32/x64 (Windows 11)
**Related:** `docs/spikes/plugin-delivery.md` (install-path findings), `docs/spikes/channel-push-stream-json.md` (the measure-don't-assume precedent)

## How to read this

Evidence strength is stated per finding, because several conclusions in this area
have already been wrong twice — once from documentation that described a different
runtime, once from a subscriber count with two readings.

| Tag | Means |
|---|---|
| **PROVEN** | Observed live, end to end, in this runtime |
| **MEASURED** | A number read off a running system |
| **IN CODE** | Read from source; not exercised |
| **DOCUMENTED** | From official docs; not exercised here |
| **UNVERIFIED** | Believed, with no evidence yet |

**A tag is not a guarantee — see A3.** That finding was tagged MEASURED, the
second-strongest tag here, and was false. The number was real; the inference from
it was not, because it was sampled without a baseline against an assumed-empty
starting state, and the datum that contradicted the story (the count *rising*
after the process died) was in the original output and read past. Two rules
learned the hard way and now applied throughout: **measure a baseline before
changing one variable**, and **when a number has more than one possible holder,
"MEASURED" describes the reading, not the conclusion drawn from it.**

---

## A. Delivery

### A1 — An idle Claude Code session CAN be woken with zero install. **PROVEN**

A session armed a `Monitor` tool watch on Tandem's SSE stream:

```
curl -sN http://127.0.0.1:3479/api/events \
  | grep --line-buffered -E '"type":"(annotation:[a-zA-Z]+|chat:message)"'
```

`/health` then reported `subscribers: 1`. The session ended its turn (genuinely
idle). The user typed a chat message in the Tandem UI. The event arrived as a
notification, the session called `tandem_checkInbox`, and replied via
`tandem_reply` — visible in the user's chat panel.

```
data: {"id":"evt_1786112909823_im97ff","type":"chat:message",
       "timestamp":1786112909823,"documentId":"welcome-2z5u99",
       "payload":{"messageId":"msg_1786112909822_qoe2tz","text":"testing 123",...}}
```

No plugin, no marketplace entry, no git, no `npx` on PATH, no
`--dangerously-load-development-channels`. **This routes around every install
failure mode in `plugin-delivery.md` F1 and the macOS exit-127 field report.**

This contradicts an earlier conclusion in this investigation that the plugin
monitor is the only proven idle-wake path. The distinction missed at the time:
a process a *hook* spawns has nothing reading its stdout, but a process the
**host** runs via the `Monitor` tool is read by the host by construction. The
`Monitor` tool description states it directly — events "are not replies from the
user, even if one lands while you're waiting for the user to answer a question."

### A2 — The armed watch exited after a single event. **MEASURED, unexplained**

The monitor task reported "stream ended" immediately after delivering the one
event, with no error in its output file. `persistent` was `false` with a 900 s
timeout, so neither should have ended it. Until explained, A1 is proven for the
*first* event only. **This is the first thing any design on top of A1 must
settle** — a watch that self-disarms after one wake is not a push path.

### A3 — ~~Dead SSE consumers are never reaped~~ — **RETRACTED 2026-08-07. They are.**

**This finding was wrong.** It was tagged MEASURED — the strongest tag in this
document — and a whole stage of design rested on it. Recorded here in full
rather than deleted, because how it survived is the useful part.

Re-measured with a controlled baseline and one variable:

```
baseline                      subscribers = 0
arm one curl on /api/events   subscribers = 1
SIGKILL the consumer          subscribers = 0   within 12s
                              subscribers = 0   stable for 60s
```

`req.on("close")` (`events/sse.ts:74-77`) fires correctly when the peer dies.
That, not the keepalive write, is the canonical SSE reaping path — and the
original analysis never asked why `close` had not fired, because it had already
settled on a mechanism.

**The tell was in the original data.** The count went **1 → 2 *after* the
consumer died.** A leak holds steady at 1; it does not climb. Two live
subscribers explains 2 exactly, and the explanation arrived later: the channel
shim is default-on (A7), and there were two terminal Claude sessions open, each
running one. The owner asked at the start of this investigation whether two
concurrent sessions could account for the number. They could, and did.

**What was really being measured:** a process-global count with at least three
possible holders (shim, supervisor, dev monitor), sampled without a baseline,
against an assumed-empty starting state.

**Consequences of the retraction:** the orphan argument in C2 is void; any design
step whose mechanism was "the reaper drives the count to zero and the surface
appears by itself" needs a different mechanism (reaping is faster and more
reliable than assumed, so the direction is favourable); and the "Implications for
PR #1316" section below is corrected in place.

### A4 — `subscribers` is process-global, not per-session. **IN CODE**

`getSubscriberCount()` returns `externalSubscribers.size` — one flat set
(`events/queue.ts:317-319`). With several concurrent sessions it cannot say
*which* session has push. Direction matters:

| Reading | Meaning with N sessions | Sound? |
|---|---|---|
| `0` | nothing anywhere is delivering | **yes** |
| `>= 1` | *something* is attached; possibly not the session that will act | **no** |

### A5 — The server cannot distinguish a live consumer from an inert one. **IN CODE, by design**

`events/push-liveness.ts:11-15`: a shim whose host never negotiated the
`claude/channel` capability still connects, still receives, still heartbeats,
and discards everything. The decision is client-side and nothing comes back. Any
server-side "push capability" detector is structurally impossible.

### A6 — The delivery event writes no observable signal. **IN CODE**

Outcome-based detection ("did Claude actually react?") is the only formulation
robust to A5. But `tandem_checkInbox` — the event that *is* delivery, since the
item enters the model's context — writes no presence, no stamp, nothing
(`mcp/awareness.ts:178-192`, wrapped in `withStructuredErrors` / `withErrorBoundary` only — notably NOT `withTypingPresence`). Presence
today comes from `tandem_status` plus the five `withTypingPresence` tools, which
are the wrong signals to key on. The stamp is trivial to add; it just does not
exist yet.

**Caveat added 2026-08-07, before anyone builds this:** a bare checkInbox stamp
measures *polling*, not delivery. `SKILL.md` instructs polling every 2–3 tool
calls regardless of push state, so a busy unarmed session stamps continuously —
and that is exactly the session that needs to be told push is missing — while an
armed session idle because nothing happened looks stale. It is also not
per-session: `claudeSessionId` is absent for the direct-HTTP entry
(`sessions/context.ts:38-48`) and `mcpSessionId` is absent on MCP `2026-07-28`
(`:50-58`). The useful signal is the **join**: `getPushConsumerLiveness().lastEventAt`
(`push-liveness.ts:52`) already records "an event reached a consumer at T"; the
δ against a checkInbox stamp at T′ is delivery latency, and is the only cheap
in-product measurement of E4 anyone has proposed. Also reconcile with
`wasEmittedViaChannel` / `alreadyPushed` (`awareness.ts#buildInbox`, `queue.ts#wasEmittedViaChannel`),
which is already a per-item, subscriber-gated record of "this was pushed."

### A7 — The channel shim is default-on and inert. **VERIFIED 2026-08-07**

`shouldRegisterChannelShim` (`integrations/apply.ts:1213-1221`) returns true for
Claude Code whenever the channel bundle exists, with no override on either write
path. `runChannel` then calls `startEventBridge` unconditionally
(`channel/run.ts:207`) — it never asks whether the host negotiated
`claude/channel`, which requires `--dangerously-load-development-channels`.

It survives non-negotiation *silently*: the SDK's `assertNotificationCapability`
(`server/index.js:162-181`) has no case for `notifications/claude/channel`, so
delivery never throws, so `sse-consumer.ts:484-489` — which WOULD rethrow and
tear the stream down — never fires, and the stream is
never torn down, and the shim holds its subscriber slot for the life of the
session.

**So for every set-up user, something is attached and delivering nothing** — and
since `subscribers === 0` is the only sound negative (A5), that inert consumer
suppresses every signal keyed on the count. This is the mainstream failure. The
earlier framing of this investigation — "nothing is attached" — described a
minority.

It also explains A3's phantom `2`: two terminal sessions, two shims.

### A8 — A capability report cannot stand in for delivery. **VERIFIED 2026-08-07**

The obvious fix for A7 — have each consumer report whether its host negotiated
the capability — does not work, because the count is process-global (A4) and the
report is wrong in *both* directions on shipping defaults:

- The **supervisor** subscribes `"external"` (`supervisor.ts:110`) but is not an
  SSE consumer, so it would never report, and would read as not-delivering while
  its stdin wakes work correctly (#1266).
- The **launcher's** `CLAUDE_STREAM_JSON_FLAGS` (`contract.ts:187-196`) *does*
  pass the channel flag, so its shim negotiates and would report capable — yet
  `channel-push-stream-json.md` measured that under exactly those flags the
  notification never becomes a turn. The one configuration proven not to deliver
  is the one such a signal would certify.

Negotiation is not delivery. A5 stands.

Separately, and worth recording because it cost a design revision:
`getClientCapabilities()` cannot be read where it would need to be. `connect()`
only starts the transport; `_clientCapabilities` is assigned in
`Server._oninitialize`, which runs when the client's `initialize` arrives over
stdin — strictly after `connect()` resolves. Reading it at `run.ts:207` returns
`undefined` every time. `mcp.oninitialized` is the hook that fires late enough.

---

## B. Connection honesty (the UI half)

### B1 — The AI pill stays green when the server is unreachable. **PROVEN**

> **Fixed 2026-08-07 (PR #1324).** Everything below describes the code as it
> stood before that PR; the identifiers it quotes no longer exist. See the
> correction at the end of this section.

`hooks/useAiReadiness.svelte.ts`, in `readHasSession`:

```ts
if (fresh.hasSession !== null) mcpSessionActive = fresh.hasSession;
```

`fetchHealth()` returned `unknown()` (with `hasSession: null`) for **two
different situations**:

1. a successful response whose field was **redacted** (non-loopback caller), and
2. the fetch **failing outright** because the server is gone.

Case 1 must not demote — that is what the comment above the line reasons about,
correctly. Case 2 is positive evidence the server is dead, and took the same
branch. So `mcpSessionActive` held its last value indefinitely.

**Correction (2026-08-07).** `unknown()` is gone, replaced by a `HealthRead`
union that discriminates on a narrower question than the one stated above: not
"did something answer" but *did OUR server answer*. `makeHealthHandler` has no
failure branch — it unconditionally sends a 200 carrying valid JSON — so on this
route a non-OK status or an unparseable body is not the server being unwell, it
is evidence that what is on the port is not Tandem. Those now accrue a strike
alongside an outright throw and a body-stream error; two consecutive strikes
**from the poll path** demote. Redaction remains what it always was and is the
one case that never demotes: null FIELDS on an answered read. The read is also
time-bounded now, because an unbounded fetch made "wedged" indistinguishable
from "healthy" — the same floorless fail-safe wearing a different hat.

Observed: server killed and confirmed down by six consecutive probes over 30 s;
the app showed its "We've lost the connection to the Tandem server" banner and
`Disconnected — check that the server is running` **while the same status bar
read `AI connected`**.

**This is a stronger version of the complaint that opened this investigation,
and it is independent of push entirely.** It needs no MCP subtlety and no
multi-session setup: close the server and the product asserts a connection it
can see is gone.

### B2 — Two connection signals disagree on screen with no reconciliation. **PROVEN**

The disconnection banner derives from document-sync (Hocuspocus); the AI pill
derives from `/health`. `useAiReadiness`'s docblock is explicit that readiness
"keys on these connection facts — NOT the document-sync connection", and that
separation is deliberate and correct in general. But it means the client can hold
positive evidence of disconnection in one signal and assert connectedness in the
other, simultaneously, in the same status bar.

### B3 — The send notice fired the wrong branch. **PROVEN**

At send time `/health` reported `hasSession: false`, so
`addressedAiNotice()` took the `no-agent` arm (`status/addressed-ai-notice.ts:57-61`)
and rendered *"Message saved — no AI is connected yet. It'll be seen when AI
connects."* Push **was** attached and the message reached a model within a second.

The branch ordering treats an MCP session as a precondition for delivery
(rule 2 in that file's docblock). A `Monitor`-armed watch (A1) delivers with no
MCP session at all, so the state is now reachable. It was not when the notice
was written.

### B4 — Tray copy does not survive becoming history. **PROVEN**

The activity tray is deliberately persisted and surfaces events from previous
sessions (`components/activityCenter.ts:23-25`). The copy is present/future
tense — "no AI is connected **yet** … it'll be seen when AI connects" — so a
resolved entry still reads as live status. Observed three minutes after the AI
had connected *and already replied*, sitting next to a green pill.

**Correction (2026-08-07):** this note originally said PR #1316's new notice
"inherits this exactly." It does not, and the difference is the whole mechanism.
`useNotifications` prunes only `severity: "info"` entries, at
`ACTIVITY_INFO_TTL_MS` (5 min, `shared/constants.ts:269`); warnings and errors
persist until dismissed. #1316's `no-push` notice is `info` (`App.svelte`, the `no-push` branch)
and therefore self-erases. The `no-agent` notice is `warning`
(`App.svelte`, the `no-agent` branch) and never expires — **that is the instance actually
observed**, and the only one needing a copy fix.

Fixed by rewording the observation to past tense while leaving the promise in
future tense, since the promise stays true: the item really is pending until
seen.

---

## C. Mechanism feasibility

### C1 — Tandem cannot inject a monitor into a running session. **DOCUMENTED**

Plugin monitors are declared in the plugin manifest and started by the plugin
host at session start or on plugin reload. Nothing Tandem does at runtime adds
one to a session already going.

### C2 — A hook that SPAWNS a monitor is actively harmful. **IN CODE**

Not merely inert. The spawned process connects to `/api/events`, which subscribes
it `"external"` (`events/sse.ts:53`), so:

1. `subscribers` goes positive → #1316's notice is suppressed and the pill keeps
   its plain copy;
2. events stamp `alreadyPushed` (`events/queue.ts:261`) — a forged "a consumer
   got this" fed to the model that didn't;
3. `PostToolUse` fires per matched call, so without singleton logic each Tandem
   interaction adds another subscriber.

**Amended 2026-08-07:** point 3 originally read "another orphan (A3 shows they
are never reaped)." A3 is retracted — dead consumers *are* reaped promptly — so
the orphan-accumulation argument is void and point 3 is now only about
duplicate live subscribers, which singleton logic would fix. Points 1 and 2
stand on their own and are the load-bearing ones: they hold even for a single,
perfectly-reaped spawned process. The conclusion (a hook that spawns a monitor
is harmful) is unchanged; one of its three supports was not real.

### C3 — No external process can wake an idle session — **except via the host's own Monitor tool.** **DOCUMENTED + PROVEN**

Documentation search found no IPC surface, watched file, socket, or notification
API; `--resume`/`--continue` start a new process rather than poking a running
one; hooks are exit-based request/response with no long-lived stream contract.
**But A1 proves the `Monitor` tool is a working idle-wake path**, because the
host runs the process and reads its output. The documented gap is about
*external* code; the Monitor tool is not external.

### C4 — Hook capabilities. **DOCUMENTED**

- `PostToolUse` **can** match MCP tools by regex (`mcp__tandem__.*`).
- `PostToolUse` **can** inject into Claude's context via
  `hookSpecificOutput.additionalContext`, or exit 2 + stderr.
- `Stop` **can** block with a reason and force continuation.
- `Stop` has **no matcher support** — it fires on every turn end of every session
  on the machine.
- ⚠️ **Sources conflict on Stop-hook loop protection.** One documentation pass
  quoted a `stop_hook_active` field with a code sample and an 8-block override;
  another reported the current reference documents no such field. **Unresolved.**
  Either way an implementation must carry its own block-once guard, or a
  pending-items session cannot end.

### C5 — The skill is a versioned, auto-refreshing instruction channel. **IN CODE**

`SKILL_CONTENT` (`src/cli/skill-content.ts`) → `~/.claude/skills/tandem/SKILL.md`
via `installSkill()` (`integrations/apply.ts:1083-1089`), version-stamped and
refreshed on **every server boot** by `refreshSkillIfStale()`
(`apply.ts:1131-1178`, called from `server/index.ts:146-147`). New instructions
reach every existing install with no user action and no plugin. It is
**advisory** — Claude may not act on it.

### C6 — A `PostToolUse` hook on Tandem tools is dominated by a server-side response piggyback. **IN CODE**

Both fire on "Claude touched a Tandem tool". The hook must then call back into
Tandem to learn what is pending; the piggyback puts the sentence *in* the tool
result. The piggyback needs no config write, no per-call process spawn, no
hook-schema version risk, gets mode-gating free at the source
(`mode.ts:84-89`), works for every MCP client, and ships on Tandem's own release
cadence.

### C7 — Hooks written into `~/.claude/settings.json` are rejected. **IN CODE**

Machine-wide mutation firing in every session forever, and
`src/cli/uninstall-scrub.ts` runs automatically **only** on Windows NSIS
uninstall — npm and macOS users would carry an orphaned hook indefinitely. If
hooks ship at all, they ship inside the plugin, where uninstall is
`claude plugin remove`.

### C8 — Self-healing plugin install is circular. **IN CODE**

Whatever vehicle delivers the hook dominates the hook: ship it in the plugin (the
plugin is already installed, with a real monitor), write it to user settings
(C7), or write it at `tandem setup` with consent (then just install the plugin
with that consent). What survives is a **consented CTA**, not a side effect.

### C9 — `/reload-plugins` starts a freshly installed plugin's monitors mid-session. **DOCUMENTED**

Monitors start "at session start **and on plugin reload**". There is **no
programmatic invocation path** — it is a command a human types. This improves
CTA copy from "install and restart Claude" to "install, then run
`/reload-plugins`". Wants one confirmation that it holds for first-install and
not only re-loads.

---

## D. Durability

### D1 — Chat history does not survive an ungraceful server exit. **PROVEN**

The server was killed with `taskkill /F` (no graceful shutdown). On reconnect the
chat panel read "No messages yet" — both the user's message and the assistant's
reply were gone. Annotations survived intact (`tandem_getAnnotations` returned
`count: 3, notesExcluded: 1`, all four present).

Consistent with the documented contract — the shutdown disk flush and
`saveCurrentSession` make *graceful* restarts lossless — but the crash path is a
real user path, and chat is the one surface with no on-disk backing of its own.
Not investigated further.

---

## E. Environment facts worth keeping

- **E1.** The Tandem plugin is **not installed** on this machine
  (`~/.claude/settings.json` `enabledPlugins` has no tandem entry; only
  `wt-local` is registered). Any subscriber observed here came from the channel
  shim, the supervisor, or a hand-armed watch — never a plugin monitor.
- **E2.** `npm run dev:standalone` spawned its own monitor
  (`scripts/dev-standalone.mjs`), which registered as a subscriber with no
  Claude behind it — a live instance of A5's inert consumer, in a dev default,
  masking every count-keyed feature for exactly the people building them.
  **Fixed 2026-08-07:** the spawn is removed and its test inverted to pin the
  removal. Run `npx tsx src/monitor/index.ts` by hand to test the monitor.
- **E3.** Field reports stand: Windows `claude plugin install` blocked by the
  cwd guard when git sits under `$HOME`; macOS plugin monitor failing exit 127 on
  every session because `npx` is unresolvable from a non-login `sh -c`.
- **E4.** Unexplained and untouched: a tester measured **~4 minutes** from send to
  surface. No mechanism proposed here accounts for it.

---

## What is NOT established

1. **Whether `Monitor` is available in every session and CLI version.** It is
   present in this one. If absent, any design keyed on A1 silently no-ops.
2. **Why the watch exited after one event (A2).** Disqualifying if inherent.
3. **A rate-limit-safe filter.** "Monitors that produce too many events are
   automatically stopped"; Tandem's raw stream includes selection and document
   churn. The `isWakeWorthy` filter (`launcher/supervisor.ts:128-130`) is the
   candidate but was not stress-tested.
4. **Whether a watch disarms cleanly at session end.** Downgraded by A3's
   retraction: reaping works, so a watch whose process dies is cleaned up
   promptly. What remains open is whether the *host* kills the watch's process
   tree at all — an orphaned `curl` with a dead parent is still a live consumer,
   and a live consumer is not a reaping problem.
5. **Stop-hook loop protection** (C4).
6. **Whether `hasSession` survives the MCP `2026-07-28` revision.** It is scoped
   to handshake-era clients (`mcp/routes/health.ts:8-14`, #1249); every branch
   keyed on it inherits that expiry, including #1316's.

---

## Implications for PR #1316

**Rewritten 2026-08-07.** The original version of this section rested on A3
(retracted) and mis-scoped B4. What actually holds:

The PR's trigger (`pushDelivery === "none"`, a confirmed zero) is *sound* — a
zero really does mean nothing is attached. But **A7 makes it largely
unreachable**: the channel shim is registered by default, connects
unconditionally, and holds `subscribers >= 1` while discarding every
notification, because the host never negotiated `claude/channel`. For a
set-up user in steady state the notice cannot fire.

It is not unreachable for everyone, and the exceptions are the interesting
population:

- **Start order.** The shim exhausts `CHANNEL_MAX_RETRIES` (5, ~30s of backoff)
  and `process.exit(1)`s (`sse-consumer.ts:184-206`). A user who starts Claude
  Code *before* Tandem loses it permanently for that session → zero → the notice
  fires, correctly.
- Configs written before default-on, and Claude Desktop targets (which never get
  a shim — `apply.ts` returns `false` for them).

  **Closed 2026-08-07 for the Claude Desktop half (#1299).** That row was the
  reporter's actual configuration, and the reason it deserved its own fix rather
  than riding on the runtime notice: for `claude-desktop` push is not absent by
  accident, it is absent *by decision, at wizard time*, before any of the runtime
  signals above exist. A decision already made is not something to detect later.

  The predicate moved from a bare `targetKind === "claude-desktop"` inside
  `shouldRegisterChannelShim` to `targetPushSupport` in
  `shared/integrations/contract.ts`, so the gate that WITHHOLDS the transport and
  the sentence that EXPLAINS it read the same fact. The wizard's Done screen
  renders a per-row line off it (`integration-wizard-push-support-{id}`).

  Two constraints from this document are load-bearing in that copy. It renders
  only on `"none"` — the sound half (A4/A5) — with no affirmative counterpart,
  because `"possible"` means a transport exists and A7 is precisely the case
  where one exists and delivers nothing. And it is **per row**, not a banner: in
  a mixed selection `whatsNext` is not `stdio-only`, so the screen-level
  push-mode block renders its Claude Code copy, and a Desktop user reading a
  banner would take reassurance meant for the other client.

  A "wizard opt-out" was listed here in an earlier revision and is **withdrawn**:
  the wizard path passes no override at all, and the only override plumbed
  (`cli/setup.ts`, `apply.ts`) comes from `--with-channel-shim`, which resolves
  to `true` or `undefined` — never `false`. There is no code path by which a
  user declines the shim. An unciteable population is the wrong thing to have in
  the section that justifies shipping.

That start-order case is the shape of the field reports, which is why the PR is
still worth shipping as-is. What it does *not* do is catch the mainstream
failure, where something is attached and inert.

Also bearing on it:

- **B3** — a sibling branch producing wrong copy in a state the PR made
  reachable.
- **B4** — applies to the `no-agent` notice (`warning`, never pruned), **not**
  to the PR's own new `no-push` notice (`info`, self-erases at 5 min). The
  original claim that it applied "verbatim" was wrong; see B4 above.

**B1 was the largest single honesty defect found and is independent of push.
PR #1316 did not address it; PR #1324 does — see the correction under B1.**
