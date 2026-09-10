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
  assets, downloads `latest.json`, **dedupes platform entries by `url`**, downloads each unique
  asset once with `Accept: application/octet-stream` + `Authorization: Bearer ${GH_TOKEN}`, and
  fails with a message naming every platform key that did not verify and why. Env: `GH_TOKEN`,
  `GH_REPO`, `RELEASE_ID`. Exit 1 on any failure; exit 1 (never 0) if it cannot evaluate — no
  artifacts, no manifest, a fetch error. A gate reporting success when it could not evaluate is the
  #1229 failure mode named in `ci.yml:419-421`.

**`tauri-release.yml`, `verify-release-manifest` job** — two steps added, the existing
`github-script` step left byte-identical (it has no `checkout`, so its script cannot read the repo;
keeping it untouched keeps the manifest-shape gate and the signature gate independently reviewable):

```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Verify updater signatures against tauri.conf.json pubkey  # gate:updater-sig
        run: node scripts/ci/verify-updater-signatures.mjs
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          RELEASE_ID: ${{ needs.create-release.outputs.release_id }}
```

The job already carries `contents: write` for the draft-visibility reason its comment explains, and
that is what lets the asset download work. `#1832`'s `--ignore-scripts` does not apply — this job
runs no `npm ci`, and the script must therefore use **only** `node:` builtins.

Rules that bite: this file never runs on a PR, so the YAML change is unverified by construction —
say so plainly. `src-tauri/tauri.conf.json` is **read, never written** here; #1785's
`tests/docs/license-flip-consts.test.ts` pins the `LICENSE_UPDATE_ENDPOINT`/gate pair and is
untouched.

## Tests

1. **`tests/scripts/verify-updater-signatures.test.ts`** (new) — unit, against
   `verifyMinisign`. Generate an Ed25519 keypair in the test and hand-build a minisign `ED`
   signature file, so there is no fixture and no committed key. Cases, each named by the wrong
   implementation it kills:
   - valid signature → `{ ok: true }` (*kills* a verifier that never returns true);
   - one flipped byte in `data` → `reason: "signature"` (*kills* a verifier that only compares key
     ids — the cheap check that would pass everything else);
   - signature from a **different** keypair → `reason: "key-id"` (*kills* a verifier that ignores
     the pubkey argument entirely and validates the sig against itself);
   - algorithm bytes changed `ED` → `Ed` → `reason: "algorithm"` (*kills* the silent-fallthrough
     that would hash the file wrong and report tampering);
   - tampered trusted comment → `reason: "global-signature"` (*kills* a verifier that stops at the
     artifact signature; minisign's trusted comment is the half an attacker can rewrite freely);
   - truncated / non-base64 input → `reason: "malformed"`, never a throw.
2. **`tests/scripts/release-ci-hygiene.test.ts`** (the group's shared new file), one describe —
   ADR-051 wiring, modelled on `tests/scripts/release-signing-gates.test.ts`, whose helpers this
   should reuse in shape: find the step **by the `# gate:updater-sig` marker inside its own body**,
   never by `name:`; **throw** if the finder returns nothing; pin `run`, `env` and `shell` by exact
   equality; assert `if` and `continue-on-error` are absent; assert the `checkout` step precedes it;
   assert the job's `needs` still contains `create-release` and `build-tauri` so the step can fire.
   *Kills:* `|| true`, `continue-on-error: true`, an `if:` that stops matching, and deleting the
   step outright — the four shapes ADR-051's eighth instance names, each of which leaves `check`
   green with the anchor dead.

## Done when

Six unit cases green; the wiring describe green; `node scripts/ci/verify-updater-signatures.mjs`
run by hand against the real v0.25.0 release id reports all 11 platform keys verified (that IS
runnable here and must be run — it is the only end-to-end evidence this PR can produce); the PR body
states that the workflow step itself has never executed and will first run at the next `v*` tag.

## Not in scope

Verifying Apple notarization or Authenticode (`release-signing-gates.test.ts` / #1746 own those).
Rotating or changing the pubkey. Any change to `plugins.updater.endpoints` — that is Bryan's and
#1785 already settled that the public endpoint is verified at the flip rather than neutralised.
Publishing the draft.
