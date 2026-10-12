# How Tandem licensing works

> One document, two readings. **Part 1** is for anyone — no code, no jargon.
> **Part 2** is the engineering detail. **Part 3** is the failure modes, which
> is the part worth reading twice.
>
> Related: [ADR-040](decisions.md) (the decision),
> [licensing-operations.md](licensing-operations.md) (the runbook — what to *do*),
> [licensing-terms.md](licensing-terms.md) (what a purchase grants),
> [security.md](security.md), [data-locations.md](data-locations.md).
>
> **Status: the whole system ships dark.** Everything below is built and tested, and none
> of it does anything to a user today.
>
> **Going live is TWO constants, in two languages** ([#1785](https://github.com/bloknayrb/tandem/issues/1785)).
> `const LICENSE_GATE_ENABLED` in `tsup.config.ts` turns the run gate on, and
> `const LICENSE_UPDATE_ENDPOINT: &str = ""` in `src-tauri/src/lib.rs` must be pointed at
> the deployed Worker. While that string is empty, `resolve_update_route()` short-circuits on
> its first line and `build_updater()` takes its `Public` arm, `app.updater()` — so **every
> build today, licensed or not, checks the PUBLIC manifest** from `src-tauri/tauri.conf.json`,
> and the `X-Tandem-License-Id` path described in Part 2 is unreachable code. Flipping only
> the first const ships a gate whose update window is not actually enforced;
> `tests/docs/license-flip-consts.test.ts` refuses that half-flip.
>
> **Symbol names, not line numbers, on purpose.** This banner is the flip checklist, and it
> already sent an operator to the wrong line once: the number that used to sit here landed on
> `LICENSE_STATUS_URL`, one const above the target — also a URL, also license-related, so
> "point it at the Worker" repoints
> the loopback probe instead — after which `update_route` answers
> `NoUpdates("status-unavailable")` for *every* device, licensed and trial alike, with only a
> `log::warn!` to show for it. A line number in a file under active edit is a pointer that
> goes stale silently; grep the const name.

---

# Part 1 — The plain-English version

## The idea in four sentences

You buy Tandem once. You get a **license key** by email — a long block of
letters and numbers, plus a `tandem.license` file attached. You paste the key in
(**double-clicking the file does nothing** — Tandem registers no `.license` file
association; its only associations are `.md`/`.markdown`, `.txt` and `.html`,
`src-tauri/tauri.conf.json:74-96`), and Tandem is yours: it keeps working forever, on
any computer you personally use, with no internet connection required to prove
it. Every future update is included too, with no time limit, though no one can
promise that future updates will come.

**Where you paste it depends on which Tandem you're running.** On the desktop app
the only route is Settings → License; the desktop bundle ships no `tandem`
command, so there is nothing to run. The `tandem activate <file>` command belongs
to the npm install, and it writes into **that install's own app-data
directory** — so running a separately installed CLI to license a desktop app
succeeds and changes nothing the desktop can see. Nothing reports that, which is
why it is worth stating here. That holds even if you reach the desktop's own
editor through a browser (it serves the same UI on `http://127.0.0.1:3479`): the
server there still reads the desktop's app-data directory, so Settings → License
is still the only route, and it stops offering the command accordingly.

## What you get, precisely

| | |
|---|---|
| **The version you have** | Yours forever. No subscription, no expiry, and no licence check over the network. |
| **New versions** | All future updates are included, for as long as they are released. There is no update year, no renewal and no paid upgrade. No future update is guaranteed. |
| **Devices** | Any computer you personally use. |
| **Offline** | Activation and running work with the network unplugged — no server is ever asked whether your licence is valid. (Checking for *updates* does contact us, and sends an opaque id. See Part 2.) |

## Why the key is so long

It's a **signed document**, not a password. Inside it are your name, your email,
what kind of license it is, and an update-window field that issued keys leave
empty — all sealed with a
cryptographic signature that Tandem can check by itself, offline.

That's the whole trick. Tandem doesn't need to ask a server "is this key real?",
because the key *proves it's real* on its own. That's what makes activation work
on a plane, and what means we never learn when or how often you use the app.

The cost is length: you can't make a self-proving document short. So we made
sure you never have to type it. The email attaches it as a file, and you can
paste it in one go.

## Before any of that: the public beta is free for personal use

Everything on this page describes v1.0 and later. **Every pre-1.0 release is free
for personal use and individual self-hosting, with no time limit and nothing to
activate.** That is the first paragraph of the BUSL Additional Use Grant in
[LICENSE](../LICENSE), so it is a term you are granted rather than an enforcement
gap you are getting away with. The grant also reaches back: it covers every
pre-1.0 release that shipped under an earlier wording of the licence, including
v0.14.2 to v0.25, whose own `LICENSE` offered only a thirty-day evaluation. Releases
before v0.11.0, and the v0.11.0 to v0.14.3 desktop builds whose package metadata
said MIT, are MIT-licensed. None of it is enforced: the gate ships dark, so a
beta build has no trial clock running at all and the three states below are
unreachable in it.

At v1.0 the gate flips and the 14-day trial starts for new installs. **Beta users
are grandfathered with a free license and skip the trial entirely** — see the
claiming instructions in the README, which matter because Tandem has no telemetry
and therefore no list of beta users to work from.

## The three states Tandem can be in

1. **Trial** — 14 days from first launch. Everything works. A banner counts down.
2. **Licensed** — you activated a key. Everything works, forever.
3. **Restricted** — the trial ended and there's no license. **Your documents are
   never held hostage:** Tandem stays a working editor. You can open, edit, save
   and export your documents. What a key adds is the AI features, such as Claude
   (or any other agent) over the MCP server, the chat panel and local models. The
   [LICENSE](../LICENSE) grants exactly that: v1.0 and later may be used without
   a key, for personal use and individual self-hosting, provided the use does
   not include the AI features.

That third one matters and is easy to get wrong, so to be blunt: **we do not
lock you out of your own files.** They're plain files on your disk, and nothing
stops you opening them anywhere else.

**The server already works this way; the editor's own screens follow.** Since
#1521's server half, an unlicensed Tandem refuses Claude, chat, push and the
local model, and never refuses an edit; the MCP refusal and `tandem license` say
so. The in-app copy is the next step: until it lands, the license wall
(`src/client/components/LicenseWall.svelte`) and the Settings and banner text
still describe the earlier design, where documents went read-only. None of it is
reachable while the gate ships dark.

## If something goes wrong

Every failure now says which failure it is, because "License could not be
verified" was previously shown for eight different problems — including ones
that were entirely our fault.

| What you see | What it actually means |
|---|---|
| "That's longer than a license key…" | You pasted the whole email. Just the long block, or use the attachment. |
| "That doesn't look like a license key." | Something got mangled in copying. |
| "This key wasn't issued for this build…" | Genuinely ours to fix — email support and we'll reissue it. |
| "This license needs a newer version of Tandem." | Update Tandem, then activate. |
| "Your license is valid, but Tandem couldn't save it…" | Our problem, not your key. A permissions issue on your machine's app-data folder. |

One more, worth knowing about: if a license file is already installed but stops
verifying, Tandem now says **that**, instead of telling you your trial ended —
which was especially wrong for beta testers who never had a trial.

## The thing we most want to avoid

There's one failure that looks exactly like everything being fine: your license
works, Tandem runs, but you silently stop being offered updates — and the app
cheerfully reports **"You're up to date"** forever.

Half of that is now closed on the device itself: if *this* copy of Tandem can see
that its own update window has ended, a manual check for updates says so and
points at Settings → License, rather than claiming you are current. The other
half — the case where the device still believes it is entitled and the server
disagrees — is invisible from here (it arrives as an ordinary "nothing new"
response), so the server's own refusal reason stays the authoritative detector.

That's the worst kind of bug, because nobody files a ticket for it. A large part
of the engineering below exists purely to make that state detectable.

---

# Part 2 — How it actually works

## The pieces

```
  Buyer                Polar            Cloudflare Workers          Their machine
    |                    |                      |                        |
    |--- pays ---------->|                      |                        |
    |                    |-- order.paid ------->| issuance Worker        |
    |                    |   (svix-signed)      |  . verify signature    |
    |                    |                      |  . mint + Ed25519-sign |
    |                    |                      |  . write LEDGER_KV     |
    |                    |                      |  . write LICENSE_KV    |
    |<---- email with .license attachment ------|  . send via Resend     |
    |                                           |                        |
    |------------- paste / tandem activate --------------------------->  |
    |                                           |         verify offline against
    |                                           |         the pinned public key
    |                                           |                        |
    |                    update check           |<-- X-Tandem-License-Id-|
    |                    update Worker -------->|  200 manifest, or 204  |
```

Four moving parts:

1. **`infra/license-issuance-worker/`** — a Cloudflare Worker. Receives Polar's
   webhook, mints and signs the license, records it, emails it.
2. **`infra/license-update-worker/`** — a second Worker. Decides whether a given
   license id may be served the update manifest.
3. **`src/server/license/`** — the on-device gate. Verifies, tracks the trial,
   and enforces.
4. **`scripts/sign-license.ts`** — the operator's out-of-band path, for
   complimentary licenses and for the buyer whose mail provider ate theirs.

## The license itself

```jsonc
// base64 of this:
{
  "metadata": {
    "id": "…uuid…",          // opaque; the only thing sent over the network
    "name": "Jane Doe",
    "email": "jane@example.com",
    "type": "personal",       // personal | commercial | grandfathered
    "createdAt": "2026-07-26T…",
    "expiresAt": null,        // END OF UPDATE WINDOW (null = none, every issued key) — never end of the license
    "version": "1.0"
  },
  "signature": "…Ed25519 over canonicalize(metadata)…"
}
```

`canonicalize` sorts keys recursively so the signed bytes are deterministic
across platforms. Ed25519 is deterministic per RFC 8032, which is load-bearing
elsewhere: re-signing the same metadata produces a byte-identical blob, so a
resend can be reconstructed from the ledger without storing the blob.

**`expiresAt` is the single most misread field in this system.** It governs the
update window and nothing else. The run gate deliberately calls
`verifyLicenseSignature` (signature only) rather than `verifyLicense` (signature
+ expiry) — and the type system enforces that: the run gate demands a
`SignatureVerified` branded type that only the signature-only function can
produce, so wiring in the stricter one is a **compile error**. Without that,
someone "tidying up" the two near-identical verifiers would silently lock out
every holder of a dated key the day its window ended. Since 2026-10-09 every
issued key has `expiresAt: null` (all future updates included, ADR-040 decision
A5), so a date appears only on a key hand-signed with `--expires`; the guard
stays, because the field and the stricter verifier both still exist.

## On-device state resolution

`resolveLicenseState()` answers "what is this machine entitled to", and is
**deliberately cache-free** — it re-reads from disk on every call. A cache
caused two-writer staleness and mid-session-expiry bugs, so the cost (one small
file read, at most one Ed25519 verify) is paid per dispatch instead.

```
gate dark?                      -> { gateActive: false }              (today, always)
license.json verifies?          -> licensed          (runs forever)
   ...doesn't verify?           -> record WHY, fall through
trial.json says < 14 days?      -> trial
otherwise                       -> restricted
```

The result is a discriminated union, so illegal combinations are
unrepresentable — you cannot construct a restricted state carrying a license.

`licenseUnverifiable` carries a **code**, not a boolean: "have it reissued",
"the file is damaged" and "update Tandem" are three different user actions, and
a boolean forced every surface to hedge across all three in one sentence. It
deliberately is **not** a fourth `status` value, because the AI-surface
decision (`aiRefusal()`) branches on `status === "restricted"` — a new status
would **fail open** at every admission point until it was updated.

## Enforcement: one decision, at the AI's admission points

The licence (since [#2174](https://github.com/bloknayrb/tandem/pull/2174)) and ADR-040 as amended on
2026-10-11 say the same thing: *after the 14-day trial, Tandem remains a usable editor, but with no
AI features.* So enforcement refuses **the AI**, never the editor, and it does so in one place:

```
aiRefusal()  ->  null                                     (dark build, trial, licensed)
             ->  { error: "LICENSE_REQUIRED",
                   kind: "unlicensed" | "unverifiable",
                   message }                              (restricted)
```

`src/server/license/ai-refusal.ts` returns `null` on its first line while the gate ships dark, and
re-reads disk on every call like `resolveLicenseState` does — no memo, because a cache is what caused
the mid-session-expiry bugs. `kind: "unverifiable"` means a licence file is installed but fails to
verify; its message is the fix-or-reissue copy from `unverifiableLicenseMessage()` and **never carries
the purchase URL**, because that reader most likely already paid. `kind: "unlicensed"` carries the URL.
The wire envelope is that object everywhere: the `/api` 403 body, and the `data` of the MCP error.

Until #1521 enforcement worked the other way round, and that history explains several tests: **Surface
A** marked Hocuspocus document rooms read-only, and **Surface B** (`gatedTool()` on 14 MCP write tools,
`licenseGateMiddleware` on 7 `/api` routes, plus two in-handler `licenseGate()` calls) refused content
writes — while chat, push and Claude's read tools stayed open. All of that is deleted.

### The gated set

There is no longer a per-operation gated set. What is enumerated instead is the set of **admission
points**, each of which asks `aiRefusal()`:

| Admission point | Where | Refused how |
|---|---|---|
| MCP over HTTP | `POST /mcp` (top of the handler, above the `isInit` branch) and `GET /mcp` (before `dispatchToSession`) in `src/server/mcp/server.ts` | `initialize`: HTTP 200 + JSON-RPC error `-32003` with `data: { error, kind, purchaseUrl? }`, no session created. A request on a live session gets the same error and the session is closed. A bare notification: 202, dropped. `GET`: 403 with the envelope. `DELETE` is admitted, so teardown works. |
| Stdio server mode (`TANDEM_TRANSPORT=stdio`, env-only) | `startMcpServerStdio` | Refused at start: every request is answered with the same error. Not re-checked mid-session. |
| Claude's chat writes | `appendClaudeChatMessage()` in `src/server/mcp/awareness.ts` | Returns `{ ok: false, refusal }`; `tandem_reply` answers with the error, `POST /api/channel-reply` answers 403 before stamping anything read. |
| The approval relay | `POST /api/channel-permission` and `POST /api/channel-permission-verdict` | 403 with the envelope. |
| Push / wake fan-out | `pushEvent` in `src/server/events/queue.ts` | A refused event is not forwarded and **not recorded** as pushed or as an unanswered ask. External subscribers that supplied `onRevoke` are cut off. |
| SSE `/api/events` | `sseHandler` | 403 before `writeHead`, so `Last-Event-ID` replays nothing; a live stream is ended by its revoke hook. |
| WS `/api/wake` | `onUpgrade`, after the pure `verifyWakeUpgrade` | 403 with a JSON body; a live socket is closed `4403 LICENSE_REQUIRED`. |
| The launcher's Claude Code | `startInternal` and `respawn` in `src/server/launcher/supervisor.ts` | Boot, the deferred start and crash-respawn refuse by **returning** (`lastError: "unlicensed"`); relaunch and start-fresh refuse by **throwing** before anything is stopped, and the routes answer 403 `LAUNCHER_UNLICENSED`. `POST /api/license/activate` resumes a refused launcher (`resumeAfterLicence`). |
| Local-model collaborator | `onEvent` in `src/server/local-model/collaborator.ts` | Per run: no turn, no chat write, one stderr line per refused state. |

**Open, deliberately:** every browser and editor write — the seven routes Surface B gated
(`scratchpad`, `apply-changes`, `document/reload`, `backups/restore`, `external-conflict/resolve`,
`annotation-reply`, `remove-annotation`), `POST /api/open` including `force: true`, save, rename,
convert, mode release and `DELETE /api/chat` — plus licence activation itself, `/health`, launcher
status, and the shim's diagnostics (`channel-awareness`, `channel-error`). `tandem_resolveAnnotation`
is **kept**: ADR-040 decision 2 planned to retire it, but with the handshake refusing unlicensed
Claude, retiring it would only take dismissal away from licensed users, so that is split out of #1521.

**Both halves are CI-enforced.** `tests/server/license-gate-api-coverage.test.ts` holds one row per
mutating `/api` route — `refused`, `refused-by-supervisor` or `open`, each with a written reason —
fails closed on a new route with no row, sweeps for a registrar file outside the five it knows, and
fails if `licenseGateMiddleware`, `licenseGate()` or `gatedTool()` reappear anywhere in `src/server`.
`tests/server/license-gate-coverage.test.ts` pins the handshake (armed: refused, and a fresh-trial twin
admitted) and that the check sits above the `isInit` branch. `tests/server/license-module-seam.test.ts`
pins which files import each `src/server/license/` module, and that the bundles built without the
licence `define` — the stdio bridge, the channel shim, the plugin monitor, the shared SSE consumer —
reach none of them; those key only on the wire payload `error === "LICENSE_REQUIRED"`.
`tests/server/license-armed-restricted.test.ts` is the armed probe of every admission point above,
each paired with a fresh-trial twin.

**What the clients do with a refusal.** The stdio bridge relays the server's error verbatim. If a
replayed handshake is refused mid-session it latches that error, answers every request with it, and
retries every 30 seconds, so activation is picked up without a restart; a non-licence failure clears
the latch. (A host whose *first* `initialize` was refused has already been told by its SDK that the
server failed, and needs a restart after activation.) The shared SSE consumer treats a
`LICENSE_REQUIRED` 403 as a refusal, not an outage — no retry ladder, no `channel-error` report — and
retries every 5 minutes; the plugin monitor prints the refusal once on stdout. `tandem doctor` reads
`GET /api/license/status` once, adds a licence row (silent when dark, recording only `gateActive`,
`status` and `licenseUnverifiable`, never the holder's name or email), and the push and SSE rows defer
to it.

**Accepted residuals** (Bryan, D5): an unlicensed Claude Code with shell access can still reach
Tandem's local endpoints directly, which is equivalent to editing the file on disk; an open session is
cut at its next request or event, not at the instant of expiry; stdio server mode is not re-checked
mid-session; and events buffered while unlicensed — including the user's own chat — replay to the
first consumer admitted after activation.

These are **licence-enforcement residuals, not security findings**, so none of them is owed a row in
[security.md's register](security.md#open-findings). An AI with shell access acts with the user's own
privileges, on the user's own files and the user's own loopback server; nothing in any of them crosses
a trust boundary. What they bound is how completely the licence is enforced, not who can do what.

Two more, of the same kind:

- **A licence file that exists but cannot be read is treated as unverifiable, for that moment.**
  `resolveLicenseState` re-reads `license.json` on every call, and a read error that is not ENOENT (an
  antivirus or sync-client lock: `EBUSY`, `EPERM`), an unparseable body, or a body with no `blob` all
  resolve `unverifiable` — the fix-or-reissue copy, never the purchase link, and never an unlock. A
  transient lock therefore refuses the AI only for as long as it lasts, with one side effect each: an
  SSE consumer refused in that window backs off 5 minutes before retrying, and a launcher refused at
  boot stays down until the restart chip (or an activation) brings it back.
- **A local-model run that started while licensed keeps streaming after expiry.** The collaborator is
  checked per run, not per token, so one in-flight reply finishes. Behind `BYO_MODELS_ENABLED`, so
  unreachable today; revisit if that flag flips.

## AI surfaces — the #1346 inventory

> **The axis the surface gate is drawn on.** #1346 asked whether every AI surface could share one
> enforcement point; it could not be answered while nothing enumerated the *surfaces* (the old gated
> set was an inventory of **operations**, a different axis). This section is that enumeration, and
> since #1521 every row has its admission point. `tests/docs/ai-surface-inventory-claims.test.ts`
> derives the chat and push rows from source and checks that each choke point calls the licence
> decision, so this list cannot silently go short.

An **AI surface** is any path by which a model reads document state, writes it, or learns that it
changed. Six exist:

| # | Surface | Admission point | Refused since #1521 |
|---|---|---|---|
| 1 | MCP over HTTP (`:3479`) | the `/mcp` handshake (`POST`/`GET` in `src/server/mcp/server.ts`) | yes — before any tool is reachable |
| 2 | MCP over stdio | `src/cli/mcp-stdio.ts` (bridge) | **inherits row 1**: relays the refusal, latches it mid-session |
| 3 | `/api` mutating twins | Express registrars | **not an AI surface** — see below |
| 4 | Chat | `appendClaudeChatMessage()`, plus `/api/channel-*` | yes |
| 5 | Event push / wake | `pushEvent` and `subscribe(cb, "external")` (SSE, wake socket, supervisor) | yes; the launcher's spawn too |
| 6 | Local-model collaborator | `onEvent`, per run | yes |

**Row 2 is free.** The bridge registers no handlers and forwards raw messages, so refusing at row 1
also refuses Claude Desktop and Cowork. It only needed to stop calling a licence refusal "session
lost", which is what its latch does.

**Row 3 is the browser, and correcting that removed work rather than adding it.** Every one of the
seven routes Surface B gated is called from `src/client/` and nowhere else — `annotation-reply` and
`remove-annotation` from `panels/annotation-actions.ts`, `apply-changes` from
`ApplyChangesButton.svelte`, `scratchpad` and `backups/restore` from `actions/builtin.svelte.ts`,
`document/reload` from `editor/SourceView.svelte`, `external-conflict/resolve` from
`ExternalConflictBanner.svelte`; and `POST /api/open` with `force: true` from
`client/utils/server-paths.ts`. They are the **browser's** write path, twins of an MCP tool only in
that both end at the same Y.Doc. Keyless editing is granted, so #1521 deleted their gates outright.
The genuinely AI-facing `/api` surface is the `/api/channel-*` family plus `/api/events` and
`/api/wake` — rows 4 and 5.

Worth stating plainly, because the opposite reading is available and alarming: *an unlicensed install
serves `POST /api/apply-changes` ungated.* It does, and that is correct — but for a narrower reason
than "the caller owns the document", which these routes do not establish. `annotation-reply` and
`remove-annotation` are two of the **six** routes that call neither `assertLoopbackForMutation` nor
`assertOriginAllowlisted` (the inventory in `CLAUDE.md`); what stands behind them is the **path-wide
loopback invariant** and nothing else. `apply-changes` holds `assertOriginAllowlisted` as well, to
close a simple-request CSRF. So the accurate claim is *any loopback-local process*, which is the same
trust boundary they had before — the licence gate was never what kept them safe, and removing it takes
nothing away. Their authorization posture is a separate question, tracked in
[security.md](security.md#open-findings).

**Rows 4 and 5 inverted.** Before #1521 they were open on purpose: `CTRL_ROOM` was exempt from
Surface A so chat could survive as the "read-only escape hatch", and `shouldForwardExternally` passed
`chat:message` unconditionally for the same reason. Under the amended policy chat *is* the AI
integration, so the thing once kept alive on purpose is now the thing most clearly refused. The
user's own chat writes over Hocuspocus are untouched; only Claude's side is refused.

**Row 6 lost its private copy.** `src/server/local-model/tools.ts` used to carry a third copy of the
gate on its three mutating tools — the pattern of each new AI surface discovering it was outside the
gate and growing its own check. It now has none: the collaborator refuses per run, before dispatch.

### What is *not* an AI surface

**The human's editor.** Surface A clamped Hocuspocus document rooms to read-only, which was backwards
under the amended policy — it stopped the user editing and resolving their own annotations. It is
deleted, not rewritten. `CTRL_ROOM` writes (Solo/Tandem mode, dwell, `openDocuments`) are the
browser's and stay writable.

### The choke points

The surfaces share no call path (a WebSocket upgrade, JSON-RPC dispatch, Express, and an in-process
function call cannot be routed through one interception), but each has one narrow admission point,
and those are where `aiRefusal()` is consulted:

- The MCP session handshake — rows 1 and 2 together.
- `appendClaudeChatMessage()` — every AI chat write: `tandem_reply`, `POST /api/channel-reply`, the collaborator.
- `pushEvent` plus `subscribe(cb, "external")` — every push consumer: SSE `/api/events`, WS `/api/wake`, the supervisor's stdin.
- The supervisor's spawn — the launcher's own Claude Code.
- The collaborator's per-run check — row 6.

That changed the per-tool cost of a new MCP tool from two licence edits to zero: a new tool is behind
the handshake by construction. The refusal copy says *unlicensed*, never *expired* or *trial ended*
(ADR-040 decision 5), and the old "reading, opening and exporting still work" promise is gone with the
per-tool gate it described — the user keeps opening, reading and exporting in the editor, and the AI
reads nothing.

## Delivery: why the email looks the way it does

The `.license` attachment's `content` is **`btoa(blob)`** — base64 of the
*file's bytes*. The blob is already base64 *text*, so it gets encoded twice.
Passing it through once yields a file containing raw `{"metadata":…}` JSON,
which the verifier rejects.

The inline copy is hard-wrapped at 72 characters and the body is pure 7-bit
ASCII. Both are delivery correctness, not style:

> A long line or a single non-ASCII byte pushes a mail transfer agent to
> re-encode the body as **quoted-printable**, which inserts a soft line break —
> an `=` at end of line. base64 reads that interior `=` as **padding** and
> silently truncates the key. The buyer gets a rejection for a key that left our
> Worker intact.

72, not 76: QP's 76-character limit *includes* the trailing `=`, so wrapping at
exactly 76 still leaves lines an encoder wants to break.

There are three independent defenses against this one failure, because it's
silent: the attachment bypasses the body entirely, the wrap and ASCII keep an
encoder from reaching for QP, and the receiving end repairs soft breaks anyway.

**What is deliberately *not* defended against:** whitespace, hard wrapping,
zero-width characters, non-breaking spaces, smart quotes, and the base64url
alphabet all decode fine — verified, and pinned by tests. Two earlier rounds of
this work proposed "hardening" against them that would have **rejected keys that
activate correctly today**.

> A cautionary note about that last one, because it's a good example of a
> confident wrong answer. An earlier draft of this document asserted that a
> licence blob can *never* contain `+` or `/`, reasoning that base64 emits them
> only from the bytes `>`, `?`, `~` and DEL at one sextet position, and that
> none of those appear in the JSON. The arithmetic is right; the premise isn't.
> `cleanName` doesn't strip those characters and the email check permits them in
> the local part — so a buyer called `Who?` produces a blob containing `/`. The
> claim was false and the test that "proved" it only ever ran on names that
> happened to avoid the issue. It doesn't matter in the end, because Node's
> decoder treats the two alphabets as equivalent regardless — but the fix was to
> assert *that*, not the unsupportable "never".

## Updates, and the endpoint that must not lie

> **None of this runs today.** `LICENSE_UPDATE_ENDPOINT` is `""` (`src-tauri/src/lib.rs`),
> so the updater takes the `app.updater()` branch and checks the public GitHub manifest for
> every build. Everything in this section, and the failure mode in Part 3, describes what
> happens **after** that const is pointed at the Worker
> ([#1785](https://github.com/bloknayrb/tandem/issues/1785)).

The desktop updater sends only an opaque UUID (`X-Tandem-License-Id`) — never
the key, the name, or the email. The Worker looks it up and either proxies the
signed public manifest or returns `204`.

Every rejection returns **byte-identical** bytes, so the endpoint is not an
existence oracle. It logs `{result, reason, ts}` — the reason is a closed enum
describing *our* state (`no-header`, `unknown-id`, `unparseable`, `expired`,
`revoked`, `upstream`), never the license id, so no per-customer update history
exists. `revoked` is the operator's own tombstone — a refund or a hand-run
revocation — and is deliberately the one absence that does *not* raise an alert.

That `reason` field is a handful of lines of code and it is the most important
observability in the system. See Part 3.

---

# Part 3 — The failure modes

## The silent one

```
no LICENSE_KV entry
  -> Worker returns 204
    -> tauri-plugin-updater early-returns Ok(None)
      -> the app tells the user "You're up to date."
        -> forever
```

The trap is that `build_updater()` calls `.endpoints(vec![endpoint])`, which
**replaces** the endpoint list. The public manifest is *not* a fallback. An
earlier version of the runbook stated the opposite — "the updater simply uses
the public GitHub endpoint — no error" — and that sentence is precisely the
mental model that produced the bug.

The state is reachable at least five ways: a failed entitlement write, a refund
(which revokes the entitlement while the blob still verifies forever), the
documented revocation procedure, KV eviction, and a namespace-id mismatch
between the two `wrangler.toml` files. The first two are *deliberate*, and they
now write a revocation tombstone rather than deleting the key, so the Worker can
tell the operator's own action apart from an entitlement that simply vanished.

**Detection:** the Worker POSTs an operator alert on `unknown-id` /
`unparseable`, and `[observability]` retains the log lines behind it. A `reason`
enum on its own was never a detector — nothing kept the lines and nothing
notified anyone. Merged but **inert until both Workers are redeployed** with
`[observability]` and `ALERT_WEBHOOK_URL` set.
**Repair:** re-`PUT` the entitlement from the ledger — it's fully derivable, so
nothing needs re-issuing.

## The one that loses sales without a trace

Polar disables a webhook endpoint after repeated consecutive failures. So:

```
unverified RESEND_FROM -> Resend 422 -> Worker returns retryable 500
  -> Polar retries ~10x -> endpoint disabled
    -> every subsequent sale arrives nowhere
      -> and writes NO ledger record at all
```

This is why reconciliation **enumerates from Polar's order list, not the
ledger**. A ledger-rooted scan for `emailSent: false` is structurally blind to
it — those orders have no record to find. Polar's own delivery log is the only
surface that shows the disable.

## Why alerts don't go through the thing that's broken

Operator alerts fire on `dropped` results and email-stage failures. The
email-stage alert deliberately does **not** route through Resend — Resend is
what just failed — and degrades to a webhook, or is dropped with an
`alert-undeliverable` log line rather than sent down the broken path.

A non-2xx response from the alert webhook counts as a failure, not a delivery: a
retired Slack webhook 404s rather than throwing, and treating that as success
would silently swallow every alert in the one piece of code whose entire purpose
is to not be missed.

## Things that are deliberately soft

Worth stating plainly, because they look like bugs:

- **The trial clock has no anti-rollback.** Deleting `trial.json` restarts it.
  The signed license is the only hard gate; the trial is a courtesy.
- **A refund does not stop the software running.** It can't — activation is
  air-gapped by design. Consumer law obliges returning money, not technical
  revocability.
- **Nothing enforces the device count.** "Any device you personally use" is an
  honour-system limit, and the terms say so rather than implying otherwise.
- **In restricted mode a Claude Code with shell access can still reach Tandem
  out of band** — edit the file on disk (the watcher reloads it) or call
  Tandem's local endpoints directly. Tandem refuses the AI at its own admission
  points; it cannot refuse a process editing the user's files, and does not try
  (accepted residual, #1521).

## What is not built yet

- **Key rotation.** There is one pinned public key and no `keyId`, so rotating
  drops every existing customer to restricted, mid-session. Making the verifier
  accept an *array* of keys is a few lines and would make rotation routine —
  but adding a `keyId` to the signed metadata changes the signed bytes, so that
  variant is now-or-never, before the first sale.
- **A resend-my-license endpoint.** Deferred past ~25 sales; manual re-signing
  is adequate and safer at that volume, and it doesn't help the case that
  actually prompts it (mail quarantine).
- **A commercial SKU.** `issue()` hardcodes the type to `personal` (or
  `grandfathered`), so a commercial purchase would be **silently issued a
  personal licence** rather than rejected. A personal key already covers an
  employee doing their own work (`LICENSE` defines personal use as one natural
  person's), so what is unsellable today is a shared or hosted deployment, and
  checkout copy must exclude that explicitly until an SKU→type map exists.
- **Atomicity on concurrent deliveries.** Workers KV has no compare-and-swap.
  `issue()` and `revoke()` each re-read immediately before their first commit,
  which narrows the race to one KV round trip but does not close it. Closing it
  needs a Durable Object per order.
- **The legal documents.** See [licensing-terms.md](licensing-terms.md) — a
  working draft exists. No counsel is being consulted, so the licensor writes
  the real ones.
