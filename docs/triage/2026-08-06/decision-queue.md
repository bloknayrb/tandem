# Decision queue — 16 rows

Sixteen questions that need your judgement rather than an implementer's. Three are already answered and are kept here for the record. The other thirteen are blocking work.

Each row is self-contained: you should not need to open the briefs. Where a brief exists it is linked, and where I have a recommendation it is stated plainly rather than hedged. Rows marked **no recommendation** are ones where I genuinely do not have a view worth acting on.

Comment on any heading and I will pick it up.

---

## How to read the confidence marks

**High** means the brief traced the question to code or history and the answer follows from evidence. **Medium** means the reasoning holds but something load-bearing is unverified — those two rows say what is unverified and why I could not settle it.

---

# Already decided

## D-6 — Themed native menus ✅ DECIDED: yes

Accept `set_theme`'s blast radius — it also reaches native file dialogs and the title bar — in exchange for context menus that follow an explicit in-app theme override. Option 1 from the brief: a `set_window_theme` command with the effect gated on `theme !== 'system'`, roughly 40 lines.

**Condition attached.** This was rated *medium* confidence, alone among the recommendations. muda's Win32 popup dark mode is known to lag behind the theme call, and that behaviour is unverified — neither I nor CI can confirm it. **Hand-verify on the Windows box before the changelog line is written.** If the scope grows past ~40 lines, that is a signal the blast radius is wider than the brief measured, and it should come back rather than expand in place.

Queued for Wave 5. Recorded on #992.

## D-12 — Solo status copy ✅ DECIDED: fix the copy

Do not suppress the working-pill or status text in Solo. Copy pass over `SOLO_PAUSED` in `status-ai-view.ts`, one conditional in the `aiIndicatorContent` snippet, the five-surface enumeration recorded, E2E on `status-ai-indicator`. Client-only.

Suppression was rejected because hiding the pill makes *idle* and *working-invisibly* indistinguishable — trading a wording problem for a state-visibility problem. Option C (server-side mode gates on the writes) stays rejected on stronger grounds: it would be the first place Solo suppresses **state** rather than **delivery**, which is a different privacy model than the one WS-A2 shipped.

Queued for Wave 5. Recorded on #1287.

## D-16 — CLI version pin ✅ DECIDED: declined

No `requiredMinimumVersion` / `requiredMaximumVersion` in managed settings. The issue explicitly allowed for this, and its other half had already shipped in `f13f81d`. **#1045 is closed.**

---

# Open — the eleven with a confident recommendation

## D-1 — The design-system shelf (#989, #964, #928, #916, #892, #832)

**Question:** defer four past v1.0, ship #832's left-rail half now, and close #892 as superseded?

**Recommendation: yes** ([brief-design-shelf.md](brief-design-shelf.md), high confidence)

All six are April–June, zero-comment, deferred UI polish with no roadmap linkage — which is what makes them one question rather than six. Two carve-outs are why this is not a blanket defer:

- **#832's left-rail half is worth doing now.** `PeekStrip.svelte:77-81` currently hardcodes fake heading levels (h1/h2/h2/h3/h2) on a *shipped* surface. That is not deferred polish, it is a shipped lie about the user's document. One small PR threads the real levels through.
- **#892 is closeable, not deferrable.** Its stated motivation — anchored margins degrading under collision pressure — was consumed by #917, shipped 2026-07-30.

**If no:** #989 and #892 each need their own design pass; #964 needs a streaming document-write path that does not exist; #916 needs a user-feel tuning procedure nobody has defined.

## D-2 — Cowork on macOS and Linux (#316, #317, #552)

**Question:** does v1.0 ship Cowork auto-setup on macOS/Linux, or Windows-only with the rest deferred?

**Recommendation: Windows-only** ([brief-platform.md](brief-platform.md), high confidence)

About a day of copy and roadmap edits: reword `CoworkSettings.svelte:137`, document the manual `npx -y tandem-editor mcp-stdio` path.

**If no:** #317 becomes a v1.0 blocker requiring a real-Mac network-topology probe before anything can be estimated, so hardware acquisition moves onto the critical path ahead of code.

Worth knowing: the Cowork field report (#1298) came in on Windows and failed at vEthernet subnet detection, so the Windows path is not itself free of trouble.

## D-3 — #997 right-click selection pop-up

**Question:** ship the reduced right-click re-arm, or close in favour of extending the #923 native menu?

**Recommendation: close #997, extend the native menu** ([brief-997.md](brief-997.md), high confidence)

Two of the issue's premises are stale at HEAD: the pop-up now defaults *below* (`selection-toolbar.ts:36-42`), and it is armed only by pointerup or keyboard dwell with an `e.button !== 0` early return (`Toolbar.svelte:196-197`, `:391`) — so a right-click never arms it at all. The literal ask, DOM painted above an OS menu, is impossible, and the issue itself admits it.

Yes means: add annotate/highlight items to `context-menu/{types,dispatch}.ts` plus the Rust builder.

**If no:** a hand-run Windows spike on DOM-paint-before-`popup_menu` is needed before anyone can estimate it.

## D-4 — #995 tables in the editor

**Question:** ship `/table` as a fixed 3×3-with-header slash command only?

**Recommendation: yes** ([brief-995.md](brief-995.md), high confidence)

One PR: a `SlashCommandId` entry, a unit test, a round-trip E2E. The paste line item can be closed as already shipped (`markdown-paste.ts:247-259,337`, #1184 / `624eb4e`).

**If no:** column-alignment UI needs its own design pass, which is the part that turns a small feature into a project.

## D-5 — #994 context-menu policy + #1262 Settings organisation

**Question:** adopt the allowlist context-menu policy, and is the Settings split "Appearance = looks / Editor = behaves"?

**Recommendation: yes to both** ([brief-994.md](brief-994.md), high confidence)

One client module plus per-surface markers, no Rust. **Never `Flags::CONTEXT_MENU`** — that is the trap this brief exists to steer around.

The Settings half is a small markup PR. Note that E2E selectors like `appearance-show-raw-markdown` will need aliases, since the testid set is a contract that may gain entries but must not lose them.

## D-7 — #321 Hocuspocus WebSocket LAN auth

**Question:** close as "condition unmet", or park with a named reopen trigger?

**Recommendation: park** ([brief-321.md](brief-321.md), high confidence)

The precondition is verifiably unmet: Hocuspocus is hard-bound to loopback (`provider.ts:107-112`), Cowork reaches Tandem through a host-side stdio proxy (ADR-023), and the launcher is forbidden from a wildcard bind except behind an opt-in that is itself unbuilt — `integrations_probe.rs:322-324` says it must never set `TANDEM_BIND_HOST=0.0.0.0` *"unless the user has opted into LAN mode with an auth token."*

Parking keeps that loopback constraint discoverable as a **decision** rather than as an incidental comment. Yes means a body edit and stripping `needs-design-decision`.

**If no:** close it and add a sentence to ADR-023's consequences so the constraint does not vanish with the issue.

## D-8 — #438 per-client identity (and #1252, #1253, #1249)

**Question:** close #438 as superseded, and commit to "dual-era, legacy retained indefinitely"?

**Recommendation: yes to both** ([brief-438.md](brief-438.md), high confidence)

Phase 1 shipped as ADR-045 / PR #1233. The design doc #438 still asks for already exists (`docs/spikes/per-client-identity-spec.md`, PR #1064), and it calls transport multiplexing an open evaluation that ADR-045 answered — so leaving it open actively misleads readers.

**This row has moved since the brief was written.** The #1253 probe has now run, and its findings change what "dual-era" costs — see the note under D-14's neighbours and issue **#1332**. Specifically: SDK v2 has no *stateful* legacy option, so adopting v2 would **delete** ADR-045 Decisions 1, 3 and 4 rather than scope them to legacy. Worth reading #1332 before answering this one.

## D-9 — #798 motion umbrella

**Question:** does GA need all of A1–A29, or the named subset?

**Recommendation: the named subset — which is already on master** ([brief-798-status-audit.md](brief-798-status-audit.md), high confidence)

27 of 29 scenes plus s3 verified commit-by-commit. A6b and A16b are the only outstanding halves, and #798's own definition of done permits "a documented exemption in motion.md."

Yes means one docs-only PR: exemption paragraphs for A6b and A16b, reconcile the stale DoD checkboxes at `motion.md:347-356` (**six of eight unchecked** — the triage doc originally said "four of seven" and that was wrong), then close #798.

**If no:** someone builds a runtime SVG connector tracking two moving DOM nodes across scroll, rail-resize and margin-mode changes — design review first.

## D-10 — #1263 chat scope

**Question:** keep chat global in CTRL_ROOM?

**Recommendation: remain global** ([brief-1263.md](brief-1263.md), high confidence)

This is decided-not-changed: chat is already global (`constants.ts:184`, `awareness.ts:94-95`, `ctrl-chat.ts:19`), and #1264 already made unread counts and filenames documentId-aware while deliberately leaving scope global. Yes costs one ADR and a close, no code.

**If no:** multi-PR — per-room chat maps, a `chatSeen` baseline migration, a home for documentId-less messages, and re-deciding Clear-Chat's blast radius.

## D-11 — #1308 kill-gates (and PR #1311)

**Question:** merge the knowledge-graph retirement but restore `/diverge`, and adopt kill-date-as-issue?

**Recommendation: split PR #1311** ([brief-1308.md](brief-1308.md), high confidence)

**This is the row I would re-read first.** The two experiments do not have the same verdict:

- **The KG pilot's kill criterion was met** — 27 nodes, 27 staleness warnings, last content commit `dd39e8f` on 2026-05-25.
- **`/diverge`'s was not.** It was invoked at `9657de1` (2026-05-29) and again on 2026-07-20 in `.claude/plans/diverge/solo-defer-and-release.md` — 23 days *past* the gate. The sweep that judged it (`767b7d1`) could not see either, because `.claude/plans/` is gitignored.

So the honest outcome is: kill the KG, restore `/diverge`, and re-date its gate with a **tracked-file-evaluable** criterion so this cannot recur. Plus two kill-gate issues and a convention in CLAUDE.md.

**If no** (merge #1311 as-is): the commit message's claim that `/diverge` was never invoked must still be corrected, since `.claude/plans/diverge/` remains on disk contradicting it.

## D-13 — #630 startup-file follow-ups

**Question:** rewrite to items 4–7 plus 8, or close outright?

**Recommendation: rewrite** ([brief-630-split.md](brief-630-split.md), high confidence) — **with one amendment since the brief.**

The brief refutes the original plan's requested split: items 1, 2 and 3 all shipped 2026-06-08 in `01e8adc`, independently confirmed (`RejectionReason` at `lib.rs:342`, `STARTUP_REJECTION` Mutex at `:148`, `classify_opened_url` at `:453`).

**The amendment: do not describe item 2 as shipped.** Wave 2 found it does not work on macOS at all. The buffer's only feeder is `setup()`'s argv read, and macOS uses Apple Events instead — `classify_opened_url` has no extension check and no `is_file()` check, so a Finder double-click on a bad file passes classification, gets a 4xx, and fails log-only. No toast on any surface. That is the exact silent-drop-to-`welcome.md` failure item 2 exists to kill, and it is user-visible, which puts it in a different class from items 4–7 whose whole deferral rationale is that they are diagnostics-only.

**If no** (close outright — also defensible, since all user-visible payload shipped on two of three platforms): record that 4–7 were dropped as diagnostics-only so they are not later mistaken for unfinished correctness work, and file the macOS gap separately.

---

# Open — the three where I have no recommendation

## D-14 — #1213 Solo gate redundancy ⚠️ blocks Wave 3

**Question:** build a capability-negotiation seam, or accept two permanent Solo gates?

**No recommendation offered.**

Solo mode hides your annotations from the AI. Two independent gates enforce it on the event stream. The server-side one (`queue.ts:175-180`) shipped. The consumer-side one lives in the monitor/channel shim (`sse-consumer.ts:472-479`) and reads a ~2s-cached mode.

**#1213's step 2 instructs deleting the consumer gate. That instruction is wrong**, and four sources in the repo say so — CLAUDE.md, the in-code comment at `sse-consumer.ts:455-459`, the brief, and your own comment of 2026-08-02. The reason is version skew: `.claude-plugin/plugin.json` pins the monitor to `tandem-editor@0.20.1` while the desktop server updates on the Tauri updater's own track, with no handshake. A *new* monitor against an *older, un-gated* server is routine, and on that pairing the consumer gate is the only thing between Solo and a silent privacy leak with no visible symptom.

Three ways forward:

1. **Keep both gates permanently.** Cost: one fire-and-forget `/api/mode` fetch per non-chat event and a stale-preserving cache. Retitle #1213 so the tracker stops instructing a deletion four in-repo sources forbid.
2. **Build a capability seam** — the server advertises `soloForwarderGate: true` on `/api/info`; the consumer skips its own gate when it sees that. Removes the redundancy at the cost of permanent public API surface.
3. **Ship monitor and server as one artifact**, which the in-code comment itself names as the real retirement condition. Eliminates the skew class entirely; much bigger change.

*My lean, for what it is worth: (1) now, with (3) as the actual long-term answer whenever packaging is revisited. (2) trades a cheap redundancy for expensive permanent API surface.*

Whatever the answer, the issue's line references need correcting: the gate is `queue.ts:175-180` (not `sse.ts`), the consumer gate is `sse-consumer.ts:472-479` (not `:398-406`), and the collaborator abort is `collaborator.ts:302-303`.

## D-15 — #1197 WebDriver smoke

**Question:** keep spending `workflow_dispatch` cycles on the WebView2/msedgedriver regression, or declare it environmentally dead and record the skip?

**No recommendation from the brief; I have a lean, stated below.**

The original cause is **fixed**: Microsoft published a `LATEST_RELEASE_150` pointer to a driver build whose zip was not on their CDN (`BlobNotFound`). PR #1261 added a pinned table plus in-major walk-back, and the CDN self-healed.

But the job still fails, for a different reason, and the obvious hypothesis is **refuted by measurement**. Runs 30974836130 / 31022514071 / 31027157696 all report `Edge WebDriver: 150.0.4078.105 (exact runtime match)` and still die on `DevToolsActivePort file doesn't exist`. The app is provably alive in the same run (`[Hocuspocus] Client connected to: welcome-fnxsvz`) — only the CDP handshake is missing. There is no version knob left to turn.

Next suspect is a collision between wry's WebView2 `AdditionalBrowserArguments` and the driver's `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` — unverified, Windows-only, not reproducible from an agent session.

*My lean: declare it environmentally dead, record the skip per the no-hardware-for-release-smoke convention, close #1197 with cause (a) fixed and (b) documented as third-party.* The counter-argument is real though — this is your **only** automated coverage of the packaged desktop app. Weigh that against a smoke test that has not yet caught a real defect and costs a spike per release.

## D-16 → see "Already decided" above

---

# Not in the original sixteen, but waiting on you

## #1320 — ten ungated mutating `/api` routes

Ten mutating routes call **neither** `assertLoopbackForMutation` nor `assertOriginAllowlisted`: `open`, `save`, `convert`, `upload` (these four take a caller-supplied filesystem path), plus `close`, `scratchpad`, `apply-changes`, `annotation-reply`, `remove-annotation`, `rotate-token`.

The path-taking four are the expensive half — `open` and `save` are what the app *is*, and the licensing gate treats them as Allowed on exactly that basis. The other six are cheap.

The count going from four to ten makes **option 3 — declare `/api` loopback-only as an invariant** — more attractive than when it looked like four, because a per-route decision now has ten rows and the next new route inherits nothing.

## #1334 — the annotation accept round-trip

~520 ms of a 500 ms budget is intentional #798 card-entrance motion. Three exits: measure the status flip instead of the control's removal (cheapest, and arguably measures the right thing), raise the threshold as motion-inclusive, or cut the motion. Two roadmap decisions and one design decision.

## #1292 — does a bounded amplification clear a HIGH?

Measured: the caps bound the quadratic blowup but do not remove it. One 64 KiB reply costs ~27 MB of broadcast; a 12-turn tool loop reaches ~325 MB, silently. No attacker, and the victim is the user's own editor.

Clears it? The unbounded case is gone and 27 MB of loopback traffic is a stutter, not a denial. Doesn't clear it? The defect as titled is measurably still present. **This decides whether `docs/roadmap.md:614` can flip from FAIL to PASS**, which is a v1.0 exit criterion.
