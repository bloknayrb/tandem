# Probe: the shipped self-arm transport, end to end (ADR-049's missing measurement)

**Run:** 2026-08-08, 21:45–21:52 EDT
**Claude Code:** 2.1.226 (`claude --version`) — recorded, because the prior
probe did not and an audit could not tell 2.1.212 from 2.1.223 by date alone
**Server:** commit `47979896` (`feat/track-d-self-arming`), `npm run dev:server`
**Client:** Vite dev, `http://127.0.0.1:5173`, Chrome
**OS:** win32 10.0.26200

## Why this exists

`docs/spikes/monitor-self-arm-probe.md` (P-A2) armed the **shell** source —
`curl -sN … | grep --line-buffered`. ADR-049 decision 1 then *demoted that
source as unusable on Windows* and mandated the `ws` source instead. So the
transport the product actually ships —
`Monitor({ws: {url}, persistent: true})` against `/api/wake` — had **never been
run end to end**. The `ws` source's entire standing in that probe was
"EXISTS — IN CODE", a read of the tool schema.

An audit of the Track F gate caught this. This file is the measurement.

## Method

One `Monitor` ws watch armed from a Claude Code session against
`ws://127.0.0.1:3479/api/wake`, `persistent: true`. Every event generated from
the **browser**, i.e. a genuine `withBrowser`-origin write travelling
Y.Doc → observer → queue → wake socket → host → session. Counters read from
`GET /health` between cases.

`push.subscribers` went 2 → 3 on arming, confirming the socket registered as an
external subscriber.

## Results — all five cases

| # | Case | Expected | Observed |
|---|---|---|---|
| 1 | `chat:message`, Tandem | wake, payload-free | **wake** — `{"id":"evt_1786239954466_mchb3a","type":"chat:message","timestamp":1786239954466}` |
| 2 | user highlight, Solo | *(see below)* | silent — but **vacuous**, see "The confound I caught" |
| 3 | `chat:message`, Solo | wake — chat is the always-delivered carve-out | **wake** — `{"id":"evt_1786240125250_8ua3cz","type":"chat:message",…}` |
| 4 | user **comment**, Tandem | wake | **wake** — `{"id":"evt_1786240324993_ff0sal","type":"annotation:created",…}` |
| 5 | user **comment**, Solo | **NO wake** | **silent** — `eventCount` unchanged, status bar shows `1 held` |

**Payload-free confirmed by content, not by inspection of the code.** Each
message carried a distinctive string (`WAKE PROBE B — …`). No frame contained
any of them, and none carried `documentId`. Exactly `{id, type, timestamp}`,
which is ADR-049 decision 2's frame shape.

**Soak.** First and last frames are 370,527 ms apart (6 min 11 s) with the watch
still alive and delivering. Past the 5-minute mark where a non-persistent
watch's `timeout_ms` could masquerade as success.

**The join recorded it too** (Track B-2, on real traffic, not a unit test):
`forwardCount` 0 → 3, state cycling `idle` → `awaiting-poll` → `polled`, with
measured `latencyMs` of 5062 / 4398 / 5658 ms.

## The confound I caught — case 2 proves nothing, and would have been reported as a pass

The first Solo attempt used a **highlight**. It produced no wake, which looked
like the privacy gate working. It is not evidence:
`src/server/events/observers/annotations.ts:38` early-returns
`if (ann.type !== "comment")`, so a highlight emits **no event in either mode**.
The "silence" was unconditional.

Cases 4 and 5 are the real test: the *same* action (a user comment via
Ctrl+Enter → "Send to Assistant") wakes in Tandem and is silent in Solo. Case 4
is the positive control that makes case 5 mean something.

Case 5 is also non-vacuous in the other direction: the status bar rendered
`1 held`, so the annotation demonstrably exists and is being withheld — the
silence is suppression, not a failed click.

## Slot release — checked directly, because a false alarm is cheap and a leak is not

After `TaskStop`, `push.subscribers` did **not** drop, and stayed put for 60 s —
four heartbeat intervals. That looked like a leaked slot, which would defeat the
premise of the whole track (`subscribers === 0` is the one sound negative, and
the heartbeat exists to reap exactly this).

It is not a leak. Driving the endpoint directly with `ws` from Node:

| Action | `push.subscribers` |
|---|---|
| baseline | 3 |
| attach A | 4 |
| `A.close()` (graceful) | 3 |
| attach B | 4 |
| `B._socket.destroy()` — no close frame | 3 within 2 s, still 3 at +50 s |

Both paths release. The abrupt case does not even need the heartbeat: the peer's
RST/FIN fires `close`/`error` immediately, and the heartbeat is the backstop for
a peer that vanishes without one (suspended laptop, dropped route).

What actually moved was the **baseline**. Concurrent Claude Code sessions each
hold a channel shim, and one started during the run — so the count that "failed
to drop" was three *other* consumers. Recorded because the misreading is the
natural one, and the next person watching this number will make it too.

## What this closes

- **ADR-049 decision 1** — the `ws` transport it mandates is now measured, not
  inferred from a schema.
- **ADR-049 decision 2** — payload-free frames confirmed against distinctive
  content on the wire.
- **WS-A2 / the `"external"` subscription** — the wake socket sits behind the
  queue's Solo gate, verified through the real browser → server → host path,
  with a positive control.

## What it does NOT close

- **P1's configuration matrix.** One CLI (2.1.226), one permission mode, one
  hand-launched interactive session. Says nothing about CLI N-2,
  desktop-app-started sessions, or restrictive permission modes.
- **P3's session-end case** — whether the host reaps the watch when the session
  ends cannot be observed from inside the session.
- **The plugin monitor's delivery link**, which is a different question with
  different evidence (see the Track F gate audit).

## Incidental observation, worth its own look

A **second** Claude Code session on this machine answered probes 1 and 2 in
chat, unprompted ("Received — Wake Probe B, event 1…"). `push.subscribers` was
already **2** before this watch attached. That is S1 in the flesh: concurrent
sessions each holding a channel shim, and it is the mechanism behind the
`subscribers: 2` that went unexplained for weeks. It also means `pollCount`
and `latencyMs` above include that session's polls, not only this one's — which
does not affect any conclusion here, since every wake frame was observed
directly on this watch.
