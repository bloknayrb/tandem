---
tags: [map, audience/maintainer, audience/contributor]
aliases: [Security and licensing, Security map, Licensing map]
---

# Security and licensing

Tandem's security model and its v1.0 licence system, which is built but ships dark. Back to the
[docs hub](../README.md).

## Security

- [Security](../security.md) answers "what can reach Tandem, and what stops it?" Read it before
  changing anything in the server's request path. Key sections:
  [network posture](../security.md#network-posture),
  [the CORS allowlist](../security.md#cors-allowlist), [auth tokens](../security.md#auth-tokens),
  [what actually guards a mutating route](../security.md#what-actually-guards-a-mutating-route),
  [privacy](../security.md#privacy) and
  [reporting security issues](../security.md#reporting-security-issues).
- [Open findings](../security.md#open-findings) is the register of known issues that are open,
  fixed but unverified, or accepted within stated bounds. Read an entry's bounds before assuming
  it covers your change.
- [CodeQL dispositions](../security.md#codeql-dispositions-and-why-they-do-not-survive-a-refactor)
  explains why dismissed alerts need re-checking after a refactor.
- [Data locations](../data-locations.md) is the inventory of everything Tandem stores, including
  the keychain and other programs' config files.
- [ADR-050](../decisions.md#adr-050-api-is-loopback-only-for-non-get-enforced-at-the-mount) and
  [ADR-056](../decisions.md#adr-056-the-non-loopback-bind-ships-dark) are the two decisions that
  shape the network boundary.

## Licensing (ships dark)

Nothing below is enforced today: the public beta is free for personal use, and the gate switches
on at v1.0.

- [How Tandem licensing works](../licensing-explained.md) answers "what will a licence do, and
  what happens without one?" Start with
  [Part 1, the plain-English version](../licensing-explained.md#part-1--the-plain-english-version);
  [Part 2](../licensing-explained.md#part-2--how-it-actually-works) is the engineering detail and
  [Part 3](../licensing-explained.md#part-3--the-failure-modes) the failure modes.
- [Licensing operations](../licensing-operations.md) is the owner's runbook: key management,
  grandfathering beta testers, the update and issuance endpoints, and the
  [v1.0 flag flip](../licensing-operations.md#4-the-v10-flag-flip-enabling-enforcement).
- [Licence terms](../licensing-terms.md) is a **working draft**, not legal advice and not
  published: what a purchase grants, refunds, the trial and open legal questions.
- [LICENSE](../../LICENSE) is the Business Source License 1.1 text itself, and
  [README → License](../../README.md#license) summarises it for users.
- The two Cloudflare Workers behind the system:
  [license issuance](../../infra/license-issuance-worker/README.md) turns a completed purchase into
  a signed licence, and [license update](../../infra/license-update-worker/README.md) serves the
  licence-checked update manifest.
- [ADR-040](../decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license)
  is the decision, and [CLAUDE.md → Licensing gate](../../CLAUDE.md#licensing-gate-1116-adr-040--ships-dark)
  lists the rules that keep it inert while dark.
- [The licence review](../reviews/2026-10-01-license-review.md) is a dated agent review of the
  licence and every place that restates it.

## Related maps

[Troubleshooting and your data](troubleshooting-and-data.md) · [Internals](internals.md) ·
[Releases and operations](releases-and-ops.md) · [Glossary](../glossary.md#licensing-gate)
