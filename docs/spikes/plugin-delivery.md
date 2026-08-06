# Spike: plugin delivery and monitor activation

**Date:** 2026-08-06
**Claude Code:** `2.1.223 (Claude Code)`
**Platform:** win32/x64 (Windows 11), plus field reports from macOS
**Probe:** `scripts/spikes/probe-plugin-delivery.ts` (committed alongside this note)
**Supersedes:** `docs/spikes/marketplace-install-spike.md` for the install-path question.

## Why

A tester on Windows could not run `claude plugin install`:

```
Failed to install: Failed to clone repository: Command 'git' not found or is in an
unsafe location (current directory)
```

He **has** git — a per-user install at `%LOCALAPPDATA%\Programs\Git\cmd`, on a work
laptop without admin rights — and his cwd was his home directory. That matters because the
plugin monitor is the only real-time push path a hand-launched `claude` session can get.

## Findings

### F1 — The guard is about cwd, not about git being absent

From the dispatch inside `claude.exe` v2.1.223:

```js
function Aae(e, t = false) {
  if (!zmg()) return e;
  if (e.includes("/") || e.includes("\\")) return e;   // path-ful commands skip the guard
  return LZn(e, t);
}
function k9n(e, t) {                                    // t = process.cwd()
  let r = resolve(t).toLowerCase(), n = resolve(e).toLowerCase();
  if (dirname(n) === r || n.startsWith(r + sep)) return true;   // → rejected
  ...
}
```

Only **bare names** are resolved through `where.exe`, and any candidate at any depth under
cwd is refused. Two consequences:

- **A user-visible fix exists with no code change**: launch from a directory that is not an
  ancestor of the tool. Documented in `docs/troubleshooting.md`.
- **Any command containing a path separator bypasses the guard entirely.** This is what
  makes the absolute-Node-path change below correct rather than incidental.

The same guard applies to `npm`: the `npm` plugin-source branch failed with the identical
"not found or is in an unsafe location" wording. So npm-sourcing does not escape the guard
class — it only renames the tool that trips it.

### F2 — A plugin CAN be installed with no usable git

Supported `plugins[].source` forms, from the same binary:

```js
if (typeof e === "string") <local path, resolved against a containmentRoot>
else switch (e.source) { case "npm" | "github" | "url" | "git-subdir"; default: throw }
```

`{"source":"local", ...}` is **not** valid — it hits the `default` throw, whose message
("This plugin uses a source type your Claude Code version does not support. Update Claude
Code and try again.") misleadingly blames the CLI version.

A bare relative string needs no external tool at all. Verified end-to-end with all four git
directories stripped from PATH: a marketplace directory that is also the plugin root, with
`source: "./"`, installed with exit 0. The resulting registry:

```json
{
  "extraKnownMarketplaces": {
    "<name>": { "source": { "source": "directory", "path": "<abs path>" } }
  },
  "enabledPlugins": { "<plugin>@<marketplace>": true }
}
```

Corroboration, not just our own probe: `claude plugin marketplace list` on the same machine
shows `wt-local` with `Source: Directory (...)` — Windows Terminal ships a Claude Code
plugin registered exactly this way. Note it declares `"source": "./wt-agent-hooks"`, a
dedicated slim staging subdirectory, **not** `"./"`.

**A string source is resolved against the marketplace's own install location**, with a
traversal guard:

```js
function V0o(e, t) {
  let r = resolve(e, t), n = resolve(e) + sep;
  if (!r.startsWith(n) && r !== resolve(e)) throw Error(`Path traversal detected: ...`);
  return r;
}
```

`"./"` resolves to exactly the base, which the second clause permits — so the same field
works for a github-sourced marketplace (whose install location is the clone) as for a
directory one.

### F3 — Monitors do not activate in any non-TTY mode

| Load path | Session mode | Monitor fired? |
|---|---|---|
| `--plugin-dir` | `-p` print | **No** |
| `--plugin-dir` | headless `stream-json` (launcher's exact flags) | **No** (confounded — see below) |
| Marketplace install (`--scope local`) | `-p` print | **No** |
| Marketplace install (`--scope local`) | headless `stream-json` | **No** |
| Any | TTY-attached interactive | **not testable by this harness** |

Every negative above comes from a session that demonstrably completed a turn (a `result`
envelope or a `session_id` in stdout), so they are real nulls rather than sessions that
never started.

The `--plugin-dir` headless cell is **confounded**: `--plugin-dir` is inert for monitors in
every mode tested, so a null there cannot distinguish "monitors don't fire headless" from
"the plugin never loaded". The marketplace-install rows are the ones that carry the weight.

**Consequence:** the launcher spawns with `CLAUDE_STREAM_JSON_FLAGS` (headless by
construction), so a Tandem-launched session will never spawn a monitor. Monitor and
supervisor-stdin-wake occupy disjoint halves; installing the plugin cannot double-deliver
against the supervisor. It *can* still double-deliver against a channel flag the user
passes by hand — that pairing is unchanged and remains documented as "use one, not both".

### F4 — What is NOT established

Monitor activation in a TTY-attached interactive session was **not** re-verified here; this
harness cannot produce one. The supporting evidence remains the v0.18.0 acceptance run
(`CHANGELOG.md`, v0.18.0), which exercised a **github-marketplace install of the published
npm package** on 2.1.212. Any design that changes the install path (directory source,
locally staged root) changes a variable that install-path history in this repo shows to be
decisive — see `plugin-monitor-viability-spike.md`, where a path source was rejected
outright on 2.1.143.

## Field evidence (not from the probe)

Two independent reports, both confirming the bare-command failure mode:

- **macOS.** `tandem-channel` was invoking a bare `node` that did not resolve; the shim
  never started. Fixed on that machine by pointing at Tandem's bundled Node (v22.17.0) by
  absolute path. Also on that machine: `claude` itself lives in `~/.local/bin` and is not
  on PATH.
- **macOS, same user.** The installed plugin's monitor fails on **every** session:

  ```
  Monitor "Tandem real-time document events (annotations, chat, selections)" script failed (exit 127)
  ```

  Exit 127 is command-not-found — `plugin.json` declares `npx -y tandem-editor@<version>
  monitor` and `npx` is not resolvable from the plugin host. This is live for anyone who
  installed the published plugin, and it fires in sessions unrelated to Tandem.

Together these are why the absolute-Node-path change (`src/server/integrations/node-binary.ts`)
landed ahead of any plugin-delivery work: bare commands in generated config fail for at
least two distinct reasons, both silent.

Unexplained and unaddressed: the same user measured **~4 minutes** from send to surface.
Not investigated here.

## Reproducing

```bash
npx tsx scripts/spikes/probe-plugin-delivery.ts            # all probes
TANDEM_PROBE_SKIP=p2,p3,p4 npx tsx scripts/spikes/probe-plugin-delivery.ts   # P1 only
```

P1 runs against an isolated `HOME` and never touches the real Claude Code config. P2/P3 use
the real config but only pass `--plugin-dir`, which writes nothing. P4 installs at
`--scope local` inside a temp directory that is deleted on exit, and uninstalls on the way
out; `marketplace list` and a grep of `~/.claude/settings.json` were both clean afterwards.
