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

**`scripts/ci/verify-updater-signatures.mjs`** (new). Two halves, and the split is what makes it
testable:

- `export function verifyMinisign({ publicKey, signature, data })` — pure. `publicKey` and
  `signature` are the base64-wrapped file bodies exactly as they appear in `tauri.conf.json` and
  `latest.json`. Returns a discriminated result (`{ ok: true }` / `{ ok: false, reason }`) rather
  than a bare boolean, with `reason` one of `"algorithm"`, `"key-id"`, `"signature"`,
  `"global-signature"`, `"malformed"`. **Reject an unexpected algorithm explicitly** — a legacy
  `Ed` (non-prehashed) signature must not fall through to a `false` that reads like tampering, and
  must not be silently accepted by hashing differently.
- CLI `main()` — reads `plugins.updater.pubkey` from `src-tauri/tauri.conf.json`, lists the release's
  assets, downloads `latest.json`, **dedupes the DOWNLOAD by `url`** — caching the fetched *bytes*
  keyed by url — and then **verifies all 11 `platforms[*]` entries, each against its own
  `signature` field**. The distinction is the whole gate: the 11 keys resolve to 7 distinct URLs
  (`darwin-*`/`-app`, `linux-x86_64`/`-appimage`, `windows-x86_64`/`-nsis` pair up), so deduping
  the *verification* would leave 4 of 11 `signature` strings never read — a complete-looking gate
  silently checking less, which is the exact shape #1830 exists to remove. Fetch with
  `Accept: application/octet-stream` + `Authorization: Bearer ${GH_TOKEN}`, and
  fail with a message naming every platform key that did not verify and why. Env: `GH_TOKEN`,
  `GH_REPO`, `RELEASE_ID`. Exit 1 on any failure; exit 1 (never 0) if it cannot evaluate — no
  artifacts, no manifest, a fetch error. A gate reporting success when it could not evaluate is the
  #1229 failure mode named in `ci.yml:419-421`.

**`tauri-release.yml`, `verify-release-manifest` job** — two steps added, the existing
`github-script` step left byte-identical (it has no `checkout`, so its script cannot read the repo;
keeping it untouched keeps the manifest-shape gate and the signature gate independently reviewable):

```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Verify updater signatures against tauri.conf.json pubkey
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
   - **one url, two keys, one bad signature** — a manifest fixture where two platform keys share a
     `url` and carry *different* `signature` values, only one of which verifies. The failure must
     **name the bad key**. *Kills:* the dedupe-the-verification implementation that checks 7 of 11.
2. **`tests/scripts/release-ci-hygiene.test.ts`** (the group's shared new file), one describe —
   ADR-051 wiring, modelled on `tests/scripts/release-signing-gates.test.ts`, whose helpers this
   should reuse in shape: find the step **by the `# gate:updater-sig` marker inside its own `run`
   body** (a YAML comment is not in the parse tree — see the Fix section), never by `name:`;
   **throw** if the finder returns nothing or more than one; pin `run`, `env` and `shell` by exact
   equality **including the marker line**, the way `APPLE_GATE_RUN` does, so the anchor and the
   assertion are the same string; assert `if` and `continue-on-error` are absent on the step;
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

Eight unit cases green (the six original, with the key-id one split in two and the shared-url one
added); the wiring describe green; `node scripts/ci/verify-updater-signatures.mjs` run by hand
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
