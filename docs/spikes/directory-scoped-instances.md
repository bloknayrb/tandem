# Research note: directory-scoped Claude instances

**Status:** Research note. No decision recorded, nothing built. Written 2026-08-05
alongside the working-directory drift nudge, which is the cheap first step this
note exists to justify deferring the expensive one behind.

**Question asked:** *should we give the user an option to have separate instances
connect to Tandem based on what directory open documents are in?*

**Read `per-client-identity-spec.md` first.** This note is a **delta**. That spec
already enumerates the multi-client problem at five layers (transport, inbox
state, auth/identity, event routing, settings UI), records two answered probes,
and carries a 2026-07-30 amendment about MCP `2026-07-28` removing protocol-level
sessions. None of that is repeated here. What follows is only what
*directory-scoping* adds on top of "two clients can coexist" — and it is
substantial, because that spec is about clients **connecting to** Tandem, whereas
this question is about Tandem **spawning** them.

---

## 1. What the existing spec already covers

Assume per-client identity is solved. These stop being blockers:

| Blocker | Where it is already specced |
|---|---|
| Second `initialize` evicts the first | §3.2 — **shipped** as ADR-045 |
| Global `surfacedIds` ledger drains for the first poller | §3.3 — `surfacedByClient` |
| Chat `read: true` consumed by whoever polls first | §3.3 — per-client cursor (recommended) |
| Event queue broadcasts to every subscriber | §3.4 — broadcast retained, made correct by per-client inbox |
| No UI concept of multiple clients | §3.5 — read-only connected-clients list |

Two cautions carried forward rather than restated: `Mcp-Session-Id` is the
**legacy** branch as of MCP `2026-07-28`, so it is the obvious routing key and
the wrong long-term one; and per PR #1242, no suppression may be built on the
"was this pushed via channel" signal, per-client or otherwise.

---

## 2. What directory-scoping adds

### 2.1 Supervisor multiplicity — entirely outside the existing spec

The launcher does not appear anywhere in `per-client-identity-spec.md`. It is a
singleton at every level:

- `launcherSupervisor` is one module-level variable (`src/server/index.ts:140`),
  with an explicit guard against two concurrent `createSupervisor()` calls.
- One session file, fixed name — `SESSION_FILE_NAME = "launcher-session.json"`
  (`src/server/launcher/supervisor.ts:167`).
- One `opLock` serializing start/stop/relaunch, one circuit breaker with one
  `recentAttempts` array, one `lastError`, one `wakeOwedAcrossSpawns` latch
  (`supervisor.ts:357–377`).
- `SupervisorStatus` is a discriminated union describing **one** process
  (`supervisor.ts:214`), and `GET/POST /api/launcher/{status,relaunch,start-fresh,working-directory}`
  are all shaped around it.
- One reaper child process per supervisor.

N instances means N of each, plus an addressing scheme on every launcher route.
That is a rewrite of the launcher's public surface, not an extension of it.

### 2.2 Directory → instance mapping is an unanswered policy question

Nothing in the codebase implies an answer to any of:

- **Granularity.** Exact directory, nearest git root, nearest ancestor containing
  `CLAUDE.md`, or user-declared roots? A document in `repo/docs/` and one in
  `repo/src/` almost certainly want the same instance; the naive
  `dirname()`-per-document rule gives them different ones.
- **Lifecycle.** When does an instance die — last tab in its folder closes? Idle
  timeout? Never, until Tandem exits? Each answer has a different failure mode,
  and the wrong one silently burns a subscription.
- **Fallback.** What serves a document whose folder maps to no instance — the
  default instance, a newly spawned one, or nothing?
- **Ceiling.** Is there a maximum? Opening a search result set from ten folders
  should not spawn ten Claudes.

### 2.3 Solo/Tandem mode is global

Mode lives in `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS` under `Y_MAP_MODE` — one key
for all documents (`src/server/mode.ts`). The WS-A2 hold, the push gate
(`events/queue.ts#shouldForwardExternally`), and the supervisor's own wake
subscription all read it as a single global fact.

Directory-scoped instances make "Solo for the work folder, Tandem for the
personal one" the obvious next ask, and there is no per-scope mode to grant it.
Note the existing gates fail **closed** on an indeterminate mode; a per-scope mode
must preserve that, which is easy to get wrong when the lookup gains a key that
can miss.

### 2.4 Presence is a single slot, on both sides

- Server: per-document `Y_MAP_AWARENESS` under **one** `Y_MAP_CLAUDE` sub-key
  (`src/server/mcp/typing-presence.ts:126,149`; expiry at
  `presence-expiry.ts:128,176`). Two instances touching one document overwrite
  each other's typing/focus state.
- Client: `claudeActive` is one boolean (`src/client/hooks/yjsSync.svelte.ts:162`)
  and `status-ai-indicator` is one pill with one CTA model.

Note this is *per document*, so it only collides when two instances work the same
document — which directory-scoping is specifically designed to prevent. It may
therefore be a non-issue in the happy path and a confusing one at the boundaries
(a document open in two folders' scope, a moved file). Worth measuring before
building.

**Newer substrate the spec predates:** `AgentIdentity`
(`src/shared/types.ts:103`, #1123 M3) already models per-agent authorship on
annotations, with per-agent colour and chip gating (#1223 M4) — all merged dark
behind `BYO_MODELS_ENABLED`. That is the closest thing to a multi-agent display
model Tandem has, and it was built for local models rather than for multiple
Claudes. Whether it generalises is an open question, not an assumption.

### 2.5 Which directories can even be instance roots

`resolveRouteCwd` (`supervisor.ts:1159`) home-confines every HTTP-supplied cwd and
rejects UNC paths, device namespaces, and non-directories. Issue #1282 (closed
2026-08-05) documents that this is a **class**, not an edge case: documents
outside `$HOME`, on external drives, in `/tmp`, on UNC shares, in
since-deleted folders, and — most importantly — the bundled `CHANGELOG.md` and
`sample/welcome.md` that Tandem itself auto-opens after every install and update,
which resolve inside the app bundle via `projectRoot`
(`src/server/index.ts:584`).

So a directory-scoped model must answer what happens to documents that cannot be
an instance root at all. They cannot simply be unserved.

### 2.6 Cost is the argument the technical analysis keeps burying

Each instance is a full Claude Code process with its own context and its own
token consumption. The event queue's flat fan-out means every instance is woken
by every wake-worthy event unless routing lands first — and the supervisor's wake
path writes a **user turn on stdin** (`supervisor.ts`, #1266), which is a billed
turn, not a cheap notification.

Auto-spawning by directory therefore converts "the user opened four tabs" into
four sessions and a multiplier on every subsequent annotation. Any design here
needs an explicit cost story before it needs an architecture.

---

## 3. Why the drift nudge was done first

The concrete user need behind the question is that **cwd determines what project
context Claude sees** — `CLAUDE.md`, `.claude/` settings, git, file-tool reach.
It does *not* determine what documents Claude can reach; Tandem's MCP tools take
absolute paths and are cwd-independent.

A single instance running in the right folder satisfies that need. The nudge makes
"the right folder" visible and one click away, using the relaunch mechanism that
already exists. It is a fraction of the cost and forecloses nothing here.

What it does **not** satisfy is genuinely separated concurrent conversations —
work and personal, each with its own history. That is the real motivation for
this note, and it is a project rather than a feature.

---

## 4. If this is ever picked up

Rough dependency order. Steps 1–2 are the existing spec's, unchanged:

1. Resolve the identity scheme (per-client-identity-spec §3.1, as re-scoped by its
   2026-07-30 amendment — the modern branch's answer is undecided).
2. Per-client inbox state (§3.3).
3. Per-instance supervisor state: session files, breakers, locks, and an
   addressing scheme across the launcher routes.
4. Directory→instance mapping policy (§2.2 above) — a product decision, and the
   one most likely to make or break the feature.
5. Per-scope mode, per-agent presence, cost controls.

Steps 3–5 are the new work. Step 4 should be settled with users before any of it.

**Open probes.** Does `AgentIdentity` generalise from local-model agents to
multiple Claude instances (§2.4)? Does presence actually collide in practice, or
only at scope boundaries? Is there a mapping granularity users can predict without
being taught one?
