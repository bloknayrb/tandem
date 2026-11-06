#!/bin/bash
# Linux package install/uninstall smoke, run inside a distro container.
#
# Closes the ".deb / .rpm installs without dependency errors on its target
# distro" line of the release smoke checklist, and the Linux half of the v1.0
# install matrix, without a VM -- see
# docs/spikes/linux-container-install-smoke.md.
#
#   docker run --rm -v "<dir-with-artifacts>:/art" ubuntu:22.04 \
#     bash /art/linux-package-smoke.sh deb
#   docker run --rm -v "<dir-with-artifacts>:/art" fedora:44 \
#     bash /art/linux-package-smoke.sh rpm
#
# The release workflow runs the .deb on ubuntu:22.04, ubuntu:24.04, debian:12
# and debian:13, and the .rpm on fedora:44.
#
# Exit codes are distinct on purpose, because this is meant to gate CI and a
# gate that cannot tell "the package is broken" from "the network is down"
# will be muted the first week it flakes:
#
#   0    all checks passed
#   1..N that many real package defects
#   2    usage / no artifact
#   3    ENVIRONMENT fault -- repository metadata could not be fetched.
#        Nothing was learned about the package. Retry; do not read as a defect.
set -u

MODE="${1:?usage: linux-package-smoke.sh <deb|rpm> [artifact-path]}"
ART="${2:-}"
FAILURES=0

# Mirrors DOCX_ENABLED (src/shared/constants.ts). While .docx ships dark
# (ADR-053) the package must NOT register the Word MIME type.
# tests/build/file-association-alignment.test.ts keeps this equal to the flag.
DOCX_EXPECTED=0

fail() { echo "  !! FAIL: $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ok: $*"; }
# Bail immediately rather than accumulating: every check after this point would
# report a fault of the harness as a fault of the package.
envfail() {
  echo
  echo "  ENVIRONMENT FAULT: $*"
  echo "  The package was NOT evaluated. This is not a packaging defect."
  echo "RESULT: ENVIRONMENT (exit 3)"
  exit 3
}

# Docker's default bridge has no IPv6 route, but the distro mirrors resolve
# AAAA-first. Without pinning IPv4, apt reports every dependency as
# "not going to be installed" -- which reads exactly like a packaging defect
# rather than the harness network fault it is. Pin it so a broken environment
# can never masquerade as a broken package.
case "$MODE" in
  deb)
    echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
    echo 'Acquire::Retries "5";'      > /etc/apt/apt.conf.d/99retries
    # Some networks cannot reach archive.ubuntu.com at all (it returned HTTP
    # 000 on every IP from the machine this was written on, while three other
    # mirrors returned 200). Probe candidates with
    #   curl -4 -o /dev/null -w '%{http_code}' \
    #     http://<mirror>/ubuntu/dists/jammy/Release
    # and override, rather than reading apt's dependency errors as real.
    # Ubuntu-only: Debian images name deb.debian.org, which this leaves alone.
    # Ubuntu 24.04 moved its sources to deb822 (sources.list.d/ubuntu.sources)
    # and left sources.list a comment, so both forms are rewritten.
    if [ -n "${TANDEM_APT_MIRROR:-}" ]; then
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do
        [ -f "$f" ] && sed -i "s|http://archive.ubuntu.com|${TANDEM_APT_MIRROR}|g" "$f"
      done
      echo "apt mirror override: $TANDEM_APT_MIRROR"
    fi
    [ -n "$ART" ] || ART=$(ls /art/*.deb 2>/dev/null | head -1)
    ;;
  rpm)
    echo 'ip_resolve=4' >> /etc/dnf/dnf.conf
    [ -n "$ART" ] || ART=$(ls /art/*.rpm 2>/dev/null | head -1)
    ;;
  *) echo "unknown mode '$MODE' (expected deb|rpm)"; exit 2 ;;
esac

[ -f "$ART" ] || { echo "no $MODE artifact found (looked in /art)"; exit 2; }
echo "artifact: $ART"
echo "distro:   $(. /etc/os-release && echo "$PRETTY_NAME")"

echo
echo "=== [1] declared dependencies ==="
if [ "$MODE" = deb ]; then
  dpkg-deb -f "$ART" Depends
else
  rpm -qp --requires "$ART" 2>/dev/null | grep -vE '^(rpmlib|/bin/sh)' | sort -u
fi

echo
echo "=== [2] install ==="
# Refresh metadata as its own step with its own verdict. Folded into the
# install it is invisible: apt reports an unreachable mirror as
# "Depends: X but it is not going to be installed", which is indistinguishable
# from a genuinely missing dependency and is how this harness first lied.
if [ "$MODE" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  # Error-Mode=any: by default apt-get update exits 0 when every index fails
  # to download (it only prints W: lines), so the envfail below never fired
  # and an unreachable mirror was reported as a packaging defect after all.
  # Cost: a flake in any one pocket (e.g. -security) now also reads as an
  # environment fault, i.e. "not evaluated", which is the honest answer.
  apt-get update -qq -o APT::Update::Error-Mode=any 2>&1 | tail -2
  [ "${PIPESTATUS[0]}" -eq 0 ] || envfail "apt-get update failed (mirror unreachable?). Try TANDEM_APT_MIRROR=<mirror>."
  apt-get install -y --no-install-recommends "$ART" 2>&1 | tail -8
  rc=${PIPESTATUS[0]}
else
  dnf makecache -q 2>&1 | tail -2
  [ "${PIPESTATUS[0]}" -eq 0 ] || envfail "dnf makecache failed (mirror unreachable?)."
  dnf install -y --setopt=install_weak_deps=False "$ART" 2>&1 | tail -4
  rc=${PIPESTATUS[0]}
fi
[ "$rc" -eq 0 ] && pass "install exit 0" || fail "install exit $rc"

PKG=tandem
if [ "$MODE" = deb ]; then
  LIST=$(dpkg -L "$PKG" 2>/dev/null)
else
  PKG=$(rpm -qa 2>/dev/null | grep -iE '^tandem' | head -1)
  LIST=$(rpm -ql "$PKG" 2>/dev/null)
fi
[ -n "$LIST" ] || { echo; echo "no payload -- aborting remaining checks"; exit 1; }

echo
echo "=== [3] payload: shipped executables ==="
# The Tauri bundle ships three binaries; the reaper in particular shipped
# MISSING from every desktop build before the v0.14.x fix, so its absence is
# a regression worth catching here rather than at "Relaunch Claude" time.
for b in tandem-desktop node-sidecar tandem-reaper; do
  if echo "$LIST" | grep -qE "/usr/bin/${b}$"; then pass "$b present"; else fail "$b MISSING from payload"; fi
done

echo
echo "=== [4] dynamic linkage ==="
# A dependency that resolves at install time can still leave an unresolved
# soname at run time; ldd is the check that actually proves the binary loads.
# This is the check that found #1227: tandem-desktop linked libxdo.so.3, which
# no package declared, so nine releases installed cleanly and then refused to
# start. Install-time success says nothing about whether the loader is happy.
for b in tandem-desktop node-sidecar tandem-reaper; do
  p="/usr/bin/$b"
  [ -x "$p" ] || continue
  missing=$(ldd "$p" 2>/dev/null | grep -i 'not found')
  if [ -n "$missing" ]; then fail "$b has unresolved libs:"; echo "$missing"; else pass "$b: all libs resolved"; fi
done

echo
echo "=== [4b] tray library (dlopen'd, invisible to ldd) ==="
# The tray does not link its appindicator library: libappindicator-sys
# dlopen()s it when the tray is built, so [4] passes a package whose tray
# library is absent. What the package must guarantee is that the loader can
# find one of the names libappindicator-sys tries -- this list is its 0.9.0
# list, in its order (backcompat on; src-tauri/Cargo.lock pins 0.9.0, and
# tests/scripts/linux-package-smoke-wiring.test.ts fails if that moves). Exact field
# match, never a substring: the ayatana soname contains "appindicator3.so.1".
#
# The .deb's `Depends: libappindicator3-1` is met by the real package on
# Ubuntu, and on Debian -- which has none -- by libayatana-appindicator3-1,
# which declares `Provides: libappindicator3-1`. So which package and soname
# satisfied it differs per distro, and is printed rather than asserted.
TRAY_SONAMES="libayatana-appindicator3.so.1 libappindicator3.so.1 libayatana-appindicator3.so libappindicator3.so"
CACHE=$(ldconfig -p 2>/dev/null | awk '{print $1}')
if [ -z "$CACHE" ]; then
  fail "ldconfig -p listed nothing (is ldconfig on PATH?) -- tray library not evaluated"
else
  found=""
  for so in $TRAY_SONAMES; do
    echo "$CACHE" | grep -qxF "$so" && found="$found $so"
  done
  if [ -n "$found" ]; then
    pass "tray library resolvable:$found"
    first=${found# }; first=${first%% *}
    path=$(ldconfig -p | awk -v n="$first" '$1 == n {print $NF; exit}')
    if [ "$MODE" = deb ]; then owner=$(dpkg -S "$(readlink -f "$path")" 2>/dev/null | cut -d: -f1)
    else owner=$(rpm -qf "$path" 2>/dev/null); fi
    echo "  first match $first -> $path (package: ${owner:-unknown})"
  else
    fail "no appindicator library resolvable -- the tray cannot load (tried: $TRAY_SONAMES)"
  fi
fi

echo
echo "=== [5] desktop integration ==="
DESKTOP=$(ls /usr/share/applications/*andem*.desktop 2>/dev/null | head -1)
if [ -n "$DESKTOP" ]; then
  pass "$(basename "$DESKTOP")"
  grep -hE '^(Exec|Name|Icon|MimeType)=' "$DESKTOP"
  grep -q 'text/markdown' "$DESKTOP" && pass "markdown MIME registered" || fail "markdown MIME missing"
  if [ "$DOCX_EXPECTED" = 1 ]; then
    grep -q 'wordprocessingml' "$DESKTOP" && pass ".docx MIME registered" || fail ".docx MIME missing"
  else
    grep -q 'wordprocessingml' "$DESKTOP" && fail ".docx MIME registered while .docx ships dark" || pass ".docx MIME absent (ships dark)"
  fi
else
  fail "no .desktop file installed"
fi

echo
echo "=== [6] skills payload ==="
echo "$LIST" | grep -q 'skills/tandem/SKILL.md' && pass "skill ships" || fail "skill missing"

echo
echo "=== [7] uninstall ==="
if [ "$MODE" = deb ]; then
  apt-get purge -y "$PKG" 2>&1 | tail -3; rc=${PIPESTATUS[0]}
else
  dnf remove -y "$PKG" 2>&1 | tail -3; rc=${PIPESTATUS[0]}
fi
[ "$rc" -eq 0 ] && pass "uninstall exit 0" || fail "uninstall exit $rc"

echo
echo "=== [8] orphan check ==="
# FILES are the gate. Empty directories left under /usr/lib/Tandem are normal
# for rpm (it only reaps directories a package explicitly owns via %dir) and
# are NOT a defect -- don't fail on them, or the check cries wolf every run.
ORPHAN_FILES=$(find /usr/lib/Tandem /usr/bin /usr/share/applications -iname '*tandem*' -type f 2>/dev/null)
if [ -n "$ORPHAN_FILES" ]; then fail "files survive uninstall:"; echo "$ORPHAN_FILES"; else pass "no files survive uninstall"; fi
ORPHAN_DIRS=$(find /usr/lib/Tandem -type d 2>/dev/null | wc -l)
[ "$ORPHAN_DIRS" -gt 0 ] && echo "  note: $ORPHAN_DIRS empty directories remain (expected; not a failure)"

echo
if [ "$FAILURES" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($FAILURES)"; fi
exit "$FAILURES"
