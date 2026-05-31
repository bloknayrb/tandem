# macOS Code-Signing & Notarization Runbook (#428)

**Goal:** ship a Tandem macOS build that launches cleanly on a fresh Mac with
**no Gatekeeper warning** — no "Tandem is damaged and can't be opened", no
"unidentified developer", no right-click → Open workaround.

This requires three things to be true at once:

1. An **active Apple Developer Program** membership (the calendar gate).
2. The signing/notarization **secrets populated** in the GitHub repo.
3. Apple's **notary service healthy** at build time.

The release workflow (`.github/workflows/tauri-release.yml`) is already wired
for all of this. The notary trio was re-enabled on the
`claude/highest-impact-prioritization-vksRg` branch; until the secrets are
populated the build ships unsigned **by design** and the verification gate
no-ops with a `::notice::`. The moment the secrets land, signing + notarization
+ stapling activate and the gate enforces them.

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

## 5. Smoke-test with a throwaway release-candidate tag

Do **not** debug signing on a real `vX.Y.Z` tag. The workflow triggers on any
`v*` tag, so use a disposable RC tag:

```bash
git tag v0.0.0-rc-notarize-1
git push origin v0.0.0-rc-notarize-1
```

Then watch the **two macOS matrix jobs** (`aarch64-apple-darwin` and
`x86_64-apple-darwin`):

- The **"Verify macOS signature + notarization"** step must print
  `ok: …app code-signed + notarization-stapled` for each `.app`. If
  `APPLE_CERTIFICATE` is missing it will instead print the skip `::notice::` —
  which tells you the secret didn't take.
- `tauri-action` produces a **draft** release (`releaseDraft: true`), so the RC
  won't go public. Delete the draft release and the RC tag afterward:
  ```bash
  git push --delete origin v0.0.0-rc-notarize-1
  git tag -d v0.0.0-rc-notarize-1
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
```

Best of all: double-click the DMG, drag to Applications, launch from Finder.
**No warning dialog = #428 satisfied.** This is the gate that matters for the
v1.0 install matrix (D12, macOS 14 + macOS 26.1 M1).

---

## 6. Re-enable for the real release

Once the RC is green and a real Mac launches the app cleanly, no code change is
needed — the signing path is permanent. Cut the real `vX.Y.Z` tag and the same
steps run against it.

---

## What the workflow already does for you

- **`tauri-release.yml` → "Decode App Store Connect API key"** — base64-decodes
  `APPLE_API_KEY_BASE64` to a `umask 077` file, exports `APPLE_API_KEY_PATH`,
  no-ops cleanly when the secret is unset.
- **`tauri-release.yml` → `tauri-apps/tauri-action@v0`** — infers the signing
  identity from `APPLE_CERTIFICATE`, signs the `.app`, and submits to the notary
  via the API key trio (`APPLE_API_ISSUER` / `APPLE_API_KEY` /
  `APPLE_API_KEY_PATH`). All empty → graceful skip.
- **`tauri-release.yml` → "Wipe App Store Connect API key"** — removes the
  decoded `.p8` from the runner (`if: always()`).
- **`tauri-release.yml` → "Verify macOS signature + notarization"** — fails the
  job if a produced `.app` is unsigned or missing a stapled notarization ticket,
  *once* `APPLE_CERTIFICATE` is set. Uses `codesign --verify --deep --strict`
  plus `xcrun stapler validate` (offline, deterministic — no `spctl` CI
  flakiness). Skips with a `::notice::` while unsigned-by-design.
- **`release-check` job** — fails if any matrix build (incl. either macOS arch)
  failed, blocking a half-signed release.

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
- **Notary latency is unpredictable.** Submissions usually take minutes but can
  spike. If CI times out mid-notarization, re-run the macOS jobs rather than
  re-cutting the tag.
