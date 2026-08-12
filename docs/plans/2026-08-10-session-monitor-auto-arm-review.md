# Review: Per-session monitor auto-arm plan

**Date:** 2026-08-10
**Reviewed plan:** `docs/plans/2026-08-10-session-monitor-auto-arm.md`
**Verdict:** Not ready for implementation. Two P0 rollout holes and several P1 design and
verification gaps remain.

This review reflects independent host-mechanics, architecture, and UX/test passes against
the current plan and repository evidence. The reviewers agreed that the rewritten plan has
better repository analysis, but its central qualified-only plugin design is not yet safe.

## Findings

### [P0] Removing the bare plugin trigger strands double-installed Windows users without Git Bash

The plan claims that retaining only the qualified plugin trigger preserves the Windows
population while eliminating double-install duplication (`plan:480`). That conclusion does
not follow from F6/F7.

F7 establishes that, in a double-installed configuration, a bare dispatch selects the
standalone skill and does not fire the qualified trigger
(`docs/spikes/plugin-monitor-tty-activation.md:171-197`). On Windows without Git Bash, the
standalone skill cannot invoke Claude's built-in Monitor, while the packaged plugin monitor
can still run (`docs/spikes/plugin-monitor-tty-activation.md:456-463`).

Removing the bare trigger therefore changes this:

```text
standalone dispatch + bare plugin trigger -> packaged monitor
```

into this:

```text
standalone dispatch + no bare trigger -> no monitor
```

The F6/F7 selection asymmetry is not a free discriminator for this population.

**Required correction:** retain the bare trigger unless double-installed users are migrated
to a shape where the qualified trigger fires, or another automatic path covers users who do
not have the built-in Monitor tool.

### [P0] Repository PR ordering cannot protect independently updated installations

The plan treats "PR1 and PR2 shipped before PR4" as equivalent to "standalone skill v10 is
on disk before the plugin loses its bare trigger" (`plan:491-522`). Releases do not impose
that update order on individual users.

A user can have:

```text
old Tandem Desktop/server + standalone skill v9 + newly updated plugin manifest
```

The standalone v9 copy wins the bare dispatch, may decline to self-arm because an unrelated
subscriber exists, and the qualified plugin trigger does not fire. This recreates the exact
zero-wake-path failure being fixed.

The plugin is sourced and cached independently of Tandem Desktop. The newer server can
refresh the standalone file only after that newer Tandem version is installed and run.

**Required correction:** treat trigger removal as a cross-channel migration, not repository
sequencing. Either retain the compatibility trigger, introduce a mechanism that establishes
a minimum installed Tandem/skill version before removal, or provide a migration that cannot
leave old standalone copies in the winning position. Waiting one release is insufficient
because users may skip desktop updates indefinitely.

### [P1] The wizard plugin action creates the duplicate configuration the plan warns against

The current integration apply route installs the Tandem-managed Claude MCP configuration and
then installs the standalone skill when setup applies changes
(`src/server/integrations/api-routes.ts:857-893`). The plan adds a wizard action that installs
the plugin (`plan:561-569`), while later acknowledging that installing it after managed setup
duplicates MCP tools and skill copies (`plan:574-576`).

**Required correction:** model these as mutually exclusive connection routes selected before
mutation:

- **Tandem-managed:** write the managed MCP entry and standalone skill; do not install the
  plugin.
- **Plugin-managed:** install the plugin; skip the managed Claude MCP entry, channel entry,
  and standalone `installSkill()` path.
- **Existing mixed state:** show a migration preview and obtain separate consent before
  removing an existing route.
- **Existing plugin-only state:** show that the plugin is installed rather than offering a
  second connection.

If safe migration is outside this work's scope, #1390 should expose copyable commands or an
open-terminal path rather than execute installation.

### [P1] Plugin installation lacks an implementation, security, recovery, and test contract

The plan says `execFile` makes a one-click install possible, but it does not define a
shippable implementation boundary or corresponding tests.

**Required correction:** add a dedicated work package, preferably separate from the manifest
change, covering:

- a loopback-only, Origin-checked, nonce-protected server endpoint;
- a fixed executable and allowlisted arguments, with no client-supplied command fragments;
- detection and idempotency for marketplace present, plugin installed, plugin enabled,
  plugin disabled, and alternate marketplace installations;
- timeout, cancellation, a restricted environment, and bounded/scrubbed output;
- partial failure when marketplace registration succeeds but plugin installation fails;
- confirmation, installing, installed, partial failure, retry, and cancellation UI states;
- success wording that says only "Plugin installed," never "live updates enabled";
- tests for no-click/no-mutation, exact arguments, missing Claude CLI, timeout, command
  failure, retry, existing installation, non-loopback/CSRF rejection, and output redaction.

### [P1] Probe M and Probe Q turn inconclusive host failures into manifest decisions

The plan treats "did not arm" as evidence that marketplace monitors never work or that both
entries should be removed (`plan:351-389`). A null result can instead reflect safe mode,
remote/account gating, an untrusted workspace, hooks policy, PATH or `npx` failure, a dead
capture, or the wrong session mode. The existing shipped probe already preserves an
INCONCLUSIVE outcome when its positive control does not arm
(`scripts/spikes/probe-shipped-arm-trigger.py:221-246`).

Probe M also cannot transfer F1/F6/F7/F8/F10 wholesale from one double-install bare-name
cell, and Probe Q failure does not prove that the bare packaged path is useless to
double-installed Windows users.

**Required correction:** give each probe PASS, FAIL, and INCONCLUSIVE outcomes. Require a
trusted interactive TTY, safe mode off, hooks allowed, a positive control, observed skill
dispatch, and a healthy capture. Separate trigger matching with a marker command from real
`npx` process liveness and wake delivery. Record plugin-only/double-installed and
bare/qualified cells independently; no single-cell failure may justify full removal.

The document must also state one consistent PR4 gate. Its header says one approximately
105-second run, while the body defines M, S, Q, and T and the sequence requires only Q.

### [P1] Natural-language first use remains effectively ungated

PR1 is described as the behavioral fix and may ship without a probe (`plan:221-253`), while
real-host acceptance allows every natural-language attempt to skip skill dispatch by saying
to record the ratio and re-run (`plan:631-645`). Existing F6/F7/F10 evidence used explicit
slash dispatches, not ordinary natural-language Tandem work.

**Required correction:** before making the first-use product claim, run a bounded
natural-prompt sample plus an explicit `/tandem` control. At least one natural dispatch must
execute the revised instruction, arm the Monitor, receive a user-event wake, and call
`tandem_checkInbox`. Zero natural dispatches means the change may ship only as an instruction
improvement; it has not demonstrated the requested automatic first-use behavior.

Natural-language tests should also use version-distinctive plugin and standalone bodies in
both plugin-only and double-installed configurations. F6/F7 cannot establish which copy the
model selects automatically because those probes dispatched explicit names.

### [P1] Probe S still confounds skill caching with natural skill selection

Probe S says to use a version-distinctive marker, but PR1's real v10 skill does not contain
that probe marker, and natural dispatch can fail independently of caching (`plan:362-377`).

**Required correction:** split the probe:

1. Verify that actual PR2 refreshes the disk file from real v9 to real v10.
2. In an isolated fixture, give cached v9 and candidate v10 unconditional distinctive
   markers, start Claude before the server refresh, then explicitly invoke `/tandem` to
   isolate whether the host cached the old body. Repeat with Claude started after Tandem is
   ready.

Natural prompting belongs in PR1 acceptance, not in the cache-isolation probe.

### [P1] PR1 and PR2 may merge independently but should not release independently

PR1 changes the bundled instructions. PR2 is what delivers those instructions to the
launcher-disabled and deferred-autostart population that reported the problem. Calling PR1
independently shippable overstates the user-visible fix.

**Required correction:** PR1 and PR2 may be separate review units, but the release and
changelog claim must contain both. Add a combined acceptance test that seeds installed v9,
starts Tandem through normal, launcher-disabled, and deferred-autostart paths, verifies the
awaited v10 refresh, then starts Claude and exercises the original natural-prompt repro with
an unrelated subscriber attached.

Do not ship #1389's automatic-attempt wizard copy until this combined path passes.

PR3 also edits `SKILL.md` after PR1's version-10 bump. If that edit is not folded into PR1
or accompanied by another version bump, the version-monotonic refresher may not deliver the
corrected PR3 guidance to users who already received version 10.

### [P1] Doubled wakes are opportunistic evidence, not reliable arbitration

The plan describes doubled wakes as appearing if and only if a second path is delivering and
treats `TaskStop` as the definitive discriminator (`plan:175-186`). Wake rate limiting can
coalesce, delay, or suppress notifications while both streams remain active. Explicitly
dispatching the qualified skill in a double-installed session can also retain duplication.

**Required correction:** describe doubled-wake detection as opportunistic recovery. The
actual safety contract is payload-free wakes plus authoritative inbox de-duplication.
Duplicate wake and token costs may persist for the session; the plan must not claim they are
always bounded by `TaskStop`.

### [P2] Wizard tests do not prove branch-specific truthfulness

The test plan checks that the primary message appears for registered, unregistered, and
unknown states, but that would still pass with incorrect fallback instructions or inferred
success styling.

**Required correction:** assert the complete rendered contract:

- All states: attempt-based wording, Monitor qualification, and no configured/on/live claim.
- Registered: launch flag only; registration is not delivery.
- Unregistered: registration plus launch instructions.
- Unknown: explicitly unverified and no success styling.
- Claude Desktop/stdio: no Claude Code Monitor or plugin guidance.
- Plugin success: "installed," followed by conditional first-use behavior, never live.
- Plugin absent, installed, disabled, partial failure, and managed-plus-plugin conflict
  states.

### [P2] Unsupported plugin-update behavior is stated as fact

The unpinned GitHub marketplace source proves that Tandem cannot refresh Claude's plugin
cache. It does not by itself prove that updates occur only after an explicit
`claude plugin update` (`plan:295-309`). Qualify that statement or verify current Claude CLI
behavior. The safety conclusion should rely only on the fact Tandem does not control when
the cached plugin changes.

### [P2] Probe T does not yet test enumeration directly

Dispatching twice and after `/compact` observes duplicate behavior, not whether the model can
enumerate its own live Monitor tasks (`plan:391-399`). The candidate instruction must attempt
to list or resolve current tasks before a second arm, record available tools and returned task
IDs, and retain an INCONCLUSIVE branch. This remains non-blocking.

## What should remain from the rewrite

The revised plan correctly identifies and should preserve:

- the skill-refresh reachability defect;
- the plugin-cache ownership boundary;
- the built-in Monitor versus Windows Git Bash asymmetry;
- attempt-based rather than configured/on/live copy;
- payload-free wake behavior;
- Solo-mode privacy gates;
- `tandem_checkInbox` as the authoritative source;
- supervisor sessions as a separate wake path;
- a qualified plugin monitor as useful coverage for plugin-only users.

## Recommended revision direction

1. Keep PR1 and PR2 as focused implementation units, but release and validate them together.
2. Retain both packaged plugin triggers for this release; document duplicates honestly.
3. Recast manifest narrowing as later migration work, not a consequence of repository PR
   ordering.
4. Make #1390 a mutually exclusive connection-choice design. If migration and safe command
   execution are too large for v0.21, surface copyable plugin commands instead.
5. Replace binary probe nulls with controlled PASS/FAIL/INCONCLUSIVE outcomes.
6. Require bounded natural-language acceptance before claiming the reported gap is fixed.
7. Keep all wizard status language conditional until Tandem can directly observe
   per-session delivery.

## Review provenance

Three independent adversarial reviewers examined the current plan against host mechanics,
architecture/rollout behavior, and UX/test behavior. All three found release blockers. No
product files were changed during review.
