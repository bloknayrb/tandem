# Does anything block the next minor?

Verdict given 2026-09-02, before any fix landed. **No finding is a regression**, so the next minor
is strictly better than v0.24.1 whether or not anything is fixed first, and holding it for
pre-existing bugs only delays the fixes reaching users. What blocks is the small set where the
release process itself is the risk.

## Block until done

| Issue | Why the release is the trigger | Effort |
|---|---|---|
| [#1746](https://github.com/bloknayrb/tandem/issues/1746) | The macOS signing gate exits 0 on empty secrets, so a misconfigured secret ships an unsigned, un-notarized build silently. Make the gate fail, or confirm the secrets are set before tagging. | 15 min |
| [#1745](https://github.com/bloknayrb/tandem/issues/1745) | Signing secrets are exposed to floating action tags on every release run. SHA-pin them. | 30 min |
| [#1747](https://github.com/bloknayrb/tandem/issues/1747) | The bundled Node is five security releases behind and a release is the only vehicle that fixes it. Bump to 22.23.2. | 10 min plus a build |
| Windows update smoke ([smoke-lines.md](smoke-lines.md), first three lines) | §1 of the smoke checklist has gone two releases unrun, the exe-unlock wait is dead code (#1762), and there is an unverified lead that a silent auto-update scrubs app data. One real 0.24.1 → next upgrade on a Windows machine settles all three. | 20 min of Bryan's time |

If the Windows run shows the app-data scrub is real, it moves to the top of this table and becomes a
fix before tagging.

## Ship with it, not blocking

Track A ([tracks/A-stop-the-bleeding.md](tracks/A-stop-the-bleeding.md)): small, decided, each
one unrecoverable data loss on an ordinary action. #1752 bounds check, #1768 list-not-restore,
#1749 watcher re-arm, #1750 session key, #1757 EPIPE handler, #1756 graceful Quit. These are the
fixes a minor release exists to carry. The line to draw: cut the release when track A is in, and
do not wait for anything else.

## Look like blockers but are not

#1759 (the stdio bridge refuses upgrades) and #1790 (plugin pin) break *during* an upgrade, but the
code that breaks is the already-installed 0.24.1 bridge, so fixing them in the next minor cannot
smooth that step. It smooths every step after. Fix them in this release for that reason, and
expect Claude Desktop users to need one restart this time regardless.

## Do not hold for

- The licensing group (#1785, #1786, #1788, #1789, #1793, #1819): the gate is dark.
- The Word fidelity group (#1754, #1755, #1753): waits on decisions A and B.
- The anchor group (#1764, #1765, #1767): needs a planned coordinate-system change.
- #1748, unless the release uses an RC tag, in which case it blocks outright because the RC would
  auto-update every desktop user.
