# I-release — #1830 nothing verifies the updater `.sig` against `tauri.conf.json`'s pubkey

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1830.** Ledger: `tracks/I-supply-chain.md`
§"Three exposures". Probe: the local verification of v0.25.0's real published artifact, below.

## Problem

`tauri-release.yml:300-306` "Validate updater signing key" asserts only that
`TAURI_SIGNING_PRIVATE_KEY` is non-empty. `verify-release-manifest` (`:844-933`) asserts every
platform key is present, every `url` resolves to an attached asset, and every entry has a
**non-empty** `signature` string (`:928`) — never that the signature *verifies*. So a private key
that no longer matches `plugins.updater.pubkey` (`src-tauri/tauri.conf.json:110`) ships green and
breaks the update on every installed copy, and the failure surfaces as user reports weeks later.

## Fix — verified feasible before being written

Measured against the real v0.25.0 release, not assumed:

- `latest.json`'s `signature` for `windows-x86_64` is **byte-identical** to the published
  `Tandem_0.25.0_x64-setup.exe.sig` asset. The manifest is the right target: it is what the updater
  reads.
- The 11 platform keys point at **7 distinct asset URLs** (`darwin-*`/`-app`, `linux-x86_64`/
  `-appimage`, `windows-x86_64`/`-nsis` each pair up), ~460 MB total.
- Format: `.sig` is base64 of a minisign file. Signature algorithm is `ED` (**prehashed**,
  BLAKE2b-512); pubkey algorithm `Ed`; key id `2756cc98332f5a23` on both. Verified locally with
  Node's built-in crypto — `createHash("blake2b512")` + `crypto.verify(null, digest, spki, sig)` —
  **artifact signature `true`, trusted-comment global signature `true`.** No minisign binary, no
  apt install, no new dependency.

**`scripts/ci/verify-updater-signatures.mjs`** (new). **Three** halves, not two, and the split is
what makes it testable. Round 1 exported only `verifyMinisign` and then asked for a unit case
("one url, two keys, one bad signature") that `verifyMinisign` structurally cannot express — it
takes a single `{publicKey, signature, data}` triple, so "11 keys, 7 downloads, name the bad key"
is a property of the manifest walk, which lived only inside `main()` with no export and no test.
Followed as written, the implementer would have dropped the case or invented an export, and the
exact wrong implementation this issue exists to remove (dedupe the *verification*, leaving 4 of 11
`signature` strings never read) would ship with the unit suite green. The same gap left "exit 1
(never 0) if it cannot evaluate" asserted by nothing, in a step that first executes at a `v*` tag.
So:

- `export function verifyMinisign({ publicKey, signature, data })` — pure. `publicKey` and
  `signature` are the base64-wrapped file bodies exactly as they appear in `tauri.conf.json` and
  `latest.json`. Returns a discriminated result (`{ ok: true }` / `{ ok: false, reason }`) rather
  than a bare boolean, with `reason` one of `"algorithm"`, `"key-id"`, `"signature"`,
  `"global-signature"`, `"malformed"`. **Reject an unexpected algorithm explicitly** — a legacy
  `Ed` (non-prehashed) signature must not fall through to a `false` that reads like tampering, and
  must not be silently accepted by hashing differently.
- `export async function verifyManifest({ publicKey, platforms, fetchBytes })` — the manifest walk,
  pure of the network and of `process.env`. `platforms` is `latest.json`'s `platforms` object;
  `fetchBytes(url)` is injected and returns the asset bytes. It **dedupes the DOWNLOAD by `url`** —
  caching the bytes `fetchBytes` returned, keyed by url — and then **verifies all 11
  `platforms[*]` entries, each against its own `signature` field**, returning
  `{ ok, results: [{key, ok, reason}], failures: [{key, reason}] }`. The distinction is the whole
  gate: the 11 keys resolve to 7 distinct URLs (`darwin-*`/`-app`, `linux-x86_64`/`-appimage`,
  `windows-x86_64`/`-nsis` pair up — measured against the real v0.25.0 manifest), so deduping the
  *verification* would leave 4 of 11 `signature` strings never read. **It must throw, never resolve
  `ok`, when it cannot evaluate**: an empty or absent `platforms` object, an entry with no
  `signature`, or a `fetchBytes` rejection. That is the "cannot evaluate" contract, and putting it
  on this seam is what makes it assertable — inside `main()` it was asserted by nothing.
- CLI `main()` — **env-reading plus one call to `verifyManifest`, and nothing else.** It reads
  `plugins.updater.pubkey` from `src-tauri/tauri.conf.json` and `GH_TOKEN` / `GH_REPO` /
  `RELEASE_ID` from the environment, lists the release's assets, downloads `latest.json`, passes
  `platforms` and a `fetchBytes` closure to `verifyManifest`, prints one line per platform key, and
  exits 1 on `!ok` **or on a throw** with a message naming every platform key that did not verify
  and why. Guard it behind an explicit entrypoint check
  (`if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))`), so
  importing the module from a test runs no CLI, reads no env and makes no request.
  `fetchBytes` uses `fetch` with `Accept: application/octet-stream` +
  `Authorization: Bearer ${GH_TOKEN}` and reads the body with `arrayBuffer()`. **Do not copy the
  octokit body-parsing shape from the neighbouring step** (`tauri-release.yml:893-904`): that long
  comment exists because octokit picks its parser from the *response* content-type, so `latest.json`
  can arrive pre-parsed and `Buffer.from(raw)` throws `ERR_INVALID_ARG_TYPE`. `fetch` +
  `arrayBuffer()` always yields bytes, so that branch does not apply here and must not be
  reproduced. The manifest's `platforms[*].url` values are asset **API** URLs, not browser download
  URLs (`tauri-release.yml:917-919` states this), which is what makes a token-authenticated fetch
  work against a still-unpublished draft. A gate reporting success when it could not evaluate is the
  #1229 failure mode named in `ci.yml:419-421`.

**`tauri-release.yml`, `verify-release-manifest` job** — two steps added, the existing
`github-script` step left byte-identical (it has no `checkout`, so its script cannot read the repo;
keeping it untouched keeps the manifest-shape gate and the signature gate independently reviewable):

```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Verify updater signatures against tauri.conf.json pubkey
        shell: bash
        run: |
          # gate:updater-sig
          node scripts/ci/verify-updater-signatures.mjs
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          RELEASE_ID: ${{ needs.create-release.outputs.release_id }}
```

**The marker must live inside the `run` body, as a shell comment — not trailing the `name:` key.**
A YAML comment is absent from `yaml`'s parse tree (stated at `workflow-action-pin.test.ts:150-152`
and `:230-236`), so a marker on the `name:` line is invisible to the finder that is supposed to
locate the step by it. This is the shape the existing Apple gates already use: `APPLE_GATE_RUN`
(`release-signing-gates.test.ts:131`) begins with the literal line `# gate:apple-signing`, and
`stepByMarker` (`:81-90`) filters on `s.run.includes(marker)` and throws unless exactly one step
matches.

The job already carries `contents: write` for the draft-visibility reason its comment explains, and
that is what lets the asset download work. `#1832`'s `--ignore-scripts` does not apply — this job
runs no `npm ci`, and the script must therefore use **only** `node:` builtins.

Rules that bite: this file never runs on a PR, so the YAML change is unverified by construction —
say so plainly. `src-tauri/tauri.conf.json` is **read, never written** here; #1785's
`tests/docs/license-flip-consts.test.ts` pins the `LICENSE_UPDATE_ENDPOINT`/gate pair and is
untouched.

One in-tree docblock already asserts this gate exists: `tests/scripts/release-signing-gates.test.ts:14`
says "`verify-release-manifest` checks the shape **and updater signatures** of the manifest, not
Apple signing." That is false today — `tauri-release.yml:928` only checks `p.signature` is a
non-empty string — and this PR is what makes it true. **Leave the line as-is and say so in the PR
body**, so a reviewer who finds it does not re-derive it as a refutation of #1830.

## Tests

1. **`tests/scripts/verify-updater-signatures.test.ts`** (new) — unit, against
   `verifyMinisign`. Generate an Ed25519 keypair in the test and hand-build a minisign `ED`
   signature file, so there is no fixture and no committed key. Cases, each named by the wrong
   implementation it kills:
   - valid signature → `{ ok: true }` (*kills* a verifier that never returns true);
   - one flipped byte in `data` → `reason: "signature"` (*kills* a verifier that only compares key
     ids — the cheap check that would pass everything else);
   - **two cases here, not one, and each names its fixture explicitly** — a minisign key id is 8
     random bytes chosen at keygen, *not* derived from the public key (confirmed against this
     repo's own pubkey: `src-tauri/tauri.conf.json:110`'s untrusted comment carries
     `minisign public key: 235A2F3398CC5627`, the byte-reversal of the `2756cc98332f5a23` read out
     of the file). So "a different keypair" alone does not determine which reason comes back:
     - (a) different keypair **and** different key-id bytes → `reason: "key-id"`;
     - (b) different keypair but the **same** key-id bytes → `reason: "signature"`. This is the one
       that kills a key-id-only verifier, at the point where writing one is most tempting.
     A single "different keypair → key-id" case would reuse the fixture's own id bytes, come back
     `"signature"`, and silently assert the wrong thing;
   - algorithm bytes changed `ED` → `Ed` → `reason: "algorithm"` (*kills* the silent-fallthrough
     that would hash the file wrong and report tampering);
   - tampered trusted comment → `reason: "global-signature"` (*kills* a verifier that stops at the
     artifact signature; minisign's trusted comment is the half an attacker can rewrite freely);
   - truncated / non-base64 input → `reason: "malformed"`, never a throw.

   **A second describe in the same file, against `verifyManifest`** — this is where the walk's
   properties live, and they cannot be expressed against `verifyMinisign` (see the Fix section).
   Drive it with a stub `fetchBytes` that records its calls:
   - **one url, two keys, one bad signature** — a `platforms` fixture where two keys share a `url`
     and carry *different* `signature` values, only one of which verifies. Assert **11 results from
     7 `fetchBytes` calls** (build the fixture with the real pairing shape), `ok === false`, and
     that `failures` **names the bad key**. *Kills:* the dedupe-the-verification implementation that
     checks 7 of 11 — the exact wrong shape #1830 exists to remove;
   - **cannot evaluate: no `platforms` entry** (empty object, or a key whose entry has no
     `signature`) → it **throws**, and specifically does not resolve `{ ok: true }`;
   - **cannot evaluate: `fetchBytes` rejects** → it **throws**, not a swallowed `ok`.
   The last two are the assertable form of "exit 1, never 0, if it cannot evaluate", which nothing
   asserted while that logic lived in `main()`.
2. **`tests/scripts/release-ci-hygiene.test.ts`** (the group's shared new file), one describe —
   ADR-051 wiring, modelled on `tests/scripts/release-signing-gates.test.ts`, whose helpers this
   should reuse in shape: find the step **by the `# gate:updater-sig` marker inside its own `run`
   body** (a YAML comment is not in the parse tree — see the Fix section), never by `name:`;
   **throw** if the finder returns nothing or more than one; pin `run` and `env` by exact equality
   **including the marker line**, the way `APPLE_GATE_RUN` does, so the anchor and the assertion are
   the same string; and pin `shell` as the literal `"bash"` — the prescribed YAML block now carries
   `shell: bash` for exactly this reason. (The sibling asserts
   `step.shell === "bash" || step.shell === "pwsh"` at `release-signing-gates.test.ts:396-397`,
   which fails against an absent `shell`; round 1 told the implementer to pin a key its own YAML did
   not have, and the way out would have been to weaken the assertion.) assert `if` and `continue-on-error` are absent on the step;
   assert the `checkout` step precedes it. **And pin the job-level disarm vectors, which the sibling
   test already treats as required** (`release-signing-gates.test.ts:400`, "not at the job or
   workflow level either"): assert the job's `needs` still contains `create-release` and
   `build-tauri`; assert the job's `if` by the exact literal `needs.build-tauri.result == 'success'`
   — **absent is also a regression here**, since a missing `if` would run the gate on a failed
   build; and assert the job carries no `continue-on-error`. *Kills:* `|| true`,
   `continue-on-error: true` at either level, an `if:` that stops matching, and deleting the step
   outright — the four shapes ADR-051's eighth instance names, each of which leaves `check` green
   with the anchor dead.

**No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers this issue**; there is
no still-broken-when output to convert into an assertion.

## Done when

Ten unit cases green — seven against `verifyMinisign` (the six original, with the key-id one split
in two) and three against `verifyManifest` (shared-url/11-from-7, and the two cannot-evaluate
throws); the wiring describe green; `node scripts/ci/verify-updater-signatures.mjs` run by hand
against the real v0.25.0 release id, printing **11 `ok` lines — one per platform key, not 7** (that
IS runnable here and must be run — it is the only end-to-end evidence this PR can produce); the PR
body states that the workflow step itself has never executed and will first run at the next `v*`
tag, and notes that `release-signing-gates.test.ts:14` already claimed this gate existed and is
made true rather than corrected.

## Not in scope

Verifying Apple notarization or Authenticode (`release-signing-gates.test.ts` / #1746 own those).
Rotating or changing the pubkey. Any change to `plugins.updater.endpoints` — that is Bryan's and
#1785 already settled that the public endpoint is verified at the flip rather than neutralised.
Publishing the draft.

## Review corrections (round 1)

**Adopted.**

- **BLOCKING — the step marker was placed where the parser cannot see it.** The spec put
  `# gate:updater-sig` as a YAML comment trailing `name:`, then told the implementer to find the
  step by that marker using `release-signing-gates.test.ts`'s `stepByMarker`, which filters on
  `s.run.includes(marker)` and throws unless exactly one step matches. YAML comments are absent
  from `yaml`'s parse tree (`workflow-action-pin.test.ts:150-152`, `:230-236`), so the finder would
  throw on every run and the two ways out are both wrong. The YAML block now puts the marker inside
  the `run` body as a shell comment — the shape `APPLE_GATE_RUN`
  (`release-signing-gates.test.ts:131`) already uses — and the wiring test pins `run` by exact
  equality *including* that line, so anchor and assertion are one string.
- **"Dedupes platform entries by `url`" was implementable as deduping the verification**, leaving
  4 of 11 `signature` strings never read — and it contradicted the spec's own Done-when. Reworded
  to dedupe the **download** (cache bytes keyed by url) and verify all 11 keys each against its own
  signature; Done-when now says 11 `ok` lines, not 7; and a unit case was added (two keys, one url,
  one bad signature — the failure must name the bad key). Two review findings raised this; one
  rewrite covers both.
- **The `key-id` unit case was under-specified and would assert the wrong reason.** A minisign key
  id is 8 random bytes chosen at keygen, not derived from the pubkey (confirmed against
  `tauri.conf.json:110`'s `235A2F3398CC5627` ↔ `2756cc98332f5a23`), so "a different keypair" with
  the fixture's own id bytes yields `"signature"`. Split into (a) different keypair + different id
  → `key-id`, (b) different keypair + same id → `signature`.
- **The wiring describe pinned step-level disarm vectors but not job-level ones**, though the
  sibling test already treats those as required (`release-signing-gates.test.ts:400`). Added: the
  job's `if` pinned by the exact literal `needs.build-tauri.result == 'success'` (absent is a
  regression — it would run the gate on a failed build) and no job-level `continue-on-error`.
- **`release-signing-gates.test.ts:14` already claims this gate exists** and is currently wrong.
  Left as-is (this PR makes it true) with a required note in the PR body so it is not re-derived as
  a refutation of #1830.
- **No experiment covers this issue** — stated in `## Tests`.

**Not adopted.** None.

**File set:** unchanged — new `scripts/ci/verify-updater-signatures.mjs`, new
`tests/scripts/verify-updater-signatures.test.ts`, a describe in the shared
`tests/scripts/release-ci-hygiene.test.ts`, and two steps added to `.github/workflows/tauri-release.yml`.
`src-tauri/tauri.conf.json` stays read-only.

## Review corrections (round 2)

**Adopted.**

- **BLOCKING — the anti-vacuity case could not be written as specified.** Verified: round 1 defined
  the only pure export as `verifyMinisign({publicKey, signature, data})`, scoped the whole describe
  as "unit, against `verifyMinisign`", and then placed the shared-url/dedupe case inside it — but
  that case is a property of the manifest walk (11 `EXPECTED` keys collapsing to 7 URLs,
  `tauri-release.yml:868-873`), which lived only in `main()` with no export and no test. Followed
  as written, the implementer drops the case or invents an export, and the dedupe-the-verification
  implementation ships with the suite green. Adopted the fix: a second pure export,
  `verifyManifest({publicKey, platforms, fetchBytes})`, returning `{ok, results, failures}`;
  `main()` reduced to env-reading plus one call to it, behind an explicit entrypoint guard so an
  import runs no CLI; the shared-url case moved onto that seam with a recording stub asserting **11
  results from 7 `fetchBytes` calls** and a named bad key; and two cannot-evaluate cases (no
  `platforms` entry, `fetchBytes` rejects) asserting a throw — which is the assertable form of the
  spec's "exit 1, never 0, if it cannot evaluate", previously asserted by nothing in a step that
  first runs at a `v*` tag. Done-when now says ten unit cases.
- **The wiring describe pinned a `shell` key the prescribed YAML did not have.** Verified:
  `release-signing-gates.test.ts:396-397` asserts `step.shell === "bash" || step.shell === "pwsh"`,
  which fails against `undefined`. Added `shell: bash` to the prescribed step and pinned it as the
  literal `"bash"`, matching the sibling — rather than leaving the implementer to resolve the
  contradiction by weakening the assertion.
- **The new script must not reuse the neighbouring step's octokit body-parsing shape.** Verified at
  `tauri-release.yml:893-904` (content-type-driven parser, `Buffer.from` on a pre-parsed body throws
  `ERR_INVALID_ARG_TYPE`). Added to the Fix section: `fetchBytes` uses `fetch` + `arrayBuffer()`,
  which always yields bytes, so that branch does not apply and must not be reproduced — plus one
  line confirming `platforms[*].url` values are asset **API** URLs (`:917-919`), which is what makes
  the token-authenticated fetch work against an unpublished draft.

**Not adopted.** None.

**File set:** unchanged — new `scripts/ci/verify-updater-signatures.mjs` (now exporting
`verifyMinisign` **and** `verifyManifest`), new `tests/scripts/verify-updater-signatures.test.ts`
(two describes), a describe in the shared `tests/scripts/release-ci-hygiene.test.ts`, and two steps
added to `.github/workflows/tauri-release.yml`. `src-tauri/tauri.conf.json` stays read-only.
