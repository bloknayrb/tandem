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
> **Status: the whole system ships dark.** `LICENSE_GATE_ENABLED = false` in
> `tsup.config.ts`. Everything below is built and tested, and none of it does
> anything to a user today.

---

# Part 1 — The plain-English version

## The idea in four sentences

You buy Tandem once. You get a **license key** by email — a long block of
letters and numbers, plus a `tandem.license` file attached. You paste the key in
(or double-click the file), and Tandem is yours: it keeps working forever, on
any computer you personally use, with no internet connection required to prove
it. For the first year you also get new versions as they're released.

## What you get, precisely

| | |
|---|---|
| **The version you have** | Yours forever. No subscription, no expiry, and no licence check over the network. |
| **New versions** | For one year from purchase. |
| **After that year** | Tandem keeps running exactly as it is. You're just not offered new releases until you renew. |
| **Devices** | Any computer you personally use. |
| **Offline** | Activation and running work with the network unplugged — no server is ever asked whether your licence is valid. (Checking for *updates* does contact us, and sends an opaque id. See Part 2.) |

## Why the key is so long

It's a **signed document**, not a password. Inside it are your name, your email,
what kind of license it is, and when your update year ends — all sealed with a
cryptographic signature that Tandem can check by itself, offline.

That's the whole trick. Tandem doesn't need to ask a server "is this key real?",
because the key *proves it's real* on its own. That's what makes activation work
on a plane, and what means we never learn when or how often you use the app.

The cost is length: you can't make a self-proving document short. So we made
sure you never have to type it. The email attaches it as a file, and you can
paste it in one go.

## The three states Tandem can be in

1. **Trial** — 14 days from first launch. Everything works. A banner counts down.
2. **Licensed** — you activated a key. Everything works, forever.
3. **Restricted** — the trial ended and there's no license. **Your documents are
   never held hostage:** you can still open them, read them, export them, and
   talk to Claude about them. What stops is Tandem's own editing.

That third one matters and is easy to get wrong, so to be blunt: **we do not
lock you out of your own files.** They're plain files on your disk. Tandem is
the thing that stops editing them; nothing stops you opening them anywhere else.

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
    "expiresAt": "2027-07-26T…", // END OF UPDATE WINDOW — not end of the license
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
every paid user the day their update year ended.

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
deliberately is **not** a fourth `status` value, because both enforcement
surfaces branch on `status === "restricted"` — a new status would **fail open**
at both until every gate was updated.

## Enforcement: two surfaces, both server-side

A client-side check would be theatre — browser edits flow over Hocuspocus, not
MCP, so gating only the MCP tools would leave the front door open.

- **Surface A** — `provider.ts onAuthenticate` marks document rooms read-only
  when restricted. Not `CTRL_ROOM`: chat, mode and awareness stay live, which is
  what keeps the escape hatch real.
- **Surface B** — `gatedTool()` wraps Claude's mutating MCP tools at
  *registration* time, and `licenseGateMiddleware` is its Express twin for the
  mutating `/api` routes.

Both re-resolve per dispatch. The MCP tool and its `/api` twin are gated as one
set (`tests/server/license-gate-coverage.test.ts` enforces this) — because an
MCP write bypasses Surface A entirely, so gating a route without its twin leaves
a hole.

### The gated set — this list IS the `/api` half's review

> **Shape superseded 2026-08-18 (#1346, ADR-040 amendment), still current as code.** The decision
> is that an unlicensed copy is a plain markdown editor with **no AI integration at all** — a
> *surface* gate, not the per-tool content-write gate enumerated below. Nothing has moved: this
> list remains an accurate description of the merged (dark) code and stays Critical Rule 9's review
> surface until the surface gate is implemented. Read it as "what is gated today", not "what the
> gate is for".

The MCP half is CI-enforced by `tests/server/license-gate-coverage.test.ts`. **The `/api` half
has no test: this enumeration is the review**, referenced by Critical Rule 9 in `CLAUDE.md`.
Adding a mutating MCP tool or `/api` route means adding it here, in both halves.

**MCP** — `tandem_edit`, `tandem_appendContent`, `tandem_editList`, `tandem_scratchpad`, `tandem_comment`,
`tandem_suggest`, `tandem_highlight`, `tandem_flag`, `tandem_editAnnotation`,
`tandem_annotationReply`, `tandem_removeAnnotation`, `tandem_applyChanges`,
`tandem_restoreBackup`.

**`/api`** — `apply-changes`, `annotation-reply`, `remove-annotation`, `document/reload`,
`external-conflict/resolve`, `backups/restore`, `scratchpad`.

`tandem_editList` has no `/api` twin, so the `/api` half of Critical Rule 9 is a no-op
for it. Stated rather than left silent: this list IS the `/api` half's review, and an
absence nobody wrote down reads the same as an omission.

Gate each pair together (`tandem_scratchpad` *and* `/api/scratchpad`). The three deprecated
stubs are gated too, so un-stubbing one cannot silently ship a hole.

**The gate has two mechanisms, and grepping `licenseGateMiddleware` finds only the first**: the
middleware mount, *plus* direct in-handler `licenseGate()` calls. `src/server/mcp/routes/open.ts`
gates the `force === true` sub-path of `POST /api/open`, mirroring the `tandem_open` MCP handler
— so a route can be gated without the middleware appearing anywhere near it. **Audit the handler
body, not the registration site.**

**Deliberately ungated:** all reads, *plain* `open` (only the destructive `force: true` reload is
gated, on both halves), save/export, `GET` routes, chat, and `tandem_resolveAnnotation` — a
status flip, not a content write.

## AI surfaces — the #1346 inventory

> **Discovery step for the ADR-040 amendment (#1346, decision 3).** The amendment asks whether
> every AI surface shares one enforcement point. It cannot be answered as written, because
> nothing enumerated the *surfaces*: the gated set above is an inventory of **operations**, which
> is a different axis, and it is why three of the six rows below appear nowhere in it. This
> section is that missing axis. It describes **today's code**, not the target design.
> `tests/docs/ai-surface-inventory-claims.test.ts` derives rows 4-6 from source and fails when a
> new AI surface appears, so this list cannot silently go short the way an unpinned enumeration
> does.

An **AI surface** is any path by which a model reads document state, writes it, or learns that it
changed. Six exist:

| # | Surface | Admission point | Enforcement today |
|---|---|---|---|
| 1 | MCP over HTTP (`:3479`) | per-session `McpServer`, `onsessioninitialized` | per-tool: 12 `gatedTool`, 1 conditional in-handler, 16 ungated |
| 2 | MCP over stdio | `src/cli/mcp-stdio.ts` | **inherits row 1** — pure JSON-RPC proxy, no handlers of its own |
| 3 | `/api` mutating twins | Express registrars | per-route: 7 middleware mounts + 1 in-handler — **but see below: these are the *user's* surfaces** |
| 4 | Chat | `appendClaudeChatMessage()` | **none** |
| 5 | Event push / wake | `subscribe(cb, "external")` | **none** |
| 6 | Local-model collaborator | in-process dispatch loop | its own third copy, 3 tools |

Three things follow that the amendment's three-surface framing does not predict.

**Row 2 is free.** `mcp-stdio.ts` registers no handlers and forwards raw messages, so refusing at
row 1 also refuses Claude Desktop and Cowork. There is no fourth transport to gate.

**Row 3 is misnamed, and correcting it removes work rather than adding it.** Every one of the seven
`licenseGateMiddleware`-gated routes is called from `src/client/` and nowhere else —
`annotation-reply` and `remove-annotation` from `panels/annotation-actions.ts`, `apply-changes` from
`ApplyChangesButton.svelte`, `scratchpad` and `backups/restore` from `actions/builtin.svelte.ts`,
`document/reload` from `editor/SourceView.svelte`, `external-conflict/resolve` from
`ExternalConflictBanner.svelte`. They are the **browser's** write path, twins of an MCP tool only in
that both end at the same Y.Doc. Under decision 1 the user keeps writing, so these are **ungated
outright**: they need no admission point. Deleting their middleware is *most* of the change, not
all of it — row 3's "+1 in-handler" is `POST /api/open` with `force: true`, which calls
`licenseGate()` directly in `src/server/mcp/routes/open.ts` and is also client-only
(`client/utils/server-paths.ts`). That call goes too, and it is exactly the kind of gate the
middleware grep does not find. The genuinely AI-facing `/api` surface is the `/api/channel-*`
family plus `/api/events` and `/api/wake` — rows 4 and 5.

Worth stating plainly, because the opposite reading is available and alarming: *"the reshape deletes
seven middleware mounts and Surface A, so an unlicensed install serves `POST /api/apply-changes`
ungated."* It does, and that is correct — but for a narrower reason than "the caller owns the
document", which these routes do not establish. `annotation-reply` and `remove-annotation` are two of the
**six** routes that call neither `assertLoopbackForMutation` nor `assertOriginAllowlisted` (the
inventory in `CLAUDE.md`); what stands behind them is the **path-wide loopback invariant** and
nothing else. `apply-changes` was a third until it gained `assertOriginAllowlisted` to close a
simple-request CSRF, so it now holds two layers — which does not change the argument here, since
the loopback invariant is still what the licensing claim rests on. So the accurate claim is *any loopback-local
process*, which is the same trust boundary they have today — the licence gate was never what kept
them safe, and removing it takes nothing away. Critical Rule 9 pairs an MCP tool with its `/api`
twin to stop a **content write** slipping past a content-write gate; once the gate is about
surfaces, that premise is gone, which is why the rule is rewritten rather than re-applied. Their
authorization posture is a separate question, unchanged here and tracked in
[security.md](security.md#open-findings).

**Rows 4-6 have no enforcement site at all, and rows 4-5 are not "missed" — they are
deliberately open.** `connectionShouldBeReadOnly` exempts `CTRL_ROOM` by design so chat survives
as the read-only escape hatch, and `shouldForwardExternally` passes `chat:message`
unconditionally for the same reason. Under decision 1 that inverts: chat *is* the AI integration,
so the thing kept alive on purpose becomes the thing most clearly refused. A grep for
`licenseGate|LicenseState|resolveLiveLicenseState` across `src/server/events/`, `src/channel/`,
`src/monitor/` and `src/server/launcher/` returns nothing.

**Row 6 documents its own hole.** `src/server/local-model/tools.ts` states that the loop "bypasses
both license enforcement surfaces (no Hocuspocus connection; not an MCP tool), so the THREE
mutating tools consult the gate here." That is accurate, and it is the pattern rather than an
oversight: each new AI surface discovers it is outside the gate and grows a private copy. Doubly
inert today (`BYO_MODELS_ENABLED` *and* `LICENSE_GATE_ENABLED` are both false), so it is a
template for the next mistake, not a live one.

### What is *not* an AI surface

**Surface A is the human's editor.** `applyConnectionGate` clamps Hocuspocus document rooms to
read-only, which under the amendment is backwards — decision 2 puts annotation accept/reject in
the editor UI, and a read-only clamp is exactly what would stop the user resolving their own
annotations. Surface A is deleted by the amendment, not rewritten.

### The choke points already exist

The reason a surface gate is tractable where "make the three agree" is not: the surfaces share no
call path (a WebSocket connection lifecycle, JSON-RPC dispatch, Express, and an in-process
function call cannot be routed through one interception), but each already has a single narrow
admission point, and three of the four are existing functions with all their callers in one place.

- `appendClaudeChatMessage()` — every AI chat write: `tandem_reply`, `POST /api/channel-reply`, the collaborator.
- `subscribe(cb, "external")` — every push consumer: SSE `/api/events`, WS `/api/wake`, the supervisor's stdin.
- The MCP session handshake — rows 1 and 2 together.
- The collaborator's start path — row 6.

That is **four admission checks**, against 20+ per-operation checks today, and it changes the
per-tool cost of Critical Rule 9 from two edits to zero.

### Two consequences, both settled 2026-08-19

**The read tools stop being safely ungated — settled 2026-08-19 (ADR-040 second amendment, decision 7).** Sixteen tools are ungated on the rule "reads are
the escape hatch", and `RESTRICTED_MESSAGE` promises it in so many words: *"Reading, opening and
exporting still work."* Decision 1 says an unlicensed copy has no AI integration at all, so the
escape hatch belongs to the **human's editor**, not to Claude — the user keeps opening, reading
and exporting, and the AI reads nothing. The sixteen are not correctly ungated; they are gated at
a layer the surface gate removes.

**The refusal copy contradicts decision 5 in three places.** Decision 5 is always "unlicensed",
never "expired". `RESTRICTED_MESSAGE` opens *"Your Tandem trial has ended"*; the collaborator's
`LICENSE_REQUIRED` body repeats it; `license-gate.ts`'s own docblock says *"trial expired"*. This
is copy, not mechanism — the `LicenseStatus` union (`"trial" | "licensed" | "restricted"`) is a
state name, and the 14-day trial clock is confirmed unchanged. The replacement strings are now
decided — see the copy table in ADR-040's second amendment (2026-08-19). This paragraph stands
until the code carries them, and `tests/docs/ai-surface-inventory-claims.test.ts` pins it to that
fact rather than to the intent.

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

The desktop updater sends only an opaque UUID (`X-Tandem-License-Id`) — never
the key, the name, or the email. The Worker looks it up and either proxies the
signed public manifest or returns `204`.

Every rejection returns **byte-identical** bytes, so the endpoint is not an
existence oracle. It logs `{result, reason, ts}` — the reason is a closed enum
describing *our* state (`no-header`, `unknown-id`, `unparseable`, `expired`,
`upstream`), never the license id, so no per-customer update history exists.

That `reason` field is five lines of code and it is the most important
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
(which deletes the entitlement while the blob still verifies forever), the
documented revocation procedure, KV eviction, and a namespace-id mismatch
between the two `wrangler.toml` files.

**Detection:** a rising `unknown-id` count. Nothing else distinguishes it from
health.
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
- **In restricted mode Claude can still edit the file on disk** and the watcher
  reloads it. Tandem's editing is gated; the filesystem isn't.

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
  personal licence** rather than rejected. Organisational use is therefore
  unsellable today and checkout copy must exclude it explicitly, until an
  SKU→type map exists.
- **Atomicity on concurrent deliveries.** Workers KV has no compare-and-swap.
  `issue()` and `revoke()` each re-read immediately before their first commit,
  which narrows the race to one KV round trip but does not close it. Closing it
  needs a Durable Object per order.
- **The legal documents.** See [licensing-terms.md](licensing-terms.md) — a
  working draft exists; the real ones need counsel.
