---
tags: [index, historical, evidence]
aliases: [Spikes, Spike index, Probes]
---

# Spikes and probes

> **Historical evidence: each file records what was measured, read or proposed on its date, and is
> not current guidance.** Several are cited by code comments, tests and ADRs as the evidence for a
> rule, so they stay at these paths and are not rewritten; a later finding is added as a banner or
> amendment. For how things work now, follow the [docs hub](../README.md); for the other
> historical sets, see the [History map](../maps/history.md).

One line per file, taken from its opening lines.

## Push, wake and the plugin

- [channel-push-stream-json.md](channel-push-stream-json.md): whether the channel delivers turns
  when Claude Code runs the way the auto-launcher starts it (2026-08-04). It does not, which is
  why the supervisor exists.
- [connection-honesty-findings.md](connection-honesty-findings.md): push delivery, connection
  honesty and the idle-wake primitive, measured on Windows (2026-08-07).
- [monitor-self-arm-probe.md](monitor-self-arm-probe.md): a self-armed Monitor as a push path, on
  real hardware (2026-08-07).
- [wake-socket-end-to-end.md](wake-socket-end-to-end.md): the shipped self-arm transport measured
  end to end, the measurement ADR-049 lacked (2026-08-08).
- [plugin-delivery.md](plugin-delivery.md): plugin install paths and monitor activation
  (2026-08-06); supersedes the marketplace spike on the install question.
- [plugin-monitor-tty-activation.md](plugin-monitor-tty-activation.md): whether plugin monitors
  activate in an interactive terminal session (2026-08-09).
- [plugin-monitor-viability-spike.md](plugin-monitor-viability-spike.md): an early NO-GO on
  dropping the channel flag, later reversed on a newer Claude Code (2026-05-17).
- [marketplace-install-spike.md](marketplace-install-spike.md): marketplace one-command monitor
  activation; marked superseded (2026-05-17).
- [skills-autoload-2.1.157-verification.md](skills-autoload-2.1.157-verification.md): a
  documentation-grounded check that skill auto-loading in newer Claude Code needed no fix
  (2026-06-07).

## Claude Code sessions, identity and transport

- [cli-session-resume-spike.md](cli-session-resume-spike.md): Claude Code session resume for the
  auto-launch supervisor; GO with caveats (2026-05-17).
- [sidecar-launcher-spike.md](sidecar-launcher-spike.md): validating the sidecar launcher; GO with
  caveats (2026-05-14).
- [per-client-identity-spec.md](per-client-identity-spec.md): a design spec for telling
  concurrent clients apart; its transport-multiplexing part shipped as ADR-045.
- [session-identity-transport-probe.md](session-identity-transport-probe.md): a proposed probe
  for getting a Claude session's identity onto the MCP connection; not run.
- [stateless-transport-probe.md](stateless-transport-probe.md): a source read that refuted
  ADR-012's old claim about the SDK's session-free transport mode (#1253, #1332).
- [ai-readiness-mcp-session.md](ai-readiness-mcp-session.md): the root cause behind two
  AI-readiness issues and the contract options; a proposal awaiting a decision.
- [directory-scoped-instances.md](directory-scoped-instances.md): whether separate Claude
  instances should connect per document folder; a research note, nothing built (2026-08-05).
- [2026-09-17-claude-merged-app-and-codex-mcp-probes.md](2026-09-17-claude-merged-app-and-codex-mcp-probes.md):
  compatibility probes against the merged Claude desktop app and the Codex CLI; the defects found
  were filed as issues.
- [multi-session-ownership/](multi-session-ownership/README.md): the decided but unimplemented
  design for documents shared between several sessions, with
  [user stories](multi-session-ownership/stories.md) and five adversarial
  [reviews](multi-session-ownership/reviews/).

## `.docx` engines (`.docx` ships dark)

- [docx-libreoffice-spike.md](docx-libreoffice-spike.md): LibreOffice headless for `.docx`
  write-back (2026-05-14).
- [docx-npm-spike.md](docx-npm-spike.md): the `docx` npm package as a write-back engine; a
  prototype only.
- [genoffice-docx-engine-spike.md](genoffice-docx-engine-spike.md): the GenOffice engine as a
  byte-preserving save path; investigation only (2026-08-05).
- [superdoc-engine-spike-plan.md](superdoc-engine-spike-plan.md) and
  [superdoc-engine-spike.md](superdoc-engine-spike.md): the plan and verdicts for SuperDoc as the
  `.docx` engine; shelved with ADR-052 (2026-09-24).

## Local models, install and update

- [local-llm-capability-spike.md](local-llm-capability-spike.md): whether a local model can act
  as a full collaborator; no model cleared the bar, so it ships as an opt-in (the feature ships
  dark).
- [linux-container-install-smoke.md](linux-container-install-smoke.md): the Linux install matrix
  smoke-tested in containers against real release packages (2026-07-22).
- [updater-rollback-healthpoll-audit.md](updater-rollback-healthpoll-audit.md): the updater's
  rollback and post-restart health check, the audit behind ADR-043 (2026-06-07).

## Process

- [ai-debugging-blind-spots-audit.md](ai-debugging-blind-spots-audit.md): what Tandem took from
  an external study of AI debugging blind spots; the source of several workflow rules
  (2026-08-25).
