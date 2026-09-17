# I-release — #1830 nothing verifies the updater `.sig` against `tauri.conf.json`'s pubkey

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1830.** Track home: `tracks/I-supply-chain.md`
§"Three exposures".

## Problem

`tauri-release.yml:300-306` "Validate updater signing key" asserts only that
`TAURI_SIGNING_PRIVATE_KEY` is non-empty. `verify-release-manifest` (`:844-933`) asserts every
platform key is present, every `url` resolves to an attached asset, and every entry has a
**non-empty** `signature` string (`:928`) — never that the signature *verifies*. So a private key
that no longer matches `plugins.updater.pubkey` (`src-tauri/tauri.conf.json:110`) ships green and
breaks the update on every installed copy, surfacing as user reports weeks later.

## Fix — verified feasible against the real v0.25.0 release

- `latest.json`'s `signature` for `windows-x86_64` is **byte-identical** to the published
  `Tandem_0.25.0_x64-setup.exe.sig` asset. The manifest is the right target: it is what the updater
  reads.
- The 11 platform keys point at **7 distinct asset URLs** (`darwin-*`/`-app`,
  `linux-x86_64`/`-appimage`, `windows-x86_64`/`-nsis` each pair up), ~460 MB total.
- `.sig` is base64 of a minisign file; signature algorithm `ED` (prehashed, BLAKE2b-512). Verified
  locally with Node builtins — `createHash("blake2b512")` + `crypto.verify(null, digest, spki, sig)`
  — artifact signature `true`, trusted-comment global signature `true`. No minisign binary, no new
  dependency.

**`scripts/ci/verify-updater-signatures.mjs`** (new): two pure exports plus a thin CLI. The split is
what makes the walk testable — the wrong implementation this issue exists to remove (dedupe the
*verification*, leaving 4 of 11 `signature` strings unread) is a property of the walk, not of a
single-signature check.

- `export function verifyMinisign({ publicKey, signature, data })` — pure; `publicKey` and
  `signature` are the base64-wrapped file bodies exactly as they appear in `tauri.conf.json` and
  `latest.json`. Returns `{ ok: true }` / `{ ok: false, reason }`, `reason` one of `"algorithm"`,
  `"key-id"`, `"signature"`, `"global-signature"`, `"malformed"`. **Reject an unexpected algorithm
  explicitly** — a legacy non-prehashed `Ed` signature must not fall through to a `false` that reads
  like tampering, nor be accepted by hashing differently.
- `export async function verifyManifest({ publicKey, platforms, fetchBytes })` — the manifest walk,
  pure of the network and of `process.env`. It **dedupes the DOWNLOAD by `url`** (caching the bytes
  `fetchBytes` returned) and then **verifies all 11 `platforms[*]` entries, each against its own
  `signature`**, returning `{ ok, results: [{key, ok, reason}], failures: [{key, reason}] }`. It
  **must throw, never resolve `ok`, when it cannot evaluate**: an empty or absent `platforms`
  object, an entry with no `signature`, or a `fetchBytes` rejection. That is the assertable form of
  "exit 1, never 0, if it cannot evaluate" — a gate reporting success when it could not evaluate is
  the #1229 failure mode named in `ci.yml:419-421`.
- CLI `main()` — **env-reading plus one call to `verifyManifest`, nothing else.** Reads
  `plugins.updater.pubkey` from `src-tauri/tauri.conf.json` and `GH_TOKEN`/`GH_REPO`/`RELEASE_ID`
  from the environment, lists the release's assets, downloads `latest.json`, passes `platforms` and a
  `fetchBytes` closure, prints one line per platform key, and exits 1 on `!ok` or on a throw, naming
  every key that did not verify and why. Guard it behind an entrypoint check
  (`process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`) so an
  import runs no CLI, reads no env, makes no request. `fetchBytes` uses `fetch` with
  `Accept: application/octet-stream` + `Authorization: Bearer ${GH_TOKEN}` and `arrayBuffer()` —
  **do not copy the octokit body-parsing shape from the neighbouring step** (`:893-904`), whose
  content-type-driven parser is the reason that comment exists; `arrayBuffer()` always yields bytes.
  `platforms[*].url` values are asset **API** URLs (`:917-919`), which is what makes a
  token-authenticated fetch work against a still-unpublished draft. #1832's `--ignore-scripts` does
  not apply — this job runs no `npm ci`, so the script must use **only** `node:` builtins.

**`tauri-release.yml`, `verify-release-manifest` job** — two steps added, the existing
`github-script` step left byte-identical (it has no `checkout`, so keeping it untouched keeps the
shape gate and the signature gate independently reviewable):

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

**The marker must live inside the `run` body as a shell comment**, not trailing `name:`: a YAML
comment is absent from `yaml`'s parse tree (`workflow-action-pin.test.ts:150-152`), so a marker on
the `name:` line is invisible to the finder. This is the shape `APPLE_GATE_RUN`
(`release-signing-gates.test.ts:131`, `stepByMarker` at `:81-90`) already uses. The job already
carries `contents: write` for the draft-visibility reason its comment explains, which is what lets
the asset download work. `src-tauri/tauri.conf.json` is **read, never written**; #1785's
`tests/docs/license-flip-consts.test.ts` is untouched.

Rules that bite: this file never runs on a PR, so the YAML change is unverified by construction —
say so plainly. Note in the PR body that `release-signing-gates.test.ts:14` already claims
"`verify-release-manifest` checks the shape **and updater signatures**"; that line is false today and
this PR makes it true, so leave it as-is rather than re-deriving it as a refutation of #1830.

## Tests

1. **`tests/scripts/verify-updater-signatures.test.ts`** (new). Generate an Ed25519 keypair in the
   test and hand-build a minisign `ED` file — no fixture, no committed key.
   - Against `verifyMinisign`: valid → `{ ok: true }`; one flipped byte in `data` →
     `reason: "signature"` (*kills* a verifier that only compares key ids); a signature from a
     different keypair → `ok: false` (assert the failure, not which reason — a minisign key id is 8
     random bytes chosen at keygen, not derived from the key, so pinning `"key-id"` here asserts the
     fixture rather than the code); algorithm bytes `ED` → `Ed` → `reason: "algorithm"`; tampered
     trusted comment → `reason: "global-signature"`; truncated/non-base64 → `reason: "malformed"`,
     never a throw.
   - Against `verifyManifest`, with a stub `fetchBytes` that records its calls: **one url, two keys,
     one bad signature** — a `platforms` fixture with the real pairing shape where two keys share a
     `url` and carry different `signature` values, only one of which verifies. Assert **11 results
     from 7 `fetchBytes` calls**, `ok === false`, and that `failures` **names the bad key**.
     *Kills:* the dedupe-the-verification implementation that checks 7 of 11. Then **three**
     cannot-evaluate cases — an entry with no `signature`, a rejecting `fetchBytes`, and
     **`platforms: {}` plus `platforms` absent** — each must **throw**, not resolve `{ ok: true }`.
     The empty/absent pair is the one that kills the default implementation: a straightforward
     `for (const [k, p] of Object.entries(platforms)) …; return { ok: failures.length === 0 }`
     resolves `{ ok: true, results: [] }` on `{}` — a gate reporting success having verified
     nothing, the exact #1229 shape this spec cites. Assert the throw, not a `reason`.
2. **A describe in `tests/scripts/release-ci-hygiene.test.ts`** (the shared file #1832 lands) —
   ADR-051 wiring, since the step first executes at a `v*` tag. Find the step **by the
   `# gate:updater-sig` marker inside its own `run` body**, throw if the finder returns zero or more
   than one, pin `run` and `env` by exact equality **including the marker line**, assert `if` and
   `continue-on-error` are absent on the step, and assert the `checkout` step precedes it (without it
   the script cannot read `tauri.conf.json`). *Kills:* `|| true`, `continue-on-error`, an `if:` that
   stops matching, and deleting the step outright. **Plus exactly one job-level assertion:**
   `expect(job["continue-on-error"]).toBeUndefined()` for `verify-release-manifest` — the parsed
   field, with no `?? false` (ADR-051 rule 4). A single `continue-on-error: true` on the job greens
   both the existing shape gate and this new signature gate at once, in a workflow no required check
   reads; the precedent is `typecheck-tests-wiring.test.ts:145-148` ("a job-level
   continue-on-error masks every step"). The `needs` and `if` literal pins stay deleted — those are
   drift guards on a job this issue did not ask us to change.

No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers this issue.

## Done when

Ten unit cases green (six against `verifyMinisign`, four against `verifyManifest`); the wiring
describe green; `node scripts/ci/verify-updater-signatures.mjs` run **by hand against the real
v0.25.0 release id**, printing **11 `ok` lines — one per platform key, not 7** (runnable here, and
the only end-to-end evidence this PR can produce); the PR body states that the workflow step itself
has never executed and first runs at the next `v*` tag.

## Not in scope

Verifying Apple notarization or Authenticode (#1746 owns those). Rotating or changing the pubkey. Any
change to `plugins.updater.endpoints` — Bryan's, and #1785 already settled that the public endpoint
is verified at the flip rather than neutralised. Publishing the draft.

## Review corrections (scope cut)

**Removed.** The job-level disarm pins (`needs` contains `create-release`/`build-tauri`, the job `if`
pinned to the literal `needs.build-tauri.result == 'success'`, no job-level `continue-on-error`) —
drift guards on a job this issue did not ask us to change; the step-level pins that *are* about our
own step stay. The `shell: bash` key and its literal pin — added in round 2 only to satisfy a sibling
test's assertion we are no longer copying; ubuntu's default shell is bash. The two-case key-id split,
replaced by one wrong-key case asserting failure rather than a reason determined by fixture bytes.
The round-1/round-2 logs, folded into the body.

**Finding fixed directly.** *"The anti-vacuity case cannot be written as specified."* The
shared-url/dedupe case and the cannot-evaluate contract now sit on `verifyManifest`, a real export,
with `main()` reduced to env-reading behind an entrypoint guard.

**File set:** new `scripts/ci/verify-updater-signatures.mjs`, new
`tests/scripts/verify-updater-signatures.test.ts`, one describe in
`tests/scripts/release-ci-hygiene.test.ts`, two steps in `.github/workflows/tauri-release.yml`.
`src-tauri/tauri.conf.json` stays read-only.

## Review corrections (post-cut)

**Adopted, two.**

- *"The contract names a cannot-evaluate clause the Tests section allocates no case to, and the
  natural implementation violates it."* `verifyManifest` "must throw … an empty or absent
  `platforms` object", but the Tests bullet enumerated only the no-`signature` and rejecting-
  `fetchBytes` cases and Done-when said three. A plain
  `Object.entries(platforms)` walk returning `{ ok: failures.length === 0 }` resolves
  `{ ok: true, results: [] }` for `{}` — success having verified nothing. `platforms: {}` and
  `platforms` absent are now a required fourth case; Done-when reads **ten** unit cases (six + four).
- *"The scope cut removed every job-level disarm pin, so a single `continue-on-error: true` on
  `verify-release-manifest` greens both the existing shape gate and the new signature gate."*
  Exactly one line comes back — `expect(job["continue-on-error"]).toBeUndefined()`, the parsed field
  with no `?? false`, matching `typecheck-tests-wiring.test.ts:145-148`. It **amends** the scope-cut
  "Removed" bullet above: the `needs` literal pin and the `if:` literal pin stay removed (the job
  legitimately carries `if: needs.build-tauri.result == 'success'` and re-pinning it is the drift
  guard the cut correctly dropped); only the disarm assertion is restored, and it costs one line.
