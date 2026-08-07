# Probe: self-armed `Monitor` as a push path (P-A2, and parts of P1/P2/P3/P4)

**Run 2026-08-07, 17:05–17:24 EDT.** Real hardware, one configuration:
win32 (`MINGW64_NT-10.0-26200`), Claude Code interactive CLI, Tandem dev server
at `127.0.0.1:3479` on master `c2b9a1a0`, mode `tandem`, browser client in
Chrome driven by `claude-in-chrome`.

Evidence tags follow `connection-honesty-findings.md`: **MEASURED** =
timestamped in this run, **IN CODE** = read from the shipped source or tool
schema, **UNVERIFIED** = not tested here.

---

## P-A2 — the gate. **PASSED.**

The question was why A1's watch stopped after one event, because Track D does
not proceed if a self-armed watch cannot survive.

**Method.** Armed `Monitor` with `persistent: true` against the real SSE
pipeline — A1's proven command verbatim, plus a trailing `echo` so a dead
stream announces itself rather than going quiet:

```
curl -sN http://127.0.0.1:3479/api/events \
  | grep --line-buffered -E '"type":"(annotation:[a-zA-Z]+|chat:message)"' \
  ; echo "STREAM-ENDED: ..."
```

Events were generated as **real browser-origin writes** (chat sends in the
Tiptap client), not an `echo` emitter — MCP-origin writes would not have
produced channel events at all (`withBrowser` is the only origin the queue
forwards). A second raw `curl` captured the same stream with per-line
timestamps as ground truth.

**Result — MEASURED.** T0 = 17:05:37.

| Event | Server-stamped | Δ from T0 |
|---|---|---|
| 1 | 17:06:15 | +0:38 |
| 2 | 17:06:48 | +1:11 |
| 3 | 17:11:07 | **+5:30** |
| 4 | 17:16:07 | +10:30 |
| 5 | 17:22:07 | **+16:30** |

All five delivered. Keepalives still flowing at 17:23:21, no `STREAM-ENDED`,
watch alive until an explicit `TaskStop`.

**A2 is explained — IN CODE + MEASURED.** The `Monitor` schema defaults
`persistent` to `false` with `timeout_ms` defaulting to **300000** (5 min).
A `curl | grep` pipeline has no mechanism to exit after a single line, but it
dies silently at five minutes — which, if the one event happened to arrive
early in the window, looks exactly like "exited after one event." Event 3 above
lands at +5:30 and is the discriminator.

> This does **not** retroactively prove what A1 passed; the original call's
> arguments were not recorded. It proves the mechanism exists and that a
> persistent watch does not have the failure.

## The burst case — survives, but **drops wakes**

A2's alternate cause was the documented "monitors that produce too many events
are automatically stopped." Tested with 25 chat sends at 250 ms intervals
(~6 s), fired only after the soak completed so it could not contaminate it.

**Result — MEASURED.** The watch was **not** stopped. It rate-limited instead,
emitting explicit markers:

```
[1 events suppressed — output rate too high. Consider using TaskStop to
 restart this monitor with a more selective filter.]
[6 events suppressed — …]
```

All **25/25** reached the SSE socket (ground-truth capture). At least **7**
never became notifications. The exact tail is unmeasured — observation stopped
at burst 21.

**This is the most important result of the run**, and it cuts in favour of an
existing decision. The data was never lost — it is in the queue and a
`tandem_checkInbox` would surface it. Only the *wake* was dropped. So a wake
must be treated as best-effort and the pull path must stay authoritative,
which is exactly #1266's payload-free design. A model answering from the
notification payload would have silently missed those 7 items.

## D-2's content conflict — **CONFIRMED, MEASURED**

Not inference. Every notification carried the full message body:

```json
"payload":{"messageId":"msg_…","text":"probe event 3 of 5","replyTo":null,"anchor":null}
```

The supervisor's wake is deliberately payload-free so the pull path is the sole
authority on what the AI sees. A raw SSE frame is the opposite. Combined with
the burst result above, the duplicate-reply hazard D-2 names is real: a model
that replies from the payload never calls `checkInbox`, the item stays
unconsumed, and it is re-reported later.

## P1 — partial

- **The `ws` source EXISTS — IN CODE.** `Monitor({ws: {url, protocols}})`, one
  text frame per event, no shell. D-1's preferred transport is available.
  Tandem still has no WS wake endpoint (Hocuspocus owns :3478 and speaks the
  Y.js protocol), so this remains net-new server work.
- **`Monitor` is present and invocable** in this configuration — MEASURED.
- **Tandem's main MCP server sets no `instructions` field at all — IN CODE.**
  Only the channel shim does (`src/channel/run.ts:58`). D-1 assumed the arm
  command could live in `instructions`; that is net-new work on `server.ts`,
  and **whether Claude Code surfaces the field to the model is still
  UNVERIFIED** — it could not be tested because nothing sends one.
- **UNVERIFIED:** CLI N-2, desktop-app-started sessions, each permission mode.
  One session cannot produce those configurations.

## P2 — no prompt. MEASURED.

Arming was an ordinary silent tool call. No per-arm approval, no denial. Scoped
to this configuration's permission mode only.

## P3 — partial. MEASURED.

`TaskStop` reaped the child process tree: the monitor's `curl` disappeared and
the SSE subscriber count dropped 5→4 immediately. **UNVERIFIED:** behaviour at
*session end*, which is the case P3 actually asks about and which cannot be
observed from inside the session.

## P4 — works, and confirms the portability problem. MEASURED.

The curl+grep command succeeded on win32 — **because git-bash is installed**.
`curl` resolves to `/mingw64/bin/curl` (`C:\Program Files\Git\…`) and the shell
is `MINGW64_NT`. Neither binary exists on a stock Windows install, and
`Monitor`'s `command` runs in the same shell as the Bash tool.

The plan flagged this as a caveat. It is better read as a **blocker**: the
proven fallback is not portable, which promotes the `ws` source from
"preferred" to "required for Windows."

## E4 — negative result. MEASURED.

Server-stamped time and socket arrival matched **to the second** on every
event, and each notification reached the model inside the same turn that
generated it. The reported ~4-minute delay is **not** in the SSE fan-out and
not in `Monitor` delivery. It lies in the consumer end — the shim discarding,
the polling cadence, or the model's own turn scheduling — none of which this
run exercised.

---

## What this changes

1. **Track D's gate opens.** A persistent self-armed watch delivers over
   ≥15 min and survives a burst.
2. **`ws` moves from preferred to required**, on the strength of P4. That
   re-opens D-2's first unresolved conflict (`ws` has no shell, so no
   `${CLAUDE_CODE_SESSION_ID}` expansion, so no session-bound arbitration) —
   now with the shell option effectively off the table for Windows.
3. **Wakes are lossy by design.** Any design keyed on receiving every wake is
   wrong. The payload-free contract is load-bearing, not stylistic.
4. **D-1's `instructions` plan needs a prior step** — the server sends none
   today, and whether the host surfaces them is still unknown.

## Not run

P5 (can the shim detect it is inert) — needs a code change plus
`mcp.oninitialized`, not a probe. P1's configuration matrix and P3's
session-end case need machines/sessions this run could not produce.
