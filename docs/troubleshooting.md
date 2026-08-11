# Troubleshooting

Common first-launch and runtime issues, with diagnostic steps.

## Quick diagnostic

If you're running from a source checkout, `npm run doctor` checks the most common setup issues at once:

- Node.js ≥ 22 installed
- `node_modules/` present
- `.mcp.json` valid (both `tandem` and `tandem-channel` entries)
- `~/.claude.json` MCP registration (when present)
- **Claude Code is installed *and startable*** — on Windows these are different questions, and an `npm install -g` install passes the first while failing the second (see [below](#tandem-cant-start-claude-on-windows-but-claude-works-in-a-terminal))
- No stale global `tandem-editor` shadowing the version you meant to run
- Ports `3478` (Hocuspocus WebSocket) and `3479` (MCP HTTP) listening
- `/health` endpoint responds
- `/api/events` SSE endpoint responds with `text/event-stream`
- Annotation store readable; schema version, corruption state, lock status

Three more run only in a source checkout: whether `npm install` is stale against
`package-lock.json`, whether an orphaned Vite process is holding a port, and — if `package.json`
can't be read — a warning that the other two were skipped rather than passed. The last two
checks (`/health`, SSE) are conditional: they run only once the port probe finds the server up,
so a report that stops early is reporting a down server, not a passing one.

For desktop-app installs, use **Settings → About → Copy Diagnostics** to run the same checks in-app, minus those five source-checkout-only items — see [Sharing diagnostics](#sharing-diagnostics). Or `curl http://127.0.0.1:3479/health` — a `{"status":"ok",...}` response means the server is up.

## Windows SmartScreen warning

The Tandem installer is signed via Azure Trusted Signing ([ADR-030](decisions.md)), but Windows SmartScreen also gates new signing certificates on a reputation system that takes time to accumulate. Until reputation builds, first launch may show a *"Windows protected your PC"* dialog with the verified publisher name displayed.

To proceed: click **More info**, then **Run anyway**. The warning stops appearing once SmartScreen reputation accrues for the signing certificate (typically several weeks of installs across Windows machines).

This is a SmartScreen-side delay, not a code-signing failure — the installer is signed and the publisher name will be shown in the dialog. If the publisher reads as *"Unknown publisher"* instead of the Tandem signing-cert identity, that's a real signature problem; please [file an issue](https://github.com/bloknayrb/tandem/issues).

## Claude Code says "MCP failed to connect"

The server must be running before Claude Code probes the MCP URL. Start it first:

- Desktop app: launch Tandem.
- npm global install: run `tandem`.
- From source: run `npm run dev:standalone`.

If you restart the server while Claude Code is open, run `/mcp` inside Claude Code to reconnect.

## MCP shows connected but Tandem tools fail

`/mcp` showing `tandem ✔ connected` proves the config entry resolved at session start — a tool call is the first *real* round-trip, so it's the call that surfaces a dead or stale server. In likelihood order:

1. **The server isn't running anymore.** The connection state is cached from session start. Launch Tandem (or `tandem` in a terminal), then `/mcp` to reconnect.
2. **Stale URL or port.** If you've set `TANDEM_MCP_PORT` (or an old install used a different port), `~/.claude.json`'s `mcpServers.tandem.url` points at the wrong place. Re-run the in-app integration wizard or `tandem setup --apply`.
3. **Stale auth token.** A rotated token with an old `Authorization` header in a non-Claude client config rejects every call (Claude configs are updated automatically by `tandem rotate-token`).
4. **Orphaned entry from an old install.** You uninstalled (or reinstalled differently) and the old `mcpServers.tandem` entry survived. Re-run the wizard, or remove the entry — see [data-locations.md](data-locations.md) for every place Tandem writes config and the `tandem --uninstall-scrub` command that cleans them.

`tandem doctor` (or **Settings → About → Copy Diagnostics**) distinguishes 1 from 2–4: if the health checks pass but tool calls still fail, the problem is on the config side.

## Tandem can't start Claude on Windows, but `claude` works in a terminal

Symptom: the "Restart Claude" / "Set up Claude Code" prompt keeps coming back, or the AI
indicator never goes live — yet typing `claude` in a terminal starts it fine.

Cause: `npm i -g @anthropic-ai/claude-code` installs wrapper scripts (`claude.cmd`,
`claude.ps1`) rather than a real `claude.exe`. Terminals run those wrappers because `PATHEXT`
tells them to; Windows' process-creation API doesn't consult `PATHEXT` at all, so Tandem's
launcher — which starts Claude by name, without a shell — never finds anything to run. The CLI
is genuinely installed and genuinely usable; it just isn't startable by another program.

Fix: install Claude Code from [claude.com/claude-code](https://claude.com/claude-code). The
native installer drops a real `claude.exe`, which both terminals and Tandem can start. (The npm
install method is deprecated.) Alternatively, set `TANDEM_CLAUDE_CMD` to the full path of a
`.exe`.

**Restart Tandem after installing.** The launcher searches the PATH Tandem started with, so a
CLI installed while Tandem is running stays invisible to it — and the old wrapper keeps
winning — until the restart.

`tandem doctor` names this state explicitly — a warning that the CLI on PATH is a wrapper
Tandem's launcher can't start — and the integration wizard shows the same warning. Launching
Claude yourself in a terminal keeps working either way; only Tandem's auto-launch is affected.

## Tandem says "Set up Claude Code" but Claude Code is already installed

Tandem gives up restarting Claude after repeated crashes in a short window, and asks the
supervisor which kind of failure it was: the CLI being missing or unstartable, or the CLI being
fine and crashing for some other reason (a stale saved conversation, an expired login, a plugin
that fails on load). Only the first routes you to the setup wizard.

That check looks for a `claude` on the PATH Tandem itself started with, so it can be wrong in two
ways. If you installed Claude Code under a different name, use **Restart Claude anyway** on the
empty-state screen, or run **Relaunch Claude in this folder** from the command palette
(`Ctrl+Shift+P`). If you installed it *after* opening Tandem, restart Tandem — a running process
cannot see a PATH change made after it launched.

If Claude keeps stopping with a healthy install, the CTA says "Restart Claude Code" instead, and
the likeliest cause is a saved conversation Claude can no longer resume. **Start a fresh
conversation** (the secondary action beside Restart, or the palette command) drops it and starts
clean — irreversible, so it is never the default.

## Port already in use

Tandem kills stale processes on `:3478` / `:3479` at startup. If another application owns those ports and won't yield, set alternate ports:

```bash
export TANDEM_PORT=4478
export TANDEM_MCP_PORT=4479
export TANDEM_URL=http://127.0.0.1:4479
tandem
```

All three need to match — `TANDEM_URL` is what the channel shim and MCP clients connect to.

If bind still fails after the timeout, the server logs `port {port} still not available after {timeoutMs}ms` and exits. Identify the holding process with `lsof -i :3479` (macOS/Linux) or `netstat -ano | findstr :3479` (Windows).

## I sent a chat message (or left a comment) and nothing happened

The status bar says **AI connected** and Claude never reacts. This is the most common new-user snag, and the status bar is genuinely not lying — it's answering a different question than the one you're asking.

Tandem has **two independent connections** to Claude:

| | What it is | What it does |
|---|---|---|
| **Pull** | The MCP server | Lets Claude read and edit your document when it decides to look |
| **Push** | A real-time event stream | Tells Claude the moment you comment or send a message |

"AI connected" reports the **pull** path only. Chat and comments need the **push** path, and the two can be in completely different states. A session with a working pull path and a dead push path looks perfectly healthy and does nothing when you type.

**Diagnose it.** In the desktop app: **Settings → About → Copy Diagnostics** (the desktop app does not install the `tandem` command). From a terminal, if you installed via npm:

```bash
tandem doctor
```

Either way, look for the push line. `No real-time push consumer attached` means nothing is listening — that's the whole problem.

**First, check which kind of session this is.** Sessions Tandem starts for you — the desktop app's **Relaunch Claude** button — are woken directly by Tandem and use none of the three below. If that is the session that isn't reacting, nothing here is the fix; the problem is elsewhere. Everything that follows is about a session you started yourself by typing `claude`.

**Fix it** — three ways, and you want exactly one of them.

*The quickest, where it is available:* **ask Claude to watch for updates.** It needs nothing installed, but it does need a Claude Code that offers a `Monitor` tool — enabled per account rather than per version, and on Windows it also wants Git Bash. Some sessions simply do not have one, and for those the channel shim further down is the option that does not need it (the plugin monitor needs the same tool). Tandem's bundled skill tells it how, so "watch Tandem for updates while we work" is usually enough — it opens a watch on Tandem's wake stream and is woken whenever you comment or send a message. No install, no flag, and it lives and dies with that session. If Claude says it cannot, check that the session actually has Tandem's MCP tools (`/mcp` lists them), that your Claude Code offers a `Monitor` tool, and that `tandem_status` reports a `wakeUrl` — the watch has nothing to attach to without one, and stdio-mode Tandem reports none. **Ask directly rather than waiting to be offered.** Claude normally only volunteers a watch when Tandem reports that nothing at all is listening, and a channel shim left over from an older setup stays listening forever while delivering nothing — so in exactly the case you are debugging, it will not offer. Asking overrides that.

*Or* install the Tandem plugin, which registers a monitor that needs no flag — every `claude` you start afterwards picks it up (`claude plugin list` to check whether you already have it). It starts watching when Claude first uses Tandem's skill in a session, so ask for Tandem by name; if you have been chatting about something else, it is not listening yet. Start `claude` from a terminal window: the monitor runs with whatever program path that session was given, and a Claude Code launched from a desktop icon may have no usable Node on it. That failure shows up as [`exit 127`](#plugin-monitor-reports-script-failed-exit-127).

*Or* register the channel shim and start Claude Code with the channel flag:

```bash
tandem setup --apply --with-channel-shim
claude --dangerously-load-development-channels server:tandem-channel
```

Both halves are needed. The shim is **not registered by default** — so on a fresh setup the flag alone names a server that is not in your config. (If you configured it before that changed, your existing entry is untouched and the flag alone is still enough.) The flag has to be on every session: it is not remembered, and it only works in an interactive session, so it does nothing in `claude -p`. There is also no way to make it unnecessary — Claude Code's channel allowlist covers plugins only, and `tandem-channel` is a plain MCP server, so no listing exists that Tandem could apply for.

**Do not enable more than one.** Each delivers independently, so a session running two receives every event twice. Note that `No real-time push consumer attached` cannot tell you which one is missing — they all attach to the same stream — so pick the one you meant to be using.

Two combinations can arise without you enabling anything twice, and both show the same symptom — Claude waking twice for one comment. In both, nothing is lost and no reply is duplicated: the inbox de-duplicates, so the cost is a wasted turn.

- **The plugin monitor plus a self-armed watch.** Claude only arms a watch when Tandem reports nothing subscribed, which used to be a reliable test because the monitor started at session start. Since #1354 it starts when Claude first uses the Tandem skill and takes a few seconds to connect, so the count Claude reads can be a few seconds out of date — and both end up running. Tandem's skill tells Claude to stop its own watch when it notices; if it does not, ask it to, or uninstall the plugin and keep the watch.
- **The plugin monitor twice over.** The plugin declares two monitors because the skill can be installed twice — once by the plugin, once by `tandem setup --apply` — and which name a `/tandem` dispatch resolves to depends on which copies exist. A session that dispatches *both* `/tandem` and `/tandem:tandem` arms both. Use one name per session. This one cannot be fixed in the plugin: Claude Code requires a plugin's monitor names to be unique, so the two entries cannot be collapsed into one that arms only once.

**Meanwhile, nothing is lost.** Your message is saved and Claude sees it the next time it calls `tandem_checkInbox`. If Claude is mid-task, asking it to "check your inbox" surfaces everything immediately.

**None of the three applies to Claude Desktop**, and it is the one case where there is nothing to configure. All of them are Claude Code mechanisms: the channel shim is a node subprocess Claude Code spawns, the plugin monitor rides Claude Code's plugin host, and the self-armed watch uses a Claude Code tool. For a Claude Desktop target the setup wizard writes an MCP entry and nothing else — deliberately — and its Done screen now says so on that target's row rather than leaving you to find out by being ignored. Push there does not fail; it does not exist. Nothing is lost either way: as above, your comments and messages are saved and Claude Desktop sees them the next time it calls `tandem_checkInbox`, so asking it to "check your inbox" is the workflow rather than a workaround (#1299).

**One caveat `tandem doctor` cannot resolve for you.** If a consumer *is* attached, that proves events reach the shim — not that Claude sees them. A session started without the flag still runs a channel shim that receives every event and discards it, because whether the channel is honored is decided inside Claude Code and never reported back. If push looks attached and Claude still isn't reacting, start the session with the flag explicitly rather than assuming the config alone is enough.

Related: [Channel shim fails to start](#channel-shim-fails-to-start), [`claude plugin install` fails with "unsafe location"](#claude-plugin-install-fails-command-git-not-found-or-is-in-an-unsafe-location-current-directory), [`claude plugin install` fails to clone](#claude-plugin-install-fails-to-clone-ssh-vs-https), [Plugin monitor exit 127](#plugin-monitor-reports-script-failed-exit-127), [Stale global `tandem-editor`](#stale-global-tandem-editor-shadows-the-pinned-version).

## Channel shim fails to start

The `tandem-channel` entry spawns a subprocess. Most failures fall into two buckets:

- **`MODULE_NOT_FOUND`** with a production config (`node dist/channel/index.js`): the bundled channel shim is missing. For global installs, re-run `tandem setup --apply` after upgrading; absolute paths get rewritten to the current install. For source checkouts using a production-style config, run `npm run build`. The default dev config uses `npx tsx` and skips the build step entirely.
- **Timeouts** in the shim output:
  - `/api/events timed out after 10000ms` — initial SSE handshake never completed.
  - `SSE inactivity timeout` — connection accepted, then the server stopped sending events.
  - `/api/channel-reply timed out after 5000ms` — reply path stalled.

  All three mean the server accepted the connection but stopped responding on that path. Restart Tandem; the shim reports the timeout instead of hanging silently.

## `claude plugin install` fails: "Command 'git' not found or is in an unsafe location (current directory)"

This message is misleading in the common case — you probably *do* have git.

Claude Code resolves bare-name tools through your PATH (confirmed for `git` and `npm`) and then
refuses any candidate whose resolved path sits **underneath your current working
directory**. It's an anti-PATH-hijack check: it exists so a `git.exe` dropped into a
project folder can't be picked up. But a per-user install puts git somewhere under your
home directory — `%LOCALAPPDATA%\Programs\Git\cmd` on Windows, `~/.local` or a version
manager's directory elsewhere — so launching `claude` from your home folder makes your own
legitimate git look unsafe.

**Fix — no admin rights needed.** Start Claude from any directory that isn't an ancestor of
the tool's install path. A project folder is the normal choice, and Claude Code already
recommends it for unrelated reasons:

```bash
cd ~/Documents/my-project
claude
```

Then retry the install. The same guard applies to `npm` and `npx`, so if a plugin's
commands fail with "not found" while you can run them yourself in the same shell, check
where you launched Claude from before anything else.

## Plugin monitor reports "script failed (exit 127)"

Exit 127 is command-not-found. The published plugin's monitor runs
`npx -y tandem-editor@<version> monitor`, so this fires when `npx` isn't resolvable from
the plugin host.

**Why it happens, and why it isn't about your shell.** Claude Code spawns a monitor through
a shell with an environment it builds itself (`shell: true`, read out of `claude` v2.1.223).
On macOS and Linux that is `/bin/sh -c` — **non-login and non-interactive**, so it never
sources `~/.zshrc`, `~/.zprofile` or `~/.bashrc`. PATH comes entirely from the environment
Claude Code itself was started with. Launch Claude from a terminal and it inherits your
shell's PATH; launch it from Spotlight, the Dock, or another GUI surface and it inherits the
OS default (on macOS, roughly `/usr/bin:/bin:/usr/sbin:/sbin`), which contains no Node.

A useful tell: if `claude` itself lives somewhere like `~/.local/bin` and isn't on your PATH
either, you are looking at the same cause.

Two things worth knowing:

- **Nothing is lost.** This only disables *push*. Your edits, comments and chat still reach
  Claude on its next `tandem_checkInbox`.
- **It no longer fires in sessions that have nothing to do with Tandem.** It used to: plugin
  monitors were spawned in every session regardless of what you were working on, so a
  monitor that could not run reported this failure in all of them. Tandem's monitor now
  starts only when Claude first uses the Tandem skill in a session, so you should see this
  where it is informative — you asked for Tandem and push is not available — and nowhere
  else. If you are still seeing it in unrelated sessions, the plugin is from before this
  change; reinstall it.

**Fixes, in order of preference:**

1. **Start Claude Code from a terminal** rather than a GUI launcher. It then inherits the
   PATH your shell already has, and `npx` resolves.
2. **Put Node on the PATH Claude Code inherits.** On macOS that means the environment the
   GUI launcher provides, not your shell profile — `launchctl setenv PATH …` or a Node
   installed under `/usr/local/bin`.
3. **Remove the plugin** (`claude plugin uninstall tandem@tandem-editor`). Claude Code
   exposes no per-monitor disable, so this is the only way to stop the message — and it
   also removes the Tandem skill the plugin ships. Note the plugin's MCP entries use `npx`
   too, so on a machine where the monitor cannot start they are unlikely to be working
   either.

There is no fix Tandem can ship in the plugin manifest for this: the monitor command is one
static string used on every platform, and a form that picks up a login shell's PATH
(`sh -lc '…'`) does not exist on Windows, where the same `shell: true` resolves to
`cmd.exe`. The entries Tandem's *own* setup writes are a different story — those no longer
go through `npx` at all; see the next section.

## `Failed to spawn process: No such file or directory` (Claude Desktop)

Claude Desktop's MCP log (`~/Library/Logs/Claude/mcp-server-tandem.log` on macOS,
`%APPDATA%\Claude\logs\` on Windows) shows something like:

```
[tandem] [info] Using MCP server command: npx with path: { metadata: { paths: [ … ] } }
Failed to spawn process: No such file or directory
[tandem] [error] Server disconnected.
```

**Same cause as the exit-127 section above**, different symptom. An MCP `command` with no
path separator is resolved through the *client's* PATH at spawn time. A GUI-launched client
never reads your shell profile, so on macOS it gets roughly `/usr/bin:/bin:/usr/sbin:/sbin`
— no Homebrew, no nvm, no `~/.local/bin`, and therefore no Node. `npx` is not found, the
transport dies before it can even handshake, and nothing appears in Tandem's own logs
because Tandem's server was never contacted.

The `paths` array in that log line is the whole diagnosis: if it contains no directory with
a `node` in it, this is what you are looking at.

**Entries Tandem manages are fixed.** `tandem setup --apply` (and the desktop app's
integration wizard) now write an absolute Node binary and an absolute script path, so no
PATH lookup happens at all. In the desktop app that Node is Tandem's own bundled copy,
which means the entry works on a machine with no Node installed whatsoever. To pick up the
change on an existing install:

```bash
tandem setup --apply
```

then **restart Claude Desktop** — it does not reload MCP config while running. Your previous
config is backed up first. `tandem doctor` reports the state of this entry, including
whether it has gone stale.

**Entries Tandem does not manage still use `npx`**, and cannot be fixed this way — a static
manifest cannot carry a path that only makes sense on one machine:

- the **Tandem plugin**'s two MCP servers and two monitors (see the previous section),
- the **Cowork** guest registry, where a host path would be meaningless anyway.

For those, the remedies are the same as the exit-127 section: start the client from a
terminal, or put Node on the PATH the GUI launcher provides.

### Why "just use the full path to npx" does not work

It is the obvious hand-fix and it fails for the same reason the bare name does. `npx` is not
a binary — it is a symlink to `npm/bin/npx-cli.js`, whose first line is
`#!/usr/bin/env node`. Naming it by absolute path still makes the kernel run `env`, which
searches **the client's PATH** for `node`:

```console
$ env -i PATH=/usr/bin:/bin /opt/homebrew/bin/npx --version
/usr/bin/env: 'node': No such file or directory
```

If you are hand-editing a plugin or Cowork entry, point it at an absolute **node** plus an
absolute script instead — that is exactly what `tandem setup --apply` now writes for the
entries it owns:

```json
"command": "/opt/homebrew/bin/node",
"args": ["/usr/local/lib/node_modules/tandem-editor/dist/stdio-bridge/index.js"]
```

(`npm root -g` prints the directory to use, and `which node` the interpreter.)

## `claude plugin install` fails to clone (SSH vs HTTPS)

Claude Code clones GitHub-hosted plugins over SSH (`git@github.com:…`) by default. If you haven't added an SSH key to your GitHub account, the clone fails with a permission/authentication error even though the repo is public and reachable over HTTPS in a browser.

Two workarounds:

- **Add an SSH key** to your GitHub account ([GitHub's guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)), then retry the install.
- **Rewrite SSH clones to HTTPS** globally, so no key is needed:

  ```bash
  git config --global url."https://github.com/".insteadOf git@github.com:
  ```

  This makes git transparently use `https://github.com/…` for any `git@github.com:…` URL. Retry the plugin install afterward.

## Stale global `tandem-editor` shadows the pinned version

Symptoms: after upgrading, Claude Code reports "Server disconnected" / "Could not attach," or Tandem behaves like an older build, even though the plugin manifest pins an exact version.

Cause: a previously installed global (`npm install -g tandem-editor`) shadows the exact-pinned `npx -y tandem-editor@<version>` spec the plugin and generated config use — `npm exec` silently reuses the already-installed global instead of fetching the pinned version (#1177, [ADR context](decisions.md)).

Fix — remove the stale global so `npx` fetches the pinned version:

```bash
npm uninstall -g tandem-editor
```

(If you deliberately run a global CLI, upgrade it to match instead: `npm install -g tandem-editor@latest`.) Confirm with `tandem doctor`, which warns when a shadowing global is present.

## Editor shows "Cannot reach the Tandem server"

The editor connects to the Hocuspocus WebSocket on `:3478`. If the message appears, the server isn't running or isn't reachable:

- Desktop app: relaunch (the sidecar may have crashed; check the system tray or activity monitor).
- npm install: run `tandem` in a terminal and watch for startup errors on stderr.
- Source checkout: `npm run dev:standalone` (or `npm run dev:server` if you want backend only).

The banner appears after 3 seconds of failed connection, so it's a real failure — not a transient retry.

## Empty editor with no document

On first run, `sample/welcome.md` auto-opens. On upgrades, `CHANGELOG.md` opens (read-only). If you've cleared session state, deleted the sample file, or set `TANDEM_NO_SAMPLE=1`, the editor starts empty.

Click the **+** in the tab bar, drop a file onto the editor, or ask your AI to open one (`"open notes.md in tandem"`).

## Reset session state

Sessions live in `{APP_DATA_DIR}/sessions/`, with one file per opened document plus a `CTRL_ROOM.json` for cross-document state (chat history, Solo/Tandem mode). To find the directory per OS:

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\tandem\Data\sessions\` |
| macOS | `~/Library/Application Support/tandem/sessions/` |
| Linux | `$XDG_DATA_HOME/tandem/sessions/` (defaults to `~/.local/share/tandem/sessions/`) |

To reset all session state cleanly:

1. Quit Tandem (close the desktop app or stop the `tandem` process).
2. Delete the `sessions/` directory.
3. Restart Tandem.

To reset only chat history without losing per-document state, delete just `CTRL_ROOM.json`.

Durable annotations live in a separate `annotations/` directory alongside `sessions/`. Corrupted annotation files are quarantined automatically (renamed to `.corrupt.json`) instead of being deleted, so you can recover them by hand if needed.

## Recovering a previous version of a document

Before Tandem's **first** write to a `.md`/`.txt`/`.docx` file in a server run, it copies the file's current on-disk bytes to a backup folder (for `.docx` this is a verbatim, byte-identical copy of the ZIP). If a save ever mangles your file — especially a `.docx`, where exporting can drop Word features Tandem doesn't model — or you just want yesterday's version back, there are three ways to restore:

- **In the app:** open the command palette (Ctrl+Shift+P) and run "Restore a backup of this document…" — it lists the available snapshots and restores the most recent one. The document reloads in place; annotations are preserved.
- **Ask Claude:** the `tandem_restoreBackup` MCP tool lists a document's snapshots (call it without `backup`) and restores any of them by name — including older snapshots the palette action doesn't reach.
- **By hand:** with any file manager, no Tandem needed — see below.

Backups live in `{APP_DATA_DIR}/doc-backups/` (sibling of `sessions/` — same per-OS table as above). Each document gets a subfolder named by a hash of its path, containing:

- up to 3 timestamped copies, e.g. `thesis-20260609-141500-ab12cd34.md` (newest wins), and
- a `source.txt` recording the original file's full path.

To restore by hand: find the right subfolder (check `source.txt`, or sort by date and look at the filenames), then copy the snapshot over your document. Quit Tandem first — or close the document's tab — so the restored bytes aren't overwritten by an autosave of the old in-memory content. (The in-product paths above handle this for you: they reload the open document from the restored bytes, so no quit is needed.)

Notes:

- Backups are taken once per document per server run, and skipped when nothing changed since the newest backup — so the folder stays small.
- Snapshots older than 30 days are cleaned up automatically at startup, and the whole folder is capped at 500 MB (backups pause with a notification if it fills).
- `.docx` files get the same pre-overwrite snapshots as text (verbatim byte-identical copies of the ZIP) and are additionally never auto-saved — only explicit saves overwrite them. `tandem_applyChanges` also writes a `.backup.docx` sidecar next to the original, used as a fallback when no snapshot exists yet.

## Reading server logs

Tandem writes all log output to **stderr**, never stdout. This is intentional: when the server runs in stdio MCP mode, stdout carries the MCP wire protocol — any extra writes corrupt the connection.

When troubleshooting:

- Desktop app: logs are written to a rotating `tandem.log` file — **Settings → About → Open Log Folder** opens it directly. On disk it lives under the bundle identifier: `%LOCALAPPDATA%\com.tandem.editor\logs\` (Windows), `~/Library/Logs/com.tandem.editor/` (macOS), `~/.local/share/com.tandem.editor/logs/` (Linux).
- npm install: stderr prints to the terminal where you ran `tandem`. Redirect to a file with `tandem 2> tandem.log`. (No log file exists in this mode, so the Open Log Folder button doesn't appear.)
- Source checkout: `npm run dev:server` prints to the terminal.

If you ever see what looks like a normal log line on stdout, that's a bug — file it.

## Sharing diagnostics

When [filing an issue](https://github.com/bloknayrb/tandem/issues), attach a diagnostics report:

- **In the app:** **Settings → About → Copy Diagnostics** puts a plain-text report on the clipboard — version, platform, and the result of every health check (ports, `/health`, SSE, annotation store). The endpoint behind it only answers loopback callers.
- **From a terminal:** `tandem doctor` prints the same checks (plus the five source-checkout-only ones the button omits); `tandem doctor --json` emits a machine-readable report.

> **Privacy note:** the copied text contains local absolute paths (which include your username) and process IDs. Skim it before pasting into a public issue. It never contains auth tokens or document content.

## Auth rejection on LAN bind

When `TANDEM_BIND_HOST=0.0.0.0`, every non-loopback request needs a valid Bearer token. Rejections log as:

```
[tandem] auth: rejected request from <addr> (no/bad token header)
```

Check that:

1. Your client is sending `Authorization: Bearer <token>`.
2. The token matches the value in `{APP_DATA_DIR}/auth-token`.
3. You haven't rotated the token without updating the client config — `tandem rotate-token` updates Claude's configs automatically but won't touch other MCP clients.

`TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` does **not** disable the token requirement, despite the name — a token is always minted and always enforced for non-loopback callers (#1121 F7). It only permits a LAN bind before a token exists. And since #1320 a LAN peer can read `/api` but not write to it, so `tandem rotate-token` must be run on the host. See [security.md](security.md#the-api-invariant-1320) for the full model.

> **Note:** Tandem writes the Bearer token into your `.mcp.json` headers. On Claude Code CLI **≥ 2.1.141**, `claude mcp get`/`list` no longer prints that token to the terminal (credential headers and URL secrets are redacted, and `${VAR}` references are no longer expanded) — so inspecting the Tandem entry is safe to share. On older CLI versions the token is echoed in plain text; redact it before pasting output anywhere.
