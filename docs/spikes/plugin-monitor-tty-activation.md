# Spike: do plugin monitors activate in a TTY session?

**Date:** 2026-08-09
**Claude Code:** `2.1.226 (Claude Code)`
**Platform:** win32/x64 (Windows 11)
**Probe:** `scripts/spikes/probe-monitor-tty.py` (committed alongside this note)
**Fills:** the one blank cell in [`plugin-delivery.md`](./plugin-delivery.md) F3
**Answers:** the delivery half of ADR-028's reopen gate, and P3 for the forced-teardown case only. **Not** P1 — its open matrix is CLI N-2, desktop-started sessions and permission modes, and this run varied none of them.

## Why

Every prior probe of `experimental.monitors[]` ran headless, because no harness we
had could produce a TTY — and monitors turn out to be armed from an Ink `useEffect`
in the interactive UI, so headless was the one mode guaranteed to show nothing. The
F3 table therefore had four nulls and one empty cell, and the empty cell was the
only one that mattered.

`winpty(1)` refuses when its own stdin is not a tty, which is why this went untested
for so long. Driving ConPTY directly through `pywinpty` sidesteps that.

## Method

A throwaway plugin whose monitor writes a marker file on start and then prints one
line every 6 s:

```jsonc
{
  "name": "monprobe",
  "experimental": {
    "monitors": [{
      "name": "probe",
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/emit.mjs\"",
      "description": "Tandem monitor activation probe",
      "when": "always"
    }]
  }
}
```

Arming is observed through the **marker file**, not through the terminal — no ANSI
parsing, and no dependence on the model choosing to react. Delivery is observed
separately in the PTY capture. Loaded with `--plugin-dir`, cwd the Tandem repo,
**no user input sent at any point**.

## Findings

### F1 — Monitors arm in a TTY session. **MEASURED.**

```
ARMED 2026-08-09T05:15:24.705Z cwd=C:\Users\blokn\Documents\Github\tandem root=<unset>
EMIT 1 05:15:30 … EMIT 7 05:16:06      ← elided; the emitter writes full ISO timestamps
```

**Corrected 2026-08-09, same day:** the first version of this line read "the session was
spawned at 05:15:2x and the monitor was running within a second." Both halves were
reconstructed rather than recorded — the probe printed no clock. A review flagged the
resulting tension with "boot eats 15–20 s"; adding the clock resolved it against me. A
fourth run, the first with both timestamps recorded:

```
spawn at      2026-08-09T06:11:49.761+00:00
ARMED         2026-08-09T06:12:06.152Z        ← 16.4 s later
terminated at 2026-08-09T06:12:29.981+00:00
```

So the monitor arms at **interactive-UI mount, not process start** — which is what the
mechanism predicts, since arming is a `useEffect` in the Ink component tree. Nothing about
activation changes; what changes is that an event in the first ~16 s of a session has
nothing listening for it. n=1 on this figure, on one machine.

### F2 — Every delivered event produced a turn in the 45 s run. **MEASURED.**

From the capture, in a session that received no prompt:

```
● Monitor event: "Tandem monitor activation probe"
● PROBE-EVENT-3 delivered. Three for three at ~6s intervals — the monitor
  wake path is holding steady. No action needed.
✻ Worked for 2s · 1 monitor still running
```

Four consecutive events, four turns, no drops. Events 5 and 6 fired inside the window and
event 7 within a second of the deadline; no turn for any of them had rendered by cutoff,
which the run below shows is expected. They are not drops — but note this is the honest
reading, not the first one written here, which blamed a teardown that had not started yet.

**Three runs, and the second and third are the interesting ones.** A 22 s run armed
the monitor and showed `· 1 monitor` in the statusline, but closed before any turn
rendered. A 60 s run armed, emitted five events, and spent its entire capture — 45 kB
of it — in `thinking with high effort`, having received no input other than the
monitor's output, without emitting a response before cutoff.

*Delivery* was reliable across these runs; the *visible response* was not prompt. Do not
read that as "the wake is reliable" in general — `skills/tandem/SKILL.md` says wakes are
best-effort and can be dropped, and the rate limiter below is one way they are.

A plausible mechanism, **UNVERIFIED**: a wake is a full model turn, so time-to-surface
should track the session's effort setting. No low-effort comparison run was made, n=1, and
nothing here reaches the ~4-minute scale — run 3 cut off under 60 s. **It is still the
first mechanism anyone has proposed for the unexplained ~4-minute field report (E4)**,
which is why it is recorded at all; E4's own effort setting is unknown.

A corollary for probe design: "no event text in the capture" is not a delivery null.
Check whether the session is mid-turn first.

This is the claim ADR-028's gate was waiting on. Combined with the `P-A2` soak
(`monitor-self-arm-probe.md`), which measured the same thing for a *tool-armed*
monitor, both arming triggers are now covered.

### F3 — `--plugin-dir` is NOT inert for monitors. **MEASURED — corrects an earlier note.**

`plugin-delivery.md` F3 flagged its `--plugin-dir` rows as confounded, unable to
separate "monitors don't fire headless" from "the plugin never loaded". This run
loaded via `--plugin-dir` and the monitor fired, so the load path was never the
variable. **The confound resolves in favour of "monitors don't fire headless."**

### F4 — No orphan, for the forced-teardown case. **MEASURED.**

The load-bearing evidence is a process scan, not a clock: after all three runs, a
`Win32_Process` query for `node.exe` with `emit.mjs` in its command line returned **zero**,
and each run's marker file stops rather than continuing to grow. The host tears the monitor
down with the session.

> Two caveats on this one. The scan is a **manual step the probe does not perform** — run it
> yourself after the harness exits. And this measures `terminate(force=True)`, the harsher
> case; **a clean `/exit` was not tested**, which is the case P3 actually asks about. An
> earlier draft here quoted a last emission of 05:16:06 against a ~05:16:05 terminate, which
> reads as the child outliving the parent — the opposite of the finding. Neither timestamp
> was recoverable from any recorded artefact, because the probe printed no clock.

> **Consequence:** the plan's contingent requirement — "orphans persist → server-side
> max-lifetime cap becomes mandatory" — does not apply. No cap is needed.

### F5 — `CLAUDE_PLUGIN_ROOT` is substituted, but not exported. **MEASURED.**

The `${CLAUDE_PLUGIN_ROOT}` in the *command string* resolved (node found the script),
yet the child process saw `process.env.CLAUDE_PLUGIN_ROOT` as **unset**. Substitution
happens at command construction. A monitor script must not read it from the
environment.

### F6 — `when: "on-skill-invoke:<skill>"` works, and the name must be plugin-qualified. **MEASURED.**

**Probe:** `scripts/spikes/probe-skill-arm-trigger.py`, same ConPTY harness. Two phases,
because one phase cannot separate "correctly deferred" from "ignored in a way that
disables the monitor": idle first (neither may arm), then dispatch (one must).

Two monitors were declared differing *only* in the name form, so a single run decides it:

| `when` | Idle | After `/armcheck` |
|---|---|---|
| `on-skill-invoke:armcheck` | not armed | **not armed** |
| `on-skill-invoke:monprobe:armcheck` | not armed | **ARMED** |

Reproduced twice. Arming landed ~13 s after dispatch. The skill itself demonstrably ran
in both runs — the capture shows the session replying `ACK`, the skill's entire body — so
the bare-name null is a name-matching result, not a dispatch failure.

**So the matched string is `plugin:skill`, not `skill`.** The bare form fails silently:
valid manifest, no error, monitor simply never arms. For Tandem the value is
`on-skill-invoke:tandem:tandem` — the plugin is `tandem` and its auto-loaded `skills/`
folder carries a skill also named `tandem`.

**Why this matters more than it looks.** It is what makes keeping the monitor cheap. The
standing objection to `experimental.monitors` was never that it fails — it is that
`when: "always"` arms it in every session the plugin is enabled in, including ones with
nothing to do with Tandem, which is how a Tandem bug becomes noise in somebody's unrelated
work. `on-skill-invoke` retires that objection without giving up the path: the monitor
arms at the moment Tandem becomes relevant to the session and never before. F7 is the
condition on collecting that: the trigger has to be reachable by the name a user types.

### F7 — a same-named non-plugin skill wins the bare dispatch, and the monitor does not arm. **MEASURED.**

F6 leaves a hazard, and it is not hypothetical in configuration: Tandem ships the `tandem`
skill **twice**. The plugin auto-loads `skills/tandem/` from the plugin root, and
`tandem setup --apply` installs `~/.claude/skills/tandem/SKILL.md`. Same name, two sources,
and the arm trigger can only bind to the plugin's copy.

**Probe:** `scripts/spikes/probe-skill-name-collision.py`. One plugin declaring
`on-skill-invoke:monprobe:armcheck` plus its own `skills/armcheck/`, and a rival
`armcheck` from a non-plugin source. The two `SKILL.md` bodies ask for different one-word
replies, so the capture says which copy actually ran even when nothing arms.

Both appear in the picker, and the qualified one is visibly labelled:

```
/armcheck                    Probe skill for the plugin-vs-non-plugin name collision test…
/monprobe:armcheck  (monprobe) Probe skill for the plugin-vs-non-plugin name collision…
```

Typing the bare `/armcheck` selected the **non-plugin** copy — the capture shows the
session replying `RIVALCOPY`, never `PLUGINCOPY` — and the marker file never appeared.
Reproduced twice.

**So the silent failure of F6 is reachable through ordinary use.** A user with both the
plugin and a `tandem setup --apply` install sees `/tandem` and `/tandem:tandem`, and the
obvious one is the one that does not arm the monitor. `on-skill-invoke` alone therefore
does **not** make the plugin monitor work for our own shipped configuration; #1354 has to
resolve the double-install too, not just correct the trigger string.

> **One substitution, stated.** The rival copy was placed in the session cwd's
> `.claude/skills/` rather than in `~/.claude/skills/`, to avoid writing into the
> operator's real Claude config. What is being measured is plugin-vs-non-plugin name
> resolution, which is the axis the `plugin:skill` qualifier exists on; user-level versus
> project-level precedence is a different axis and is not what decides this.

### F8 — declaring BOTH name forms catches either copy. **MEASURED.**

F7 looks like it forces a product-level fix: if the bare name reaches the non-plugin copy,
the plugin's trigger can never see it. That is wrong, and the reason is in the matcher.
From the same binary:

```js
pQs.subscribe((s) => o4l(enabledPlugins, (a) => a.when === `on-skill-invoke:${s}`, …))
```

Plain string equality against the name the dispatcher publishes — there is no
plugin-scoping in the comparison itself. So a manifest may declare the unqualified form
and match a dispatch from any source that publishes it.

**Probe:** the same `probe-skill-name-collision.py`, extended to declare **two** monitors
differing only in `when` (`on-skill-invoke:armcheck` and
`on-skill-invoke:monprobe:armcheck`), then dispatch the bare name once.

| `when` | Idle | After bare `/armcheck` |
|---|---|---|
| `on-skill-invoke:armcheck` | not armed | **ARMED** |
| `on-skill-invoke:monprobe:armcheck` | not armed | not armed |

`bare /armcheck ran: non-plugin copy` in the same run, so the arming monitor was matched
by a dispatch of the **non-plugin** skill. CC 2.1.226, win32, one run plus F7's two.

**This does not contradict F6, and the distinction matters.** F6 dispatched the *plugin's*
copy, which publishes `monprobe:armcheck`; the unqualified monitor correctly did not match
it. F7 dispatched the non-plugin copy with only the qualified monitor declared, so nothing
matched. F8 declares both. The three results are one rule: **the published name is
qualified iff the dispatched skill came from a plugin, and `when` must equal it exactly.**

So the double-install is a **manifest** problem — two entries, same command, distinct
`name`s — not a product one. The cost is that if one session dispatches both names, both
monitors arm and every event is delivered twice; the host's dedupe key is
`pluginName:monitorName`, so it cannot collapse them. There is no session key available to
a monitor for a singleton lock (F5: `CLAUDE_PLUGIN_ROOT` is not in the child env).

> **Probe gotcha that cost a run, and would cost yours.** Workspace trust is activation
> gate #4, and a fixture cwd that has never been trusted parks the session on *"Is this a
> project you trust?"* — the UI never mounts, no monitor arms, and the capture shows only
> the prompt. It reads exactly like a negative result. Worse, a probe that blind-writes
> Enter into that prompt **answers** it. Trust the fixture directory deliberately, or reuse
> one already trusted, and check the capture for the prompt before believing a null.

### F9 — a monitor that exits is never respawned, whatever its exit code. **MEASURED.**

**Probe:** `scripts/spikes/probe-monitor-respawn.py`. Two `when: "always"` monitors,
identical but for their exit code, each appending a line to its own marker before
exiting — so the marker's line count *is* the spawn count.

| exit code | starts in 120 s |
|---|---|
| `0` | **1** |
| `1` | **1** |

Both armed once and stayed dead. No throttled retry, no backoff, nothing.

**Two things follow, in opposite directions.**

*It enables the singleton.* A monitor that finds another already serving this Tandem
can stand down by exiting, and the host will not spin it back up. That is the
mechanical precondition for "one monitor across N sessions", and it holds.

*It falsifies a comment our own recovery path rests on.* `src/monitor/run.ts`'s EPIPE
handler said "exit 1 so the plugin host respawns us with a fresh stdout". It does not.
Once the host's read end closes, that session has no monitor for the rest of its life.
Exiting is still the right move — a monitor that cannot write cannot deliver, and
carrying on would advance `lastEventId` past events nobody received — but it is a clean
shutdown, not a recovery, and the comment now says so. It also settles the disagreement
that comment created about `when: "always"`: an exhausted monitor really does stay dead.

### F10 — the SHIPPED manifest arms, and it is the bare-name entry that does it. **MEASURED.**

**Probe:** `scripts/spikes/probe-shipped-arm-trigger.py`. F6–F8 established the
mechanism with synthetic names; this one runs the real
`.claude-plugin/plugin.json` — `name`, `when`, and the skill's frontmatter copied
verbatim — in the double-install shape (`skills/tandem/` from the plugin, plus a
non-plugin copy of the same skill). Two substitutions, neither of which touches
what is measured: `mcpServers` stripped, and each monitor's `command` swapped for
a marker emitter, since the `when` match is decided before anything is spawned.

| phase | `tandem-events`<br>(`on-skill-invoke:tandem:tandem`) | `tandem-events-user-skill`<br>(`on-skill-invoke:tandem`) |
|---|---|---|
| idle 35 s | — | — |
| bare `/tandem` | — | **armed, 16 s** |

The idle phase is the negative control: neither armed, so `when` is being honoured
rather than ignored.

**The entry that fired is the one that would have been easy to leave out.** The
plugin's own copy of the skill is right there in the fixture, and the intuition is
that a plugin-supplied skill publishes the qualified name — but F7's collision
holds in the shipped shape too: the bare dispatch resolved to the *non-plugin*
copy, which publishes `tandem`, so only the second entry matched. A manifest
carrying just `on-skill-invoke:tandem:tandem` would arm nothing at all for any
user who ran `tandem setup --apply`, which is the documented setup path.

*Known limit of the run:* the probe terminates the session ~0.1 s after the marker
appears, so the capture never contains the skill's one-word reply and the
"which copy ran" line reads `neither`. The marker is the observable; the reply is
a redundant cross-check that this phase does not get to make. Which copy ran is
already established by F7, twice.

## What the shipped binary says (IN CODE, 2.1.226)

Same extraction method as `plugin-delivery.md` F1/F2. These corroborate the runtime
measurements and explain them.

**The manifest field's own description:**

> "Background watch scripts the host arms **as persistent Monitor tasks**
> (unsandboxed, same trust tier as hooks) so plugins need not instruct the model to
> arm them."

**The `command` field's own description:**

> "Shell command to run as a persistent background monitor. **Each stdout line is
> delivered to the model as a `<task_notification>` event**; the process runs for the
> session lifetime. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
> `${CLAUDE_PROJECT_DIR}`, `${user_config.*}`, and `${ENV_VAR}` are substituted. Runs
> in the session cwd."

So the manifest path contributes **no delivery machinery of its own** — it produces the same
`kind:"monitor"` task, with the same stdout→`task_notification` delivery, as the `Monitor`
tool. That convergence is what lets P-A2's soak stand as evidence for the manifest path:
P-A2 armed the **shell** source, which is what a manifest monitor is.

> It does **not** transfer to the transport ADR-049 ships. Decision 1 there mandates the `ws`
> source, described as pure JSON config with *no shell*, so the two share the delivery half
> and not the runner. The `ws` path's own end-to-end evidence is `wake-socket-end-to-end.md`,
> not P-A2.

### The five activation gates

The arming function returns early unless all of these hold. Enumerated because four
of them are undocumented failure modes for us:

| Gate | Condition | Notes |
|---|---|---|
| `Ip("pluginMonitors")` | off under `--safe-mode` / `CLAUDE_CODE_SAFE_MODE` | rare |
| `tengu_amber_sentinel` | **remote feature gate, defaults to false** | see below |
| `isInteractive` | no TTY → no monitor | the mechanism behind F3's nulls |
| workspace trust | not accepted → skipped, with a log line | undocumented for us |
| `disableAllHooks` policy | monitors share the hooks trust tier | enterprise |

Arming is a `useEffect` in the interactive component tree, which is *why* the TTY
gate exists in practice rather than by explicit check alone. (Throughout this note, "F3"
unqualified means **`plugin-delivery.md`'s** F3 — the mode table with the nulls — not this
note's own F3.)

### `tengu_amber_sentinel` also gates the `Monitor` tool

The tool's `isEnabled()` is `Zue() && Jf()` — the same gate, **and a second condition**:
`Jf()` is true off Windows, but on Windows requires Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`,
Git Bash under `Program Files`, or a `where.exe git` result put through `plugin-delivery.md`
F1's cwd guard). That second one is **not** shared with plugin monitors, which fall back to
PowerShell — so on a stock Windows box with no Git Bash the `Monitor` tool is not offered at
all, whatever source we would have passed it, while the plugin monitor still runs.

**This means ADR-049's self-armed wake — the path `SKILL.md` and `doctor` recommend first —
has two preconditions Tandem does not own and cannot observe from the server.**

Do not read the gate's `false` default as a population estimate: it is a static read of a
*client-side* default, not the served value, and **both accounts we can observe had it on** —
this one (the tool is available, and P-A2 ran), and the macOS field reporter in
`plugin-delivery.md`, whose host demonstrably spawned the plugin monitor, since `exit 127` is
host output and the gate sits upstream of the spawn. The honest claim is that availability is
conditional and invisible to us, not that it is rare.

Corrected in copy by **PR #1353** (README, CHANGELOG, doctor, the setup wizard,
troubleshooting, CLAUDE.md) and recorded as a dated amendment to ADR-049.

### Two manifest capabilities we are not using

- `${CLAUDE_PLUGIN_ROOT}` substitution, which would also bypass the cwd guard from
  `plugin-delivery.md` F1 — any command containing a path separator skips `where.exe`
  resolution entirely. **Blocked as written:** `dist/` is gitignored, so a
  github-source marketplace install has no `dist/monitor/index.js` to point at. That
  is why the manifest uses `npx` today, and any fix has to solve distribution first.
- `when: "on-skill-invoke:<skill>"` — arms on first dispatch of a named skill instead
  of at session start, which retires the objection that the monitor fires in sessions
  unrelated to Tandem. **Measured working (F6); the name must be `plugin:skill`** — and
  a same-named skill from any non-plugin source takes the bare name and does not arm it
  (F7), which is exactly what `tandem setup --apply` installs today. Declaring both name
  forms as two entries catches either copy (F8).
- `${user_config.KEY}` — **measured NOT to substitute in a monitor command**
  (`scripts/spikes/probe-monitor-userconfig.py`): a bare-`node` control armed and an
  otherwise identical `"${user_config.node_path}"` entry did not, with the session
  reporting `1 monitor`. The `command` field's own description lists `${user_config.*}`
  among its substitutions, so the manifest schema and the runtime disagree. This closes
  the one candidate manifest-level fix for the exit-127 PATH failure — a `type: "file"`
  field defaulting to an absolute node path. *Limit:* `--plugin-dir` runs no enable-time
  prompt, so this cannot separate "monitors do not substitute `user_config`" from
  "defaults are not applied unless prompted". Either way it is unusable from a manifest.

## What is still not established

1. **macOS and Linux.** This is one win32 run.
2. **Marketplace-install activation.** Loaded via `--plugin-dir`; the published
   github-source path is not re-tested here. F3 above removes the reason to think the
   load path matters, but that is an inference, not a measurement.
3. **Behaviour when `tengu_amber_sentinel` is off.** Not tested; no local override for the
   gate was looked for. Both accounts we can observe have it on — see below.
4. **Burst behaviour.** 6 s intervals did not trip the rate limiter. The limiter
   emits a visible `[plugin monitor "…" suppressed N events — output rate exceeded]`
   rather than disarming, so the A2-style silent-death hypothesis is disfavoured —
   but an accept/dismiss burst was not run.

## Reproducing

```sh
python -m venv ptyenv && ./ptyenv/Scripts/python.exe -m pip install pywinpty
./ptyenv/Scripts/python.exe scripts/spikes/probe-monitor-tty.py <fixture-plugin-dir> <cwd>
```

The window defaults to 60 s. Do not shorten it: **session boot** eats 15–20 s of it before
the monitor arms at all (F1), and a woken turn needs several more on top.

**This reproduces F1 only.** The script exits 0 on the marker alone, so a run with zero
delivery still reads as success. For the other two findings:

- **F2 (delivery)** — grep `<plugin-dir>/pty-capture.txt` for the emitted event text after
  stripping ANSI. If it is empty, check whether the capture is full of `thinking` frames
  before calling it a null.
- **F4 (no orphan)** — scan for surviving processes yourself; the probe does not.
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered on `emit.mjs`.
- **F6 / F7 / F8** have their own scripts, same venv and same two arguments:
  `probe-skill-arm-trigger.py` and `probe-skill-name-collision.py`. Both write their own
  verdict line; both take ~105 s because the idle settle is deliberate.
- **F10** — `probe-shipped-arm-trigger.py <workdir> <trusted-cwd>`. Same venv, same shape,
  but it builds its fixture from the real `.claude-plugin/plugin.json` rather than a
  synthetic one, so re-run it after ANY edit to the manifest's monitor block, to the
  plugin `name`, or to `skills/tandem/SKILL.md`'s frontmatter `name:`. All four are
  inputs to the string the host compares, and three of them are nowhere near the manifest.

**If a capture comes back nearly empty, do not read it as a null result.** pywinpty decodes
to `str`, so a UTF-8 sequence split across a chunk boundary raises `UnicodeDecodeError` and
kills the reader thread mid-run. That produced a 5-byte capture and an INCONCLUSIVE verdict
here before the reader was made to survive it.

Prerequisites that will silently produce a false negative if missed:

- **`<cwd>` must be a directory Claude Code already trusts.** Workspace trust is one of the
  arming gates and the probe sends no input ever, so an untrusted directory parks the
  session at the trust prompt and the probe reports "the monitor did not arm".
- **`claude` must be a real executable on PATH** (`claude.exe` from the native installer).
  An npm-global install exposes `claude.cmd`, which `CreateProcess` will not launch directly.
- **Node ≥ 20.11** for the fixture emitter's `import.meta.dirname`.

The probe writes its fixture into `<plugin-dir>`, refusing any directory that is not empty
or already a probe fixture. `pywinpty` is deliberately **not** a repo dependency — it is
needed only to reproduce this note, and it is Windows-only: closing the macOS/Linux gap in
"What is still not established" means porting the harness to `ptyprocess`/`pexpect`, which
expose the same spawn-and-read shape.
