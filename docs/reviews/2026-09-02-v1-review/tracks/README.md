# Fix tracks

Eleven tracks, A through K. A track is a set of issues that share a mechanism, a reviewer agent
or a decision, so that one planning session covers them and one adversarial review catches what a
per-issue fix would miss. Each file names its issues, the [area ledgers](../areas/README.md) with
the evidence, the [experiments](../experiments/README.md) to run before and after, the agents to
spawn, the model tier the review recommends, the decisions it waits on, and what "done" means.

Tiers are a recommendation from how the review went, not a rule: Fable for judgment about
coordinate systems, privacy and the licence gate; Opus for builds that touch several modules;
Sonnet for well-specified edits with an Opus review before merge.

| Track | Issues | Tier | Waits on | Start |
|---|---|---|---|---|
| [A — Stop the bleeding](A-stop-the-bleeding.md) | #1749 #1750 #1752 #1756 #1757 #1768 #1795 #1796 #1797 #1798 #1800 | Opus | nothing (decisions 1, 2 taken) | **now**; ships with the next minor |
| [B — Anchors](B-anchors.md) | #1764 #1765 #1766 #1767 | Fable plan, Opus build, `crdt-reviewer` | a reviewed plan | after A |
| [C — Privacy and authority](C-privacy-and-authority.md) | #1769 #1770 #1779 #1803 #1826 | Fable plan, Opus build, `annotation-model-reviewer` | nothing (decisions 3, 4 taken) | after A; #1769 first |
| [D — Word and markdown](D-word-and-markdown.md) | #1751 #1753 #1754 #1755 #1799 #1813 | Opus | decisions A, B, C | after B is planned |
| [E — Desktop lifecycle](E-desktop-lifecycle.md) | #1758 #1761 #1762 #1763 #1787 #1791 #1792 #1808 #1809 #1810 #1812 | Opus, then hardware | decision D (one item); `cargo test` runnable | now for #1761; smoke lines on the release gate |
| [F — Push paths and CLI](F-push-paths-and-cli.md) | #1759 #1760 #1790 #1794 #1801 #1802 #1804 #1805 #1806 #1807 #1811 | Sonnet build, Opus review | nothing | now |
| [G — Client editor](G-client-editor.md) | #1772 #1773 #1774 #1775 #1776 #1777 #1778 | Sonnet build, Opus review, `svelte-migration-reviewer` | nothing | now |
| [H — The flip](H-the-flip.md) | #1785 #1786 #1788 #1789 #1793 #1819 | Opus, `security-reviewer` | decisions F and D; #1784 landed | after K's #1784 |
| [I — Supply chain](I-supply-chain.md) | #1744 #1745 #1746 #1747 #1748 | Sonnet build, Opus review | decision G (one item) | **now**; three are on the release gate |
| [J — Words](J-words.md) | #1771 #1780 #1781 #1782 #1814 #1815 #1816 #1817 #1818 #1820 #1821 | Sonnet build, Opus review | decision H (one item) | now |
| [K — Tests and Lows](K-tests-and-lows.md) | #1783 #1784 #1822 #1823 #1824 #1825 | Sonnet build, Opus review | nothing | **now**; #1784 before H |

[#1827](https://github.com/bloknayrb/tandem/issues/1827) is the decisions issue and belongs to no
track; [decisions.md](../decisions.md) is its snapshot.

## Suggested first session

1. Read [release-gate.md](../release-gate.md); do track I's three gate items and the Windows smoke
   run before anything else if a release is near.
2. Track A in the order its file gives, with `crdt-reviewer` on the `validateRange` change.
3. Track K's #1784 and #1783 (the gates other tracks will rely on).
4. Plan B and C with Fable and the adversarial review the repo's workflow requires, before any
   code in either.
5. Put decisions A through H in front of Bryan as one message; D, F, G and H each unblock a
   track's tail.

## The repo's own workflow applies

Plan (`/plan`), adversarial agent review of the plan, implement, `/simplify`, `npm run typecheck`
and `npm test` (plus `npm run test:e2e` for client changes), manual verification, then
`/commit-commands:commit-push-pr` and `/pr-review-toolkit:review-pr`. The review deferred the
"fix rather than file" rule so the picture would be complete; that deferral ended when this folder
was written.
