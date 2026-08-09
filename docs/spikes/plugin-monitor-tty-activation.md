# Spike: do plugin monitors activate in a TTY session?

**Date:** 2026-08-09
**Claude Code:** `2.1.226 (Claude Code)`
**Platform:** win32/x64 (Windows 11)
**Probe:** `scripts/spikes/probe-monitor-tty.py` (committed alongside this note)
**Fills:** the one blank cell in [`plugin-delivery.md`](./plugin-delivery.md) F3
**Answers:** P1 (partly), P3 (fully), and the delivery half of ADR-028's reopen gate

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
EMIT 1 05:15:30 … EMIT 7 05:16:06
```

The session was spawned at 05:15:2x and the monitor was running within a second.

### F2 — Every stdout line became a model turn. **MEASURED.**

From the capture, in a session that received no prompt:

```
● Monitor event: "Tandem monitor activation probe"
● PROBE-EVENT-3 delivered. Three for three at ~6s intervals — the monitor
  wake path is holding steady. No action needed.
✻ Worked for 2s · 1 monitor still running
```

Four consecutive events, four turns, no drops. Events 5–7 fired while the harness
was tearing down and are outside the capture window — they are not drops.

**Three runs, and the second and third are the interesting ones.** A 22 s run armed
the monitor and showed `· 1 monitor` in the statusline, but closed before any turn
rendered. A 60 s run armed, emitted five events, and spent its entire capture — 45 kB
of it — in `thinking with high effort`, having received no input other than the
monitor's output, without emitting a response before cutoff.

So the wake is reliable and the *visible response* is not prompt. Time-to-surface
tracks the session's effort setting, because a wake is a full model turn like any
other. **This is a candidate partial explanation for the unexplained ~4-minute field
report (E4)** and the first mechanism anyone has proposed for it — offered as a
hypothesis, not a measurement: E4 was a real user session whose effort setting is
unknown.

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

### F4 — No orphan. P3 answered. **MEASURED.**

Last emission 05:16:06 against a ~05:16:05 force-terminate, and no surviving
`node.exe` matching the command. The host tears the monitor down with the session.
Checked again after all three runs: zero matching processes, and each run's marker
file stops at its own teardown. Survives a `terminate(force=True)` of the host, which
is the harsher case — a clean `/exit` was not separately tested.

> **Consequence:** the plan's contingent requirement — "orphans persist → server-side
> max-lifetime cap becomes mandatory" — does not apply. No cap is needed.

### F5 — `CLAUDE_PLUGIN_ROOT` is substituted, but not exported. **MEASURED.**

The `${CLAUDE_PLUGIN_ROOT}` in the *command string* resolved (node found the script),
yet the child process saw `process.env.CLAUDE_PLUGIN_ROOT` as **unset**. Substitution
happens at command construction. A monitor script must not read it from the
environment.

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

So the manifest path contributes **no delivery machinery of its own** — it produces
the same `kind:"monitor"` task, through the same shell runner, as the `Monitor` tool.
That is the convergence that lets P-A2's soak stand as evidence for both.

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
gate exists in practice rather than by explicit check alone.

### `tengu_amber_sentinel` also gates the `Monitor` tool

The tool's `isEnabled()` is the same flag. **This means ADR-049's self-armed wake —
the path `SKILL.md` and `doctor` now recommend first — depends on a remote gate we do
not own, cannot observe, and which defaults off.** It is on for this account (the
tool is available, and P-A2 ran), but "no install and no flag" is a stronger claim
than the code supports. Tracked separately; this note only records the finding.

### Two manifest capabilities we are not using

- `${CLAUDE_PLUGIN_ROOT}` substitution, which would also bypass the cwd guard from
  `plugin-delivery.md` F1 — any command containing a path separator skips `where.exe`
  resolution entirely. **Blocked as written:** `dist/` is gitignored, so a
  github-source marketplace install has no `dist/monitor/index.js` to point at. That
  is why the manifest uses `npx` today, and any fix has to solve distribution first.
- `when: "on-skill-invoke:<skill>"` — arms on first dispatch of a named skill instead
  of at session start. This directly addresses the objection that the monitor fires
  in sessions unrelated to Tandem.

## What is still not established

1. **macOS and Linux.** This is one win32 run.
2. **Marketplace-install activation.** Loaded via `--plugin-dir`; the published
   github-source path is not re-tested here. F3 above removes the reason to think the
   load path matters, but that is an inference, not a measurement.
3. **Behaviour when `tengu_amber_sentinel` is off.** Untestable from an account where
   it is on.
4. **Burst behaviour.** 6 s intervals did not trip the rate limiter. The limiter
   emits a visible `[plugin monitor "…" suppressed N events — output rate exceeded]`
   rather than disarming, so the A2-style silent-death hypothesis is disfavoured —
   but an accept/dismiss burst was not run.

## Reproducing

```sh
python -m venv ptyenv && ./ptyenv/Scripts/python.exe -m pip install pywinpty
./ptyenv/Scripts/python.exe scripts/spikes/probe-monitor-tty.py <fixture-plugin-dir> <cwd>
```

The window defaults to 60 s. Do not shorten it: boot alone eats 15–20 s, and a woken
turn needs several more on top.

The fixture plugin is created by the probe if absent. `pywinpty` is deliberately
**not** a repo dependency — it is needed only to reproduce this note.
