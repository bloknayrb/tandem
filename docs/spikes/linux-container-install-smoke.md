# Linux install-matrix smoke in containers (no VM)

**Run:** 2026-07-22 · **Artifacts:** v0.19.0 release `.deb` + `.rpm` (real
published artifacts, not a local build) · **Host:** Windows 11 laptop, Docker
Desktop

## Question

The [v1.0 exit criteria](../roadmap.md#v100-exit-criteria) list Ubuntu 22.04
and Fedora 39 in the install matrix, and the standing assumption has been that
the whole matrix is hardware-gated — no Linux box, no verification. This spike
asked whether the *Linux* rows can be closed with containers on hardware we
already have.

## Answer

**Yes for package install/uninstall.** Fedora 39 ran end-to-end in minutes with
no VM, no elevation, and no disk cost beyond the base image. The harness is
`scripts/smoke/linux-package-smoke.sh`.

What containers close: dependency resolution, payload completeness, dynamic
linkage (`ldd`), `.desktop` + MIME registration, skill payload, uninstall
cleanliness.

What they still do **not** close: anything needing a desktop session or real
GPU — AppImage launch, the updater flow, file-association double-click,
performance, accessibility. Those stay VM- or hardware-gated.

## Results

### Finding: shipped Linux packages omit the `libxdo` runtime dependency

**`tandem-desktop` links `libxdo.so.3`, and neither the `.deb` nor the `.rpm`
declares it. The installed app is dead on arrival on both — verified on Fedora
39 and Ubuntu 22.04.** Install succeeds, and then the binary refuses to start:

```
$ /usr/bin/tandem-desktop --version
/usr/bin/tandem-desktop: error while loading shared libraries:
libxdo.so.3: cannot open shared object file: No such file or directory
```

`readelf -d` confirms `libxdo.so.3` is a hard `DT_NEEDED` entry, not a
`dlopen`, so the dynamic loader refuses the image outright — this is not
graceful degradation of the context menus, it is total failure to launch.

Mechanism, confirmed from source:

- `src-tauri/Cargo.toml:36` enables the tauri `linux-libxdo` feature (#923), so
  muda can synthesize native Cut/Copy/Paste menu items.
- `ci.yml` and `tauri-release.yml` both install `libxdo-dev` — as a **build**
  dependency only.
- `tauri.conf.json` had **no `bundle.linux` key at all** — no `deb.depends`, no
  `rpm.depends`. (An earlier draft of this doc said the key was present but
  empty. It wasn't: that reading came from a probe whose own `.get('linux', {})`
  default was being printed back.)

So the binary acquires a hard `DT_NEEDED` on `libxdo.so.3` that no package
metadata carries. The declared deps are only `libappindicator3`, `libgtk-3`,
`libwebkit2gtk-4.1`. `node-sidecar` and `tandem-reaper` link cleanly; it is
specific to `tandem-desktop`.

`linux-libxdo` landed in **v0.13.6**, so nine published releases ship the broken
packages (v0.13.6 through v0.19.0; v0.18.0 is excluded only because its
published release carries no Linux artifacts at all — a separate bug, #1228).
Users with `xdotool` already installed won't see it, which is a good way for it
to stay hidden. The **AppImage is unaffected** — it bundles `libxdo.so.3` at
`squashfs-root/usr/lib/` (verified via `--appimage-extract`).

**Filed as #1227 and fixed in this branch**: `bundle.linux.deb.depends` is now
`["libxdo3"]` and `rpm.depends` is `["libxdo"]`. Both package names were
verified by installing them, not guessed — the plausible-sounding
`xdotool-libs` does **not** exist on Fedora 39, and `dnf provides
'libxdo.so.3()(64bit)'` gives `libxdo-1:3.20211022.1-4.fc39`. User-supplied
`depends` append to Tauri's auto-injected list rather than replacing it, so
this cannot strip the existing three.

Per maintainer decision, no patch release: the fix rides the next minor, given
16 total Linux downloads across all releases.

### Fedora 39 `.rpm` — install/uninstall PASS, linkage FAIL

- Install exit 0; deps resolve (pulls `webkit2gtk4.1-2.46.3`).
- All three binaries present: `tandem-desktop`, `node-sidecar`, `tandem-reaper`.
  The reaper matters — it shipped *missing* from every desktop build before the
  v0.14.x bundling fix, which is why the harness asserts it by name.
- `.desktop` registers the `.docx` MIME type.
- Skill ships at `/usr/lib/Tandem/skills/tandem/SKILL.md` (package-owned, 45
  payload entries).
- Uninstall exit 0, **zero files survive**, all three binaries removed.
- Linkage: `node-sidecar` and `tandem-reaper` clean; `tandem-desktop` fails on
  `libxdo.so.3` (see the finding above).

Empty directories (`dist/`, `docs/`, `sample/`, `skills/`) remain under
`/usr/lib/Tandem` after erase. This is **not a defect** — rpm only reaps
directories a package explicitly owns via `%dir`. It was initially misread as
an orphan finding; characterising files-vs-directories is what settled it, and
the harness now checks files only so it doesn't cry wolf.

### Ubuntu 22.04 `.deb` — install/uninstall PASS, linkage FAIL (identical)

- Install exit 0. All three declared deps resolve on stock jammy:
  `libwebkit2gtk-4.1-0` 2.50.4 (universe), `libappindicator3-1` 12.10.1,
  `libgtk-3-0` 3.24.33. The dependency-availability question that looked like a
  plausible v1.0 blocker is settled — it isn't one.
- All three binaries present; `.desktop` + `.docx` MIME correct; skill ships.
- **Same `libxdo.so.3 => not found` on `tandem-desktop`.** The defect is
  universal across both Linux package formats, not Fedora-specific.
- Purge exit 0, zero files survive — and dpkg reaps the directory tree too, so
  Ubuntu leaves nothing at all behind (unlike rpm's empty dirs).

Reaching a mirror needed `TANDEM_APT_MIRROR=http://azure.archive.ubuntu.com`.
`archive.ubuntu.com` returned HTTP 000 from this network on every IP it handed
out, while `azure.archive.ubuntu.com`, `mirrors.edge.kernel.org` and
`ubuntu.osuosl.org` all returned 200.

## The trap this spike walked into twice

**Docker's default bridge has no IPv6 route, and the distro mirrors resolve
AAAA-first.** apt does not report this as a network failure. It reports:

```
tandem : Depends: libappindicator3-1 but it is not installable
         Depends: libwebkit2gtk-4.1-0 but it is not going to be installed
```

which is indistinguishable from a genuine packaging defect, and was nearly
filed as a v1.0 finding. Both harness modes now pin IPv4
(`Acquire::ForceIPv4` / `ip_resolve=4`) with the reason in a comment.

The deeper fix is that the harness now refuses to guess. Metadata refresh
(`apt-get update` / `dnf makecache`) is a separate step with its own verdict,
and a failure there exits **3 — ENVIRONMENT** and stops, rather than letting
every later check misreport an unreachable mirror as a broken package. The exit
contract is `0` pass, `1..N` that many real defects, `2` usage, `3`
environment. A gate that cannot say "I learned nothing" gets muted the first
week it flakes.

Swapping in a "more reliable" mirror made it worse — `us.archive.ubuntu.com`
doesn't resolve inside the container at all, so apt silently fell back to stale
lists and reported *every* dependency unsatisfiable. Diagnose the network
before changing the mirror.

## Open item, not a bug

`libappindicator3-1` **was removed in Ubuntu 24.04**. The exit criteria name
only 22.04, so the current `.deb` passes as written — but 24.04 is the current
LTS and is where most new users will be. Fedora sidesteps this entirely because
the `.rpm` depends on the soname `libappindicator3.so.1` rather than a package
name. Whether to add 24.04 to the matrix (and whether the `.deb` should depend
on `libayatana-appindicator3-1`) is a scope decision, not a defect.
