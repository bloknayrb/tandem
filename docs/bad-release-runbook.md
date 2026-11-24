---
tags: [audience/maintainer, topic/release]
aliases: [Bad-release runbook, Release rollback runbook, Staging update channel]
---

# Bad-release recovery runbook (#2280)

[Home](README.md) › [Releases and operations](maps/releases-and-ops.md)

**Goal:** a published release turns out to be broken. Stop it reaching anyone else, on every
channel, within minutes, and get the people who already have it onto a fixed version.

This runbook stops a rollout **at the source**. It does not roll back installed copies, which
[ADR-043](decisions.md#adr-043-updater--no-rollback-no-in-updater-post-restart-health-probe-v1)
rules out on the client. The two do not conflict: ADR-043 is about what the app does to itself,
and this is about what the release channels offer.

It is one of the v1.0 [documentation gates](roadmap.md#v100-exit-criteria): written, and
rehearsed once without moving the real `latest` pointer. The rehearsal is
[below](#rehearsal-v10-gate). It has **not been run yet** (see [Rehearsal record](#rehearsal-record)).

Throughout, `vBAD` is the broken release and `vGOOD` the last good **stable** release before it.

## Where a release reaches people

| Channel | What decides what people get | Lever |
|---|---|---|
| Desktop updater, public route | GitHub's `releases/latest`, read as `releases/latest/download/latest.json` (`src-tauri/tauri.conf.json`) | [Step 1](#1-desktop-move-the-latest-pointer-back) |
| Desktop updater, licensed route | The licence update Worker, which proxies the same URL (`PUBLIC_LATEST_JSON_URL` in `infra/license-update-worker/wrangler.toml`). Not live while `LICENSE_UPDATE_ENDPOINT` is empty and the Worker's `wrangler.toml` holds a placeholder | Step 1, then [step 4](#4-licensed-route) |
| Desktop download page | The README links `releases/latest` | Step 1 |
| npm (`npm i -g tandem-editor`, and the CLI's update notice) | The `latest` dist-tag | [Step 2](#2-npm-move-the-dist-tag-back-and-deprecate) |
| Claude Code plugin | `.claude-plugin/marketplace.json` `source.ref` on `master`; the tagged `plugin.json` pins `npx -y tandem-editor@<version>`, which **ignores** dist-tags | [Step 3](#3-plugin-marketplace-point-the-ref-back) |

Prereleases (any version with a hyphen) never reach `releases/latest`, the npm `latest` tag or
the plugin (the release skill's step 7 and 9, and `publish.yml`'s `next` tag). A broken RC needs
only a fixed RC.

## Recovery

Do the steps in order. Step 1 matters most, because the desktop updater checks at launch and
every eight hours on its own.

### 1. Desktop: move the `latest` pointer back

```bash
gh release edit vGOOD --latest
gh release edit vBAD --prerelease --latest=false
```

The first command moves the pointer. The second makes `vBAD` ineligible for it again: GitHub
re-derives `latest` from date and version whenever something asks it to (the reuse branch in
`tauri-release.yml` patches with `make_latest: 'legacy'`), and a non-prerelease `vBAD` would win
that again. Marking it a prerelease fires no workflow: `publish.yml` listens only for
`published`.

Check what the updater now sees, and note the time:

```bash
curl -sL https://github.com/bloknayrb/tandem/releases/latest/download/latest.json | jq -r .version
# expect vGOOD's version, without the v
```

**Do not delete the `vBAD` release or its tag, and never reuse its version number.** The tag is
what `publish.yml`'s recovery dispatch, the plugin ref and anyone's bug report point at, and a
version an updater has seen cannot be offered again under the same number.

**Do not re-run `vBAD`'s Tauri Release workflow** after this step. Its reuse branch PATCHes the
release whenever the stored `prerelease` flag differs from the tag's, so a re-run sets `vBAD` back
to a full release with `make_latest: 'legacy'`, and GitHub re-derives `latest` to `vBAD` again.

### 2. npm: move the dist-tag back and deprecate

```bash
npm dist-tag add tandem-editor@<GOOD version> latest
npm deprecate tandem-editor@<BAD version> "<one line: what is broken>. Use <GOOD version> or later."
npm view tandem-editor dist-tags --prefer-online
```

These need Bryan's npm login with two-factor authentication. Trusted Publishing (OIDC, in
`publish.yml`) authorizes `npm publish` only, so CI cannot do this.

**Do not `npm unpublish`.** It is possible only within 72 hours, it burns the version number
anyway, and it breaks every Claude config that already pins `tandem-editor@<BAD version>`
outright, where a deprecation only warns.

The CLI's update notice (`update-notifier` in `src/cli/index.ts`) caches its check for a day, so
some people see "update available" for `vBAD` for up to a day after the tag moves. Installing then
gets `vGOOD`.

### 3. Plugin marketplace: point the ref back

If the release skill's step 9 already set `source.ref` in `.claude-plugin/marketplace.json` to
`vBAD`, open a PR setting it back to `vGOOD`. `plugin-version-pin.test.ts` accepts the previous
stable release, so CI stays green on that PR. If step 9 has not happened yet, do nothing, and
don't do it for `vBAD`.

**This turns `vFIX`'s version-bump PR red.** That test allows only package.json's version or the
stable release before it in `CHANGELOG.md`. Once the bump moves package.json to `vFIX`, the
allowed pair is `vFIX` / `vBAD`, and a ref still on `vGOOD` fails `check`. The bump PR cannot move
the ref to `vFIX` either (the tag does not exist yet, which is what the test guards). Decide with
Bryan before cutting `vFIX`: either let the bump PR set the ref to `vBAD` for the window between
merge and publish, or widen the test for this one release.

### 4. Licensed route

Once the licence update Worker is deployed, it reads the same `releases/latest` URL with no
caching of its own, so step 1 covers it. Confirm `PUBLIC_LATEST_JSON_URL` has not been pointed
anywhere else. The Worker variable is also a second lever for licensed devices alone, if the public
pointer has to stay where it is for some reason. While licensing ships dark, there is nothing to do.

### 5. People already on vBAD: fix forward

The updater offers only a version **higher** than the one installed, so moving the pointer back
leaves everyone on `vBAD` where they are. They leave it only by updating to a fixed release:

- Cut `vFIX` above `vBAD` (normally a patch bump) with the [release skill](../.claude/skills/release/SKILL.md),
  as fast as the fix allows. Publishing it moves `latest` forward again.
- Edit `vBAD`'s release notes to say what is broken and that `vFIX` replaces it.
- Do not tell people to reinstall `vGOOD` over `vBAD` as a general remedy. An older version
  reading data a newer one wrote is not a supported path (#1792; for local models, ADR-039's flip
  amendment, R-a). Advise it case by case only, when the breakage is worse than that risk.

### 6. Record it

Write what happened on the tracking issue: the times of step 1, of the `curl` check, and of the
first real client seeing `vGOOD` (that last is the number no rehearsal can measure: it depends on
GitHub's redirect and CDN caching). Add a line here under [What real uses settled](#what-real-uses-settled).

## The staging update channel

A rehearsal, and the RC forward-update row of the
[smoke checklist](release-smoke-checklist.md#5-release-candidate-extras-rc-tags-toward-v10-only),
both need a desktop build that reads some other manifest. Bryan decided on 2026-10-22 (OPS08 in the
[2026-10-20 docs audit](reviews/2026-10-20-docs-audit.md)) that this must be a separate
**build**, never a runtime override in shipped builds, which would be attack surface on the path
that replaces Tandem's own binaries.

```bash
npm run build:tauri:staging -- --manifest-url <https URL of a latest.json>
```

`scripts/staging-update/build-staging.mjs` writes a Tauri `--config` overlay to a temp directory
and runs the same three steps as `npm run build:tauri` with it. The overlay changes three things:

- **The updater endpoint**, to the URL you name. The public key is unchanged, so a staging build
  still installs only artifacts signed with the real updater key.
- **The version**, to `0.0.1`, lower than every release. A real release's own `latest.json` and
  artifacts then read as an update, with nothing re-signed and no fake version. This is the
  desktop shell's version: what the updater compares, what the pending-update marker checks after
  the restart, and what the installer registers (Windows: Settings → Apps, or the exe's
  Properties → Details; macOS: Get Info on `Tandem.app`). That is where you tell a staging build
  apart. **About and Copy Diagnostics do not show it**: they report the version compiled into the
  checkout (`Cargo.toml` and `package.json`, which the release pins keep equal), so a staging build built from a checkout of release X already reads X there.
  After an update the installed version is the release's, and the "may not have finished updating"
  banner stays away.
- **No updater artifacts.** A staging build only consumes updates, so the build never needs the
  updater private key. Do not put that key on the build machine.

The script refuses a non-https URL, a URL with credentials and the production
`bloknayrb/tandem` `releases/latest` pointer. A real release's per-tag
`releases/download/<tag>/latest.json` is allowed. The release workflow applies no overlay and
`tests/scripts/staging-update-channel.test.ts` keeps it that way, along with the shipped endpoint.

**Handle a staging build as a test tool.** It has the real app's identifier, so it installs over
a real Tandem on that machine and shares its data directory, and installing `0.0.1` over a
higher version is a downgrade the installer may question. Use a test machine or VM, leave crash reporting off, never
hand the build to anyone, and uninstall it when done (an update replaces it with the real release).

**Licensed route.** The overlay reaches only the public route. While `LICENSE_UPDATE_ENDPOINT` is
empty every device takes that route. Once it is set, a licensed device's staging build goes to the
compiled licence endpoint and ignores the staging manifest (the script prints a note when it sees
the const set). Only a trialing or unlicensed device then exercises the staging manifest.
Rehearsing the licensed route needs a staging Worker and a build with a different const, which
does not exist yet.

### Where a staging manifest lives

- **For the RC forward-update row:** the RC's own per-tag manifest,
  `https://github.com/bloknayrb/tandem/releases/download/<RC tag>/latest.json`. No staging host is
  needed.
- **For the rehearsal:** a separate public repository with no workflows, for example
  `<owner>/tandem-update-staging`, whose releases each hold one `latest.json` copied from a real
  release. Its `releases/latest` behaves exactly like the real pointer, so the rehearsal runs the
  same `gh release edit` commands. **Not a release on `bloknayrb/tandem` itself:** publishing any
  release there fires `publish.yml` (it runs for every tag and only then fails its version check),
  and a non-`v` tag on `master`'s history becomes what `git describe --tags` returns, which the
  changelog skill uses.

## Rehearsal (v1.0 gate)

Needs Bryan: a test machine or VM per platform you choose to cover, and the npm login. At least
Windows. Nothing here touches the real `latest` pointer.

1. **Staging repo.** Create the staging repository with one commit (a README is enough: a release
   needs a commit to tag). In it, create two releases named after two
   real stable releases, `vOLD` and `vNEW` (for example the last two). Each holds only that
   release's `latest.json`:

   ```bash
   gh release download vOLD --repo bloknayrb/tandem -p latest.json -D old
   gh release create vOLD old/latest.json --repo <owner>/tandem-update-staging --notes rehearsal
   gh release download vNEW --repo bloknayrb/tandem -p latest.json -D new
   gh release create vNEW new/latest.json --repo <owner>/tandem-update-staging --notes rehearsal
   ```

   `vOLD` goes first, so `vNEW` is created last and is `latest`; it plays `vBAD`.
2. **Staging build.** `npm run build:tauri:staging -- --manifest-url https://github.com/<owner>/tandem-update-staging/releases/latest/download/latest.json`.
   Install it on a fresh test machine or VM snapshot (step 6 installs `vOLD`, which is older than
   the checkout you built from, so it must not inherit data a newer build wrote: #1792). The
   installed app's version (Settings → Apps, or Get Info) reads `0.0.1`; About shows the
   checkout's own version, not `0.0.1`.
3. **See the bad release offered.** Tray → Check for Updates. Pass: the update to `vNEW` is
   offered. Don't install it.
4. **Run step 1 against the staging repo**, with `--repo <owner>/tandem-update-staging` on both
   commands, and the `curl` check against the staging URL (`https://github.com/<owner>/tandem-update-staging/releases/latest/download/latest.json`). Note the times.
5. **See the pointer move reach the client.** Tray → Check for Updates again. Pass: `vOLD` is
   offered, not `vNEW`. Note how long after step 4 it changed.
6. **Finish the path.** Install `vOLD`. Pass: the app restarts, About and the installed app's
   version both show `vOLD`'s version, and no
   "Tandem may not have finished updating" banner appears. Check the window, not `tandem.log`: a
   successful update logs nothing at the release log level
   ([why](release-smoke-checklist.md#what-the-v0250-run-settled)).
7. **npm, without moving `latest`.** `npm dist-tag add tandem-editor@<current version> rehearsal`,
   check it with `npm view tandem-editor dist-tags --prefer-online`, then
   `npm dist-tag rm tandem-editor rehearsal`. This proves the login and two-factor path that step 2
   needs. `npm deprecate` is not rehearsed: any use of it on a real version is public. Its command
   is single and reversible (`npm deprecate tandem-editor@<v> ""` lifts it).
8. **Plugin.** Not rehearsed: step 3 is an ordinary PR.
9. Record the outcome below, and tick the roadmap gate.

## Rehearsal record

Not run yet. When it is, record: date, platforms, the two versions used, the times from steps 4
and 5, and anything that did not match this page.

## What real uses settled

None yet.
