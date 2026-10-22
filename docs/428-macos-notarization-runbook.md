---
tags: [audience/maintainer, topic/release, topic/macos]
aliases: [macOS notarization runbook, macOS signing runbook, Notarization runbook]
---

# macOS Code-Signing & Notarization: Rotation and Recovery Runbook (#428)

[Home](README.md) › [Releases and operations](maps/releases-and-ops.md)

**Goal:** keep every Tandem macOS build launching cleanly on a fresh Mac with
**no Gatekeeper warning** — no "Tandem is damaged and can't be opened", no
"unidentified developer", no right-click → Open workaround.

That needs three things to be true at once:

1. An **active Apple Developer Program** membership, with its agreements signed.
2. The signing/notarization **secrets populated** in the GitHub repo.
3. Apple's **notary service healthy** at build time.

**Current state.** The secrets have been populated since 2026-05-15, and the
release workflow (`.github/workflows/tauri-release.yml`) signs, notarizes and
staples every macOS build. Since #1746 its macOS gates all **fail closed**:
"Validate Apple signing material" refuses to start the build if any value is
missing, "Decode App Store Connect API key" fails on an empty key, and "Verify
macOS signature + notarization" fails a bundle that is unsigned or has no
stapled ticket. So **a red macOS leg usually means a secret rotated or expired**
(or an Apple agreement lapsed), not that the workflow is broken. The per-release
check is the macOS signing row in
[release-smoke-checklist.md §0](release-smoke-checklist.md#0-ci-signal-before-touching-hardware).

Use this runbook when you need to rotate the certificate or API key, recover
from an expired Apple agreement, or ride out a notary outage. Sections 0–3 are
the steps for (re)creating the material; section 5 is how to prove it works
without cutting a real release.

---

## 0. Confirm enrollment cleared (you, not CI)

This is the one thing that cannot be checked from the repo. Verify on Apple's side:

- Go to <https://developer.apple.com/account> → **Membership details**.
- Confirm **Account status / Membership** shows **active** (not "Pending",
  "Enrollment in progress", or expired).
- Note your **Team ID** — the 10-character alphanumeric string (e.g.
  `A1B2C3D4E5`). You'll need it for `APPLE_TEAM_ID`.

If it still says pending, nothing below will work yet — Apple's identity
verification can lag a few business days after payment.

---

## 1. Generate the Developer ID Application certificate

This is the cert that signs the `.app`. It is **not** the same as a Mac App
Store cert — for direct distribution (DMG download) you need **Developer ID
Application**.

On a Mac with Xcode / the signing identity:

1. Keychain Access → Certificate Assistant → **Request a Certificate from a
   Certificate Authority** (save the `.certSigningRequest` to disk), **or** use
   the Apple Developer portal's "Create a New Certificate" flow.
2. Apple Developer portal → **Certificates** → **+** → **Developer ID
   Application** → upload the CSR → download the `.cer`.
3. Double-click the `.cer` to install it into the login keychain (it pairs with
   the private key the CSR created).
4. In Keychain Access, find **"Developer ID Application: <Your Name> (TEAMID)"**,
   right-click → **Export** → save as a `.p12` and set a strong password. That
   password becomes `APPLE_CERTIFICATE_PASSWORD`.
5. Base64-encode the `.p12` for GitHub Secrets:
   ```bash
   base64 -i Certificates.p12 | pbcopy   # macOS — copies to clipboard
   ```
   That value becomes `APPLE_CERTIFICATE`.
6. The full identity string ("Developer ID Application: Your Name (TEAMID)") is
   `APPLE_SIGNING_IDENTITY`. You can list it with:
   ```bash
   security find-identity -v -p codesigning
   ```

---

## 2. Create an App Store Connect API key (for notarization)

The workflow notarizes via the App Store Connect API key (not Apple-ID +
app-specific-password), which is the modern, non-interactive path `notarytool`
and `tauri-action` prefer.

1. Go to <https://appstoreconnect.apple.com/access/integrations/api> → **Keys**.
   (App Store Connect → Users and Access → **Integrations** → **App Store
   Connect API**.)
2. Generate a key with the **Developer** role (sufficient for notarization).
3. Record:
   - **Key ID** → `APPLE_API_KEY_ID`
   - **Issuer ID** (shown at the top of the Keys page) → `APPLE_API_ISSUER_ID`
4. Download the `.p8` private key. **You can only download it once.** Then
   base64-encode it:
   ```bash
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
   ```
   That value becomes `APPLE_API_KEY_BASE64`.

> The workflow's "Decode App Store Connect API key" step writes the `.p8` back
> to `$RUNNER_TEMP/private_keys/AuthKey_${APPLE_API_KEY_ID}.p8` and exports
> `APPLE_API_KEY_PATH`, then wipes it after the build. The filename must match
> `APPLE_API_KEY_ID`, which is why both are needed.

---

## 3. Populate GitHub Secrets and Variables

Repo → **Settings** → **Secrets and variables** → **Actions**.

**Secrets** (encrypted, never printed):

| Name | Value |
|------|-------|
| `APPLE_CERTIFICATE` | base64 of the `.p12` (step 1.5) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password (step 1.4) |
| `APPLE_TEAM_ID` | 10-char Team ID (step 0) |
| `APPLE_API_ISSUER_ID` | App Store Connect issuer ID (step 2.3) |
| `APPLE_API_KEY_ID` | API key ID (step 2.3) |
| `APPLE_API_KEY_BASE64` | base64 of the `.p8` (step 2.4) |

**Variables** (not sensitive — the identity string is printed in every signed
binary):

| Name | Value |
|------|-------|
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |

> Already present and unrelated to Apple: `TAURI_SIGNING_PRIVATE_KEY`,
> `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the **updater** Ed25519 key, separate
> from Apple signing), and the Azure Trusted Signing config for Windows.

---

## 4. Confirm Apple's notary service is healthy

The notary trio was originally disabled because Apple's notary service hung for
multi-hour stretches during the v0.12.0 release. Before cutting a real release
tag, confirm it's responsive. On your Mac, with the API key:

```bash
xcrun notarytool history \
  --key AuthKey_XXXXXXXXXX.p8 \
  --key-id   "$APPLE_API_KEY_ID" \
  --issuer   "$APPLE_API_ISSUER_ID"
```

A prompt response (even an empty history) means the service is up. A multi-minute
hang means it's degraded — hold the release rather than letting CI stall.

System status: <https://developer.apple.com/system-status/> (watch the
"Developer ID Notary Service" row).

---

## 5. Smoke-test with a release-candidate build

Do **not** debug signing on a real `vX.Y.Z` tag. **A throwaway tag name does
not work either:** the workflow's `create-release` job first checks that the
tag is exactly `v<version>` from `src-tauri/tauri.conf.json`, and any other tag
fails there, before any macOS leg starts. So the RC has to be a real version:

1. On a branch, bump the version surfaces to an RC version (for example
   `0.29.0-rc.1`), as in step 1 of
   [the release skill](../.claude/skills/release/SKILL.md).
   `src-tauri/tauri.conf.json` is the one the tag check reads.
2. Tag that commit with an **annotated** tag and push it:
   ```bash
   git tag -a v0.29.0-rc.1 -m "Tandem v0.29.0-rc.1 (signing smoke)"
   git push origin v0.29.0-rc.1
   ```
3. `create-release` creates the **draft** release once, and because the tag
   contains a hyphen it is flagged **prerelease**, so it stays off
   `releases/latest`. The matrix legs upload into that draft; never publish it.

Then watch the **two macOS matrix jobs** (`aarch64-apple-darwin` and
`x86_64-apple-darwin`):

- **"Validate Apple signing material"** runs first. A missing secret or
  variable fails here, and the error names every missing value.
- The **"Verify macOS signature + notarization"** step must print
  `ok: …app code-signed + notarization-stapled` for each `.app`. An empty
  `APPLE_CERTIFICATE` fails this step too, with an `::error::` and exit 1.
- Afterwards, delete the draft release, the RC tag and the branch:
  ```bash
  git push --delete origin v0.29.0-rc.1
  git tag -d v0.29.0-rc.1
  # delete the draft release in the GitHub UI (Releases → … → Delete)
  ```

### Verify on a real Mac (the actual acceptance test)

Download the DMG from the draft release onto a Mac that has **never run a dev
build** (or clear the quarantine state), and confirm:

```bash
# Gatekeeper assessment — should say "accepted" / "source=Notarized Developer ID"
spctl --assess --type open --context context:primary-signature -vvv /Volumes/Tandem*/Tandem.app

# Stapled ticket present (offline check)
xcrun stapler validate /Volumes/Tandem*/Tandem.app

# #983: the nested node-sidecar MUST carry the JIT entitlement or it SIGTRAPs in
# V8 init on Apple Silicon. `bundle.macOS.entitlements` should reach the
# externalBin via tauri-action signing; confirm it actually did (the CI verify
# step asserts this too). Should print com.apple.security.cs.allow-jit.
codesign -d --entitlements - /Volumes/Tandem*/Tandem.app/Contents/MacOS/node-sidecar 2>&1 | strings | grep allow-jit
# If MISSING: re-sign the sidecar with src-tauri/entitlements.plist BEFORE
# notarization (codesign does not inherit app entitlements to nested binaries):
#   codesign --force --sign "$IDENTITY" --options runtime \
#     --entitlements src-tauri/entitlements.plist <app>/Contents/MacOS/node-sidecar
```

On an Apple Silicon Mac the real acceptance is simply that the app **opens a
document** (the sidecar bound `:3479`) rather than showing "Setup failed".

Best of all: double-click the DMG, drag to Applications, launch from Finder.
**No warning dialog = #428 satisfied.** This is the gate that matters for the
v1.0 install matrix (D12, macOS 14 + macOS 26.1 M1).

---

## What the workflow already does for you

Every macOS step below fails closed; none of them skips when material is
missing.

- **`tauri-release.yml` → "Validate Apple signing material"** — fails the leg
  before the build if any of the six secrets or the `APPLE_SIGNING_IDENTITY`
  variable is empty, naming every missing value.
- **`tauri-release.yml` → "Decode App Store Connect API key"** — base64-decodes
  `APPLE_API_KEY_BASE64` to a `umask 077` file and exports
  `APPLE_API_KEY_PATH`; fails if the secret is empty.
- **`tauri-release.yml` → `tauri-apps/tauri-action` (v1.0.0, pinned by commit
  SHA)** — infers the signing identity from `APPLE_CERTIFICATE`, signs the
  `.app`, and submits to the notary via the API key trio (`APPLE_API_ISSUER` /
  `APPLE_API_KEY` / `APPLE_API_KEY_PATH`). It uploads into the draft that
  `create-release` made.
- **`tauri-release.yml` → "Wipe App Store Connect API key"** — removes the
  decoded `.p8` from the runner (`if: always()`).
- **`tauri-release.yml` → "Verify macOS signature + notarization"** — fails the
  job if `APPLE_CERTIFICATE` is empty, or if a produced `.app` is unsigned or
  missing a stapled notarization ticket. Uses `codesign --verify --deep
  --strict` plus `xcrun stapler validate` (offline, deterministic — no `spctl`
  CI flakiness).
- **`tauri-release.yml` → "Smoke-test bundled sidecar (macOS arm64)"** — boots
  the bundled `node-sidecar` on Apple Silicon and checks it serves `/health`,
  so a signed but dead-on-arrival app still fails the release.
- **`release-check` job** — fails if any matrix build (incl. either macOS arch)
  failed, blocking a half-signed release.
- **`verify-release-manifest` job** — checks the draft's `latest.json` against
  the uploaded assets, and its "Verify updater signatures against
  tauri.conf.json pubkey" step checks every updater signature.

## History

Signing and notarization were brought up for #428 after Apple's notary service
hung for hours during the v0.12.0 release and the notary settings were
switched off. They were later re-enabled, the secrets were populated on
2026-05-15, and #1746 then turned the old "skip quietly when unsigned"
behaviour into the fail-closed gates above. v0.24.1 and v0.25.0 exercised the
full path with a real certificate.

## Gotchas

- **Developer ID Application, not Mac App Store / Apple Development.** The wrong
  cert type signs fine but Gatekeeper still rejects it for direct distribution.
- **The `.p8` downloads once.** If you lose it, revoke and reissue the key.
- **`APPLE_API_KEY_ID` must match the filename.** The decode step builds
  `AuthKey_${APPLE_API_KEY_ID}.p8`; a mismatch makes `notarytool` fail to find
  the key.
- **Stapling needs network at build time** (notarization is an online round
  trip) but the *stapled result* is verified offline — which is exactly why the
  app then launches with no network on the user's machine.
- **An expired Apple agreement looks like a notarization failure.** If the
  notary step returns a 403 naming a missing or expired agreement, only the
  Account Holder can clear it, by accepting the updated agreement at
  developer.apple.com / App Store Connect. Then re-run the failed macOS jobs.
- **Notary latency is unpredictable.** Submissions usually take minutes but can
  spike. If CI times out mid-notarization, re-run the macOS jobs rather than
  re-cutting the tag.

## Related

- [Releases and operations map](maps/releases-and-ops.md) — the release skill, smoke checklist and v1.0 gates.
- [Release smoke checklist](release-smoke-checklist.md#0-ci-signal-before-touching-hardware) — the per-release row that tells you this runbook is needed.
- [The release skill](../.claude/skills/release/SKILL.md) — cutting the tag that triggers these signing steps.
- [Troubleshooting](troubleshooting.md) — what a user sees when a macOS build is not signed or notarized.
- [Security: open findings](security.md#open-findings) — the register entry that records when the fail-closed signing gates were first verified on a tag build.
