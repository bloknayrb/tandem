**What does correctness here depend on that is not in the repo?** e.g. what users put in their
documents, how a real upgrade behaves, what a specific OS or Claude Code build does. Write
"nothing — it's all derivable from the code" if that is the answer.

- [ ] Tier: **A** (a plan, reviewed by adversarial agents before implementation) or **B** (every path is on the `.claude/review-tiers.json` allowlist), per ADR-058
- [ ] `ownership-flag-on` passes (multi-session ownership is on since the flip, ADR-054, so `check` already runs it lit; the job stays until branch protection drops it)

Problem/solution, commands run, screenshots, `Closes #N`: see CONTRIBUTING.md.
