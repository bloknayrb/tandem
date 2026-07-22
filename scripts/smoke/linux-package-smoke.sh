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
#   docker run --rm -v "<dir-with-artifacts>:/art" fedora:39 \
#     bash /art/linux-package-smoke.sh rpm
#
# Exits non-zero if a step that matters fails, so it can gate CI later.
set -u

MODE="${1:?usage: linux-package-smoke.sh <deb|rpm> [artifact-path]}"
ART="${2:-}"
FAILURES=0

fail() { echo "  !! FAIL: $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "  ok: $*"; }

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
    if [ -n "${TANDEM_APT_MIRROR:-}" ]; then
      sed -i "s|http://archive.ubuntu.com|${TANDEM_APT_MIRROR}|g" /etc/apt/sources.list
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
if [ "$MODE" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq 2>&1 | tail -2
  apt-get install -y --no-install-recommends "$ART" 2>&1 | tail -8
  rc=${PIPESTATUS[0]}
else
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
for b in tandem-desktop node-sidecar tandem-reaper; do
  p="/usr/bin/$b"
  [ -x "$p" ] || continue
  missing=$(ldd "$p" 2>/dev/null | grep -i 'not found')
  if [ -n "$missing" ]; then fail "$b has unresolved libs:"; echo "$missing"; else pass "$b: all libs resolved"; fi
done

echo
echo "=== [5] desktop integration ==="
DESKTOP=$(ls /usr/share/applications/*andem*.desktop 2>/dev/null | head -1)
if [ -n "$DESKTOP" ]; then
  pass "$(basename "$DESKTOP")"
  grep -hE '^(Exec|Name|Icon|MimeType)=' "$DESKTOP"
  grep -q 'wordprocessingml' "$DESKTOP" && pass ".docx MIME registered" || fail ".docx MIME missing"
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
