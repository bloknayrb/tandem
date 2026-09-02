# Issue index

All 84 carry the `v1-review` label. Severity is as filed; **H** High, **M** Medium, **L** a Low
batch, **D** decisions. Area links go to the ledger with the `file:line` evidence; track links to
the fix plan. The Status column is empty on purpose: fill it in as fixes land, or ignore it and
trust the tracker.

| # | Title | Sev | Area | Track | Status |
|---|---|---|---|---|---|
| [1744](https://github.com/bloknayrb/tandem/issues/1744) | Dependabot template unedited; no update has ever run | H | [ci-build](areas/ci-build.md) | [I](tracks/I-supply-chain.md) | |
| [1745](https://github.com/bloknayrb/tandem/issues/1745) | Release workflow holds signing secrets in floating-tag action steps | H | [ci-build](areas/ci-build.md) | [I](tracks/I-supply-chain.md) | |
| [1746](https://github.com/bloknayrb/tandem/issues/1746) | macOS signing/notarization gate exits 0 on empty secrets | H | [ci-build](areas/ci-build.md) | [I](tracks/I-supply-chain.md) | |
| [1747](https://github.com/bloknayrb/tandem/issues/1747) | Sidecar Node 22.17.0 is five security releases behind | H | [ci-build](areas/ci-build.md) | [I](tracks/I-supply-chain.md) | |
| [1748](https://github.com/bloknayrb/tandem/issues/1748) | CI hygiene: RC tag auto-updates everyone, Test before Build, NPM_TOKEN, inert CodeQL config | M | [ci-build](areas/ci-build.md) | [I](tracks/I-supply-chain.md) | |
| [1749](https://github.com/bloknayrb/tandem/issues/1749) | `fs.watch` dies after the first rename-replace, including Tandem's own save | H | [server-data](areas/server-data.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1750](https://github.com/bloknayrb/tandem/issues/1750) | Session filename ENAMETOOLONG poisons autosave for every document | H | [server-data](areas/server-data.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1751](https://github.com/bloknayrb/tandem/issues/1751) | Marks in raw-carrier blocks serialize as literal XML | H | [server-data](areas/server-data.md) | [D](tracks/D-word-and-markdown.md) | |
| [1752](https://github.com/bloknayrb/tandem/issues/1752) | `validateRange` has no bounds check; mid-surrogate, zero-length and fractional ranges accepted | H | [server-mcp](areas/server-mcp.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1753](https://github.com/bloknayrb/tandem/issues/1753) | Wikilinks escaped and user escapes stripped on save | H | [server-data](areas/server-data.md) | [D](tracks/D-word-and-markdown.md) | |
| [1754](https://github.com/bloknayrb/tandem/issues/1754) | Docx flat-text contract broken: tab/br/sym throw; empty paragraph +1 and page break −1 drift | H | [server-data](areas/server-data.md) | [D](tracks/D-word-and-markdown.md) | |
| [1755](https://github.com/bloknayrb/tandem/issues/1755) | Docx inline images dropped; export overwrites the original image-less | H | [server-data](areas/server-data.md) | [D](tracks/D-word-and-markdown.md) | |
| [1756](https://github.com/bloknayrb/tandem/issues/1756) | Desktop Quit hard-kills the sidecar; up to 60 s of edits lost | H | [server-runtime](areas/server-runtime.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1757](https://github.com/bloknayrb/tandem/issues/1757) | Supervisor stdin EPIPE is uncaught and exits the server | H | [server-runtime](areas/server-runtime.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1758](https://github.com/bloknayrb/tandem/issues/1758) | `tandem` from npm kills the desktop server: lock retry before `freePort` | H | [server-runtime](areas/server-runtime.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1759](https://github.com/bloknayrb/tandem/issues/1759) | stdio bridge identity check refuses every upgrade; retry churns sessions | H | [shared-cli](areas/shared-cli.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1760](https://github.com/bloknayrb/tandem/issues/1760) | No CLI path removes the channel shim; Desktop target deletes a hand-registered one | H | [shared-cli](areas/shared-cli.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1761](https://github.com/bloknayrb/tandem/issues/1761) | Desktop keychain is the mock backend (`keyring` without platform features) | H | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1762](https://github.com/bloknayrb/tandem/issues/1762) | Windows updater exe-unlock wait is dead code | H | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1763](https://github.com/bloknayrb/tandem/issues/1763) | Deferred autostart launcher can never be released (no Origin) | H | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1764](https://github.com/bloknayrb/tandem/issues/1764) | Block split, heading toggle and join collapse anchors; the read path persists it; undo after re-anchor freezes | H | [crdt](areas/crdt.md) | [B](tracks/B-anchors.md) | |
| [1765](https://github.com/bloknayrb/tandem/issues/1765) | Cross-block `tandem_edit` merge kills tail-block anchors | H | [crdt](areas/crdt.md) | [B](tracks/B-anchors.md) | |
| [1766](https://github.com/bloknayrb/tandem/issues/1766) | Critical Rule 6 is endpoint-only; spanning ranges delete headings | M | [crdt](areas/crdt.md) | [B](tracks/B-anchors.md) | |
| [1767](https://github.com/bloknayrb/tandem/issues/1767) | `textSnapshot` surrogate slice at the cap → RANGE_GONE forever | M | [crdt](areas/crdt.md) | [B](tracks/B-anchors.md) | |
| [1768](https://github.com/bloknayrb/tandem/issues/1768) | No-arg `restoreBackup` overwrites a `.docx` (decision 1) | H | [server-mcp](areas/server-mcp.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1769](https://github.com/bloknayrb/tandem/issues/1769) | Solo privacy: unconditional release, `heldInSolo` stamped from the window | H | [annotations](areas/annotations.md) | [C](tracks/C-privacy-and-authority.md) | |
| [1770](https://github.com/bloknayrb/tandem/issues/1770) | Annotation authority: author guards, dismiss-not-accept, resolves as user, undo ledger (decisions 3, 4) | H | [annotations](areas/annotations.md) | [C](tracks/C-privacy-and-authority.md) | |
| [1771](https://github.com/bloknayrb/tandem/issues/1771) | SKILL.md import recipe can never return anything | H | [skill-plugin](areas/skill-plugin.md) | [J](tracks/J-words.md) | |
| [1772](https://github.com/bloknayrb/tandem/issues/1772) | Armed bulk confirm survives a document switch | H | [client-ui](areas/client-ui.md) | [G](tracks/G-client-editor.md) | |
| [1773](https://github.com/bloknayrb/tandem/issues/1773) | Session delete and clear-all fire with no confirm or undo | H | [client-ui](areas/client-ui.md) | [G](tracks/G-client-editor.md) | |
| [1774](https://github.com/bloknayrb/tandem/issues/1774) | Find/replace off by one per hard break | H | [client-editor](areas/client-editor.md) | [G](tracks/G-client-editor.md) | |
| [1775](https://github.com/bloknayrb/tandem/issues/1775) | Slash menu fires inside code blocks | H | [client-editor](areas/client-editor.md) | [G](tracks/G-client-editor.md) | |
| [1776](https://github.com/bloknayrb/tandem/issues/1776) | `activity.cursor` is a ProseMirror position published as flat | H | [client-editor](areas/client-editor.md) | [G](tracks/G-client-editor.md) | |
| [1777](https://github.com/bloknayrb/tandem/issues/1777) | Keyboard: Ctrl+Enter double action, AltGr chords, `isComposing`, frozen `capturedRange` | M | [client-editor](areas/client-editor.md) | [G](tracks/G-client-editor.md) | |
| [1778](https://github.com/bloknayrb/tandem/issues/1778) | A11y: modal Tab trap missing, radiogroup double tab stops | M | [client-ui](areas/client-ui.md) | [G](tracks/G-client-editor.md) | |
| [1779](https://github.com/bloknayrb/tandem/issues/1779) | Solo copy overstates the hold | H | [product](areas/product.md) | [C](tracks/C-privacy-and-authority.md) | |
| [1780](https://github.com/bloknayrb/tandem/issues/1780) | Claude Code never logged in is counted as a crash | H | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1781](https://github.com/bloknayrb/tandem/issues/1781) | Browser build has no way to open a disk file | H | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1782](https://github.com/bloknayrb/tandem/issues/1782) | Recovery docs name `CTRL_ROOM.json`; the file is `__tandem_ctrl__.json` | H | [docs](areas/docs.md) | [J](tracks/J-words.md) | |
| [1783](https://github.com/bloknayrb/tandem/issues/1783) | Vacuous tests, permanently skipped E2E, `checkInbox` never driven | H | [tests](areas/tests.md) | [K](tracks/K-tests-and-lows.md) | |
| [1784](https://github.com/bloknayrb/tandem/issues/1784) | License-gate coverage regex hole; coverage-gate `includes(stem)` | H | [tests](areas/tests.md) | [K](tracks/K-tests-and-lows.md) | |
| [1785](https://github.com/bloknayrb/tandem/issues/1785) | Update window gates nobody: second const plus public fallback | H | [armed-license-gate](areas/armed-license-gate.md) | [H](tracks/H-the-flip.md) | |
| [1786](https://github.com/bloknayrb/tandem/issues/1786) | No detector for an entitlement-starved updater | H | [armed-license-gate](areas/armed-license-gate.md) | [H](tracks/H-the-flip.md) | |
| [1787](https://github.com/bloknayrb/tandem/issues/1787) | Desktop and npm share one app-data dir; post-v1.0 gate bypass (decision D) | H | [upgrade-path](areas/upgrade-path.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1788](https://github.com/bloknayrb/tandem/issues/1788) | Armed gate correctness: perpetual trial on empty `firstRunAt`, restricted-mode asymmetry, ungated release route | H | [armed-license-gate](areas/armed-license-gate.md) | [H](tracks/H-the-flip.md) | |
| [1789](https://github.com/bloknayrb/tandem/issues/1789) | License UX and ops | M | [armed-license-gate](areas/armed-license-gate.md) | [H](tracks/H-the-flip.md) | |
| [1790](https://github.com/bloknayrb/tandem/issues/1790) | Skill and plugin version skew | M | [upgrade-path](areas/upgrade-path.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1791](https://github.com/bloknayrb/tandem/issues/1791) | Annotation envelope compatibility across versions | M | [upgrade-path](areas/upgrade-path.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1792](https://github.com/bloknayrb/tandem/issues/1792) | Upgrade and downgrade UX | M | [upgrade-path](areas/upgrade-path.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1793](https://github.com/bloknayrb/tandem/issues/1793) | Issuance worker hardening | M | [infra-license-worker](areas/infra-license-worker.md) | [H](tracks/H-the-flip.md) | |
| [1794](https://github.com/bloknayrb/tandem/issues/1794) | Permission relay is a stub; verdict discarded | M | [security](areas/security.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1795](https://github.com/bloknayrb/tandem/issues/1795) | `tandem_search` regex blocks the server | M | [server-mcp](areas/server-mcp.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1796](https://github.com/bloknayrb/tandem/issues/1796) | Convert with missing output dir says "No document is open" | M | [server-mcp](areas/server-mcp.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1797](https://github.com/bloknayrb/tandem/issues/1797) | `closeDocumentById` basename lookup vs raw-id cleanup | M | [server-mcp](areas/server-mcp.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1798](https://github.com/bloknayrb/tandem/issues/1798) | `.html` opens editable with session-only save (decision 2) | M | [server-mcp](areas/server-mcp.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1799](https://github.com/bloknayrb/tandem/issues/1799) | Inline image splits paragraph; fence meta dropped | M | [server-data](areas/server-data.md) | [D](tracks/D-word-and-markdown.md) | |
| [1800](https://github.com/bloknayrb/tandem/issues/1800) | Corrupt `ydocState` never quarantined | M | [server-data](areas/server-data.md) | [A](tracks/A-stop-the-bleeding.md) | |
| [1801](https://github.com/bloknayrb/tandem/issues/1801) | `MAX_CONFIG_BYTES` 5 MiB; boot sweep leaves a stale path | M | [server-runtime](areas/server-runtime.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1802](https://github.com/bloknayrb/tandem/issues/1802) | `applyConfig` replaces a malformed `~/.claude.json`; wizard silent | M | [server-runtime](areas/server-runtime.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1803](https://github.com/bloknayrb/tandem/issues/1803) | ADR-027 write guards disagree on audience | M | [annotations](areas/annotations.md) | [C](tracks/C-privacy-and-authority.md) | |
| [1804](https://github.com/bloknayrb/tandem/issues/1804) | Monitor and shim exit after five SSE retries | M | [shared-cli](areas/shared-cli.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1805](https://github.com/bloknayrb/tandem/issues/1805) | stdio bridge exits on preflight failure | M | [shared-cli](areas/shared-cli.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1806](https://github.com/bloknayrb/tandem/issues/1806) | `doctor` ignores `TANDEM_PORT` | M | [shared-cli](areas/shared-cli.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1807](https://github.com/bloknayrb/tandem/issues/1807) | `doctor` passes a user-level entry on key presence | M | [shared-cli](areas/shared-cli.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1808](https://github.com/bloknayrb/tandem/issues/1808) | `perform_install` failed download never respawns the sidecar | M | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1809](https://github.com/bloknayrb/tandem/issues/1809) | Post-boot sidecar crash never restarted | M | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1810](https://github.com/bloknayrb/tandem/issues/1810) | `refresh_registration` only on autostart launches | M | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1811](https://github.com/bloknayrb/tandem/issues/1811) | Plugin plus `setup --apply` loads the toolset twice | M | [skill-plugin](areas/skill-plugin.md) | [F](tracks/F-push-paths-and-cli.md) | |
| [1812](https://github.com/bloknayrb/tandem/issues/1812) | Sidecar health poll accepts any 2xx | M | [tauri](areas/tauri.md) | [E](tracks/E-desktop-lifecycle.md) | |
| [1813](https://github.com/bloknayrb/tandem/issues/1813) | Force-open and source-view unlink the envelope (decision C) | M | [server-data](areas/server-data.md) | [D](tracks/D-word-and-markdown.md) | |
| [1814](https://github.com/bloknayrb/tandem/issues/1814) | Wizard headline keyed on existing entries | M | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1815](https://github.com/bloknayrb/tandem/issues/1815) | "One click connects" vs the Done step | M | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1816](https://github.com/bloknayrb/tandem/issues/1816) | Raw errno and path in save-failure toasts | M | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1817](https://github.com/bloknayrb/tandem/issues/1817) | CLI-only push instructions shown to desktop | M | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1818](https://github.com/bloknayrb/tandem/issues/1818) | Restart copy trio; `tandem start --port` does not exist | M | [product](areas/product.md) | [J](tracks/J-words.md) | |
| [1819](https://github.com/bloknayrb/tandem/issues/1819) | `daysRemaining` unclamped; up-to-date dialog lacks ended-window branch | M | [product](areas/product.md) | [H](tracks/H-the-flip.md) | |
| [1820](https://github.com/bloknayrb/tandem/issues/1820) | SKILL.md content gaps | M | [skill-plugin](areas/skill-plugin.md) | [J](tracks/J-words.md) | |
| [1821](https://github.com/bloknayrb/tandem/issues/1821) | Docs drift batch: forty verified mismatches | M | [docs](areas/docs.md) | [J](tracks/J-words.md) | |
| [1822](https://github.com/bloknayrb/tandem/issues/1822) | Security Lows | L | [security](areas/security.md) | [K](tracks/K-tests-and-lows.md) | |
| [1823](https://github.com/bloknayrb/tandem/issues/1823) | Server Lows | L | [server-mcp](areas/server-mcp.md), [server-data](areas/server-data.md), [server-runtime](areas/server-runtime.md) | [K](tracks/K-tests-and-lows.md) | |
| [1824](https://github.com/bloknayrb/tandem/issues/1824) | Client Lows | L | [client-editor](areas/client-editor.md), [client-ui](areas/client-ui.md), [product](areas/product.md) | [K](tracks/K-tests-and-lows.md) | |
| [1825](https://github.com/bloknayrb/tandem/issues/1825) | CI, Tauri, tests and infra Lows | L | [ci-build](areas/ci-build.md), [tauri](areas/tauri.md), [tests](areas/tests.md), [infra-license-worker](areas/infra-license-worker.md) | [K](tracks/K-tests-and-lows.md) | |
| [1826](https://github.com/bloknayrb/tandem/issues/1826) | Annotation lifecycle Lows | L | [annotations](areas/annotations.md) | [C](tracks/C-privacy-and-authority.md) | |
| [1827](https://github.com/bloknayrb/tandem/issues/1827) | Decisions needed | D | — | [decisions.md](decisions.md) | |
