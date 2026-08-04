# Channel push under `-p --input-format stream-json`

**Run:** 2026-08-04, Windows 11, `claude` from `~/.local/bin`, Tandem server at
`127.0.0.1:3478/3479` on `fix/issue-1266-stream-json-protocol`.

**Question #1266 asked:** when Claude Code runs the way the auto-launcher spawns
it, does `--dangerously-load-development-channels server:tandem-channel` still
turn a Tandem event into a conversation turn?

**Answer: no.** And on the way to that answer the spike found a more serious
defect: the supervisor's spawn sequence deadlocks, so the launched session never
does anything at all.

---

## Findings

### 1. `system/init` is emitted *after* the first stdin turn, not before it — so the supervisor deadlocks

`supervisor.ts` waits for `{"type":"system","subtype":"init"}` on stdout and
only then writes the bootstrap user turn. The CLI does the opposite: under
`-p --input-format stream-json` it emits nothing until it has received a turn.
Neither side moves.

Measured three ways against the same binary and flags:

| Variant | Write timing | `init` seen | Assistant output |
|---|---|---|---|
| A — reproduces `supervisor.ts` exactly | on `init` (never fires) | **none in 200 s** | **none** |
| B — write immediately | t+0.015 s | t+12.7 s | t+14.6 s |
| B′ — write delayed (causality control) | t+45.0 s | **t+45.9 s** | t+48.6 s |

B′ is the load-bearing one. `init` arrived **0.87 s after** a write that was
itself held for 45 s, so `init` tracks the turn, not elapsed startup time. In
variant A the SessionStart hooks had finished responding by t+10 s and the
process then sat silent for the remaining 190 s.

`init` is also emitted **per turn**, not once per session — it appeared again
before the second response in the run below.

**Consequence:** as written, the launcher spawns Claude, waits forever, and the
user sees a running-but-inert session. Fix the ordering: write the bootstrap
turn on spawn, do not gate it on `init`.

### 2. A channel notification does not become a turn

One session, one timeline:

```
t+0.015  wrote turn 1
t+12.7   system/init
t+14.6   assistant: READY
t+15.9   result/success            <- session idle, stdin still open
t+19     chat:message event fired (see "how the event was produced")
             ... 41 s of silence, no output whatsoever ...
t+60.9   CONTROL: wrote a second turn manually
t+61.8   system/init
t+63.5   assistant: STILL-ALIVE
t+64.6   result/success
```

The manual turn at t+60.9 s is the aliveness control, and it is what makes the
silence meaningful: stdin was open and the session was listening, so this is not
"the process was dead." The channel notification specifically failed to become a
turn.

The delivery path up to Claude was verified, so the failure is isolated to the
last hop:

- The shim loaded and subscribed: `/health` `push.subscribers` went 1 → 3 while
  the child ran and fell back on exit.
- The server actually published the event: `eventCount` incremented,
  `lastEventAt` matched the probe, and the server log shows the probe text.
- A raw `curl` on `/api/events` captured the `chat:message` frame verbatim.

So Tandem → shim works. shim → Claude turn injection, under these flags, does
not.

---

## How the event was produced

Channel events come only from Y.Doc observers, and the queue drops `mcp`,
`internal`, `file-sync`, `reload` and `mode-release` origins — so no HTTP route
can fake one. The trigger connected a `HocuspocusProvider` to `CTRL_ROOM` and
added a `Y.Map('chat')` entry with `author: "user"`, which is what a browser
does; wire-origin updates carry no Tandem origin tag, so `shouldSkipChannel`
lets them through.

Two gates have to be satisfied and both are easy to trip:

- **Token must be the run's `generationId`** from `GET /api/info`.
  `onAuthenticate` rejects everything else, `CTRL_ROOM` included.
- **An `Origin` header is mandatory.** `assertAllowedOrigin` throws on a missing
  one, and the `ws` package sends none. The first attempt failed here, not on
  the token. Allowlist is `127.0.0.1:*` plus `tauri.localhost`.

Chat was chosen as the trigger because it is delivered in both Solo and Tandem
mode; an annotation event would have been withheld in Solo.

---

## What this means for #1267

The PR's premise — that a resumed session needs no bootstrap nudge because the
channel will push work to it — does not hold. Finding 2 is the plan's negative
branch, so turn delivery has to move into the supervisor: subscribe to
`events/queue.ts` in-process, respect `shouldForwardExternally` so Solo mode
does not leak, coalesce while a turn is in flight, and track idleness from
`result` messages.

Finding 1 is the more urgent one and is independent of all of that: the current
ordering cannot deliver even the *first* turn.

## Resolution — both findings fixed on #1267

**Finding 1** — the bootstrap turn is written on spawn instead of on `init`.

**Finding 2** — `supervisor.ts` now owns turn delivery. It subscribes to the
event queue as an **`"external"`** consumer, which is the load-bearing detail:
the launched Claude is a separate process, so the WS-A2 Solo gate must apply to
it exactly as it does to the SSE consumers. Subscribing as `"internal"` would
have bypassed that gate and pushed Solo-held annotations straight at a model.
`event-queue.test.ts` pins the choice; a negative control confirms that flipping
the argument reds that test.

Two shape decisions worth recording, because neither is forced by the finding:

- **The wake turn carries no event payload** — just "call `tandem_checkInbox`".
  A turn on stdin is indistinguishable from the user speaking, and making this a
  second content channel would race the pull path. Leaving `checkInbox` the only
  content route keeps `mode.ts#hideFromAI` authoritative even if the queue's
  gate were ever wrong, and it makes coalescing trivial — N events collapse to
  one nudge rather than an unbounded concatenation.
- **`document:*` events do not wake.** The channel shim forwards everything that
  clears the queue's gates, but a notification is cheap to ignore where a turn
  compels a response; waking on tab switches would conscript the session during
  ordinary navigation.

Idleness comes from the `result` envelope, with a 10-minute latch-breaker: if a
`result` were ever missed, the session would otherwise never be woken again,
silently and permanently.

This covers the auto-launcher's `-p` shape only — see below.

## Not established here

- Whether channel push works in an interactive (TTY) session. Untested — this
  spike only ran the `-p` shape the launcher uses, so "channels are broken
  generally" versus "broken under `-p` stream-json" is not settled.
- Whether a newer shim build behaves differently. The registered shim was a
  2026-06-02 build; the failure is at the shim → Claude hop, which the shim
  version could in principle affect.
- The `result.errors` field the supervisor branches on is still unconfirmed; no
  `is_error` result was produced during these runs.
