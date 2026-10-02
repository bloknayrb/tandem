# Licence review, 2026-10-01

This is an independent review of the repository `LICENSE` (Business Source License 1.1) and of every document, string and manifest that restates its terms. It was done by an agent, not by a lawyer. Nothing here says the licence is legally sufficient, enforceable or compliant. It is a cleaner draft plus a list of decisions.

## Summary

The Terms section of `LICENSE` matches the governing text word for word. The differences are all in the parts around it: the header line, a missing closing paragraph and the missing Covenants section, and a Notice heading with nothing under it. None of those were changed: adding or removing sections of the licence file is the licensor's call.

Four restating places disagreed with `LICENSE` and were fixed. Four more disagreements are reported without a fix, each with the reason.

Nine findings need a decision from the licensor, because they change a Parameter. Drafted wording is given for each. None has been applied.

Legal judgements are out of scope for this file. They are kept separately for counsel.

The three findings that matter most:

1. The Change Date has a cliff. Read as written, any version released on or after 2029-06-10 would be MIT on the day it ships, and protection shrinks below two years for anything released after 2027-06-10 (finding L2).
2. The desktop app, which is the main distribution, ships no copy of the licence and shows it nowhere (finding C6).
3. The Additional Use Grant is written partly as prohibitions, and it says less than the README promises and less than the product allows (findings L3, L4 and C5).

## Sources

Each was fetched on 2026-10-01 and read directly.

- SPDX text: `https://raw.githubusercontent.com/spdx/license-list-data/main/text/BUSL-1.1.txt`
- SPDX template: `https://raw.githubusercontent.com/spdx/license-list-XML/main/src/BUSL-1.1.xml`
- MariaDB text: `https://mariadb.com/bsl11/`
- MariaDB FAQ: `https://mariadb.com/bsl-faq-adopting/`
- Other projects: Terraform (`hashicorp/terraform`, `main`, `LICENSE`), Sentry (`getsentry/sentry`, tag `23.1.0`, `LICENSE`), MaxScale (`mariadb-corporation/MaxScale`, branch `24.02`, `licenses/LICENSE2402.TXT`)
- GNU licence list, for the MIT (Expat) entry: `https://www.gnu.org/licenses/license-list.html`
- The published npm tarball `tandem-editor-0.28.0.tgz`
- Repository files at commit `9c89b02a`, and `LICENSE` at every release tag

The two sources of the governing text disagree in three places. Both readings are reported under T1 and T3.

## Text findings

Count: 3. Fixed: 0. All three fall under the rule that header and section differences are reported only.

The Terms body, from "The Licensor hereby grants" to "AND TITLE.", was compared word by word against the SPDX text after normalising whitespace and quote style. It is identical. Verified by reading.

### T1. The header line matches neither source

- Tag: text (reported, not fixed)
- Location: `LICENSE:1-2`
- What is wrong: the repository says `License text copyright (c) 2020 MariaDB Corporation Ab, All Rights Reserved.` SPDX says `License text copyright © 2017 MariaDB Corporation Ab, All Rights Reserved.` The MariaDB page says `License text copyright © 2024 MariaDB plc, All Rights Reserved.` and names `MariaDB plc` as the trademark owner. So there are three years and two company names. The repository's line is the same as Terraform's. Sentry's uses 2017 and MaxScale's uses `2023 MariaDB plc`. The title line `Business Source License 1.1` also sits first in SPDX and in Sentry's file, and under `Notice` here.
- Source: the SPDX text, line 3. The MariaDB page. Verified by reading.
- Proposed wording: none.

### T2. The closing permission paragraph and the Covenants of Licensor are missing

- Tag: text (reported, not fixed)
- Location: `LICENSE:68`, the end of the file
- What is wrong: both sources continue after "AND TITLE." with a paragraph beginning `MariaDB hereby grants you permission to use this License's text to license your works`, then a section `Covenants of Licensor` with four numbered covenants. The fourth is `Not to modify this License in any other way.` The repository file stops at "AND TITLE." Terraform's file stops in the same place. Sentry's file includes the paragraph and the covenants.
- Source: the SPDX text, final 23 lines. The MariaDB page. Verified by reading.
- Proposed wording: the closing permission paragraph and the Covenants section from the SPDX text, unchanged, appended after `TITLE.` Not applied.

### T3. The Notice heading has no notice under it, and the sources disagree about whether it should

- Tag: text (reported, not fixed)
- Location: `LICENSE:25-27`
- What is wrong: `Notice` is followed directly by `Business Source License 1.1`. The MariaDB page puts this under Notice: `The Business Source License (this document, or the "License") is not an Open Source license. However, the Licensed Work will eventually be made available under an Open Source License, as stated in this License.` Sentry and MaxScale carry that sentence. Terraform does not. SPDX has no Notice section in the licence text at all, and holds the same sentence in its `<notes>` field, outside the text.
- Source: the MariaDB page. The SPDX template, `<notes>`. Verified by reading.
- Proposed wording: the MariaDB sentence above, placed under `Notice`. Not applied.

## Consistency findings

Count: 8. Fixed: 4.

### C1. The reaper crate named a licence identifier that does not exist (fixed)

- Tag: consistency
- Location: `reaper/Cargo.toml:7`
- What is wrong: it said `license = "BSL-1.1"`. The SPDX identifier is `BUSL-1.1`, which `package.json:23`, `src-tauri/Cargo.toml:6` and `.claude-plugin/plugin.json:9` all use. `BSL-1.0` in SPDX is the Boost licence, so the short form points the wrong way.
- Source: the SPDX template, `licenseId="BUSL-1.1"`. Verified by reading.
- Edit made: changed to `license = "BUSL-1.1"`.

### C2. A code comment still described a 30-day evaluation ceiling (fixed)

- Tag: consistency
- Location: `src/shared/constants.ts:5`
- What is wrong: the comment said the trial was "under the 30-day BUSL eval ceiling". `LICENSE:14` has said 14 days since #1909.
- Source: `LICENSE:13-15`. Verified by reading.
- Edit made: the comment now says the trial length equals the evaluation period in the Additional Use Grant, and names the test that pins it.

### C3. A test comment said the licence and the gate disagree (fixed)

- Tag: consistency
- Location: `tests/cli/license.test.ts:60-62`
- What is wrong: the comment said the Additional Use Grant "says 30 days while the gate enforces 14". That stopped being true with #1909.
- Source: `LICENSE:13-15`. Verified by reading.
- Edit made: comment only. The assertion is unchanged.

### C4. ADR-040 left the fixed date out of the Change Date (fixed)

- Tag: consistency
- Location: `docs/decisions.md:1324`, and the Context paragraph at `docs/decisions.md:1314`
- What is wrong: section 5 says the Change Date is "calculated as two years after the public general availability release of each specific version". `LICENSE:20-22` says "The earlier of 2029-06-10 or two years after" that release. The Context paragraph says "v1.0 GA + 2 years", which was the wording in v0.11.0 through v0.14.1 and not since.
- Source: `LICENSE:20-22`. `git show v0.11.0:LICENSE`. Verified by reading.
- Edit made: a dated note at the end of section 5, in the ADR's own amendment style. The original sentences are left as they were.

### C5. The README and the explainer say the beta is free without the limit the licence puts on it (not fixed)

- Tag: consistency
- Location: `README.md:178`, `docs/licensing-explained.md:85-87`
- What is wrong: the README says "Tandem is free during the public beta — every pre-1.0 release, with no time limit and nothing to activate." The explainer says "Every pre-1.0 release is free to use, with no time limit". `LICENSE:9-11` grants that only for "Personal use and individual self-hosting". An organisation reading the README would think it is covered. `docs/licensing-terms.md:42-45` already says an organisation is outside the grant.
- Source: `LICENSE:9-11`. Verified by reading.
- Why not fixed: the fix narrows a public promise. The licensor may prefer to widen the grant to match the README instead, which is a Parameter change (see L6). That choice is his.
- Proposed wording, if the README moves: "Tandem is free for personal use during the public beta — every pre-1.0 release, with no time limit and nothing to activate." And in the explainer: "Every pre-1.0 release is free for personal use and individual self-hosting, with no time limit and nothing to activate".

### C6. The desktop app ships no copy of the licence (not fixed)

- Tag: consistency
- Location: `src-tauri/tauri.conf.json:59-68`
- What is wrong: `LICENSE:51-52` says "You must conspicuously display this License on each original or modified copy of the Licensed Work." The npm package does carry it: the published `tandem-editor-0.28.0.tgz` contains `package/LICENSE`. The plugin installs from the GitHub repository, which has `LICENSE` at its root (inferred from `.claude-plugin/marketplace.json`, not tested). The desktop bundle's `resources` map lists the server, channel, bridge and client bundles, `sample/`, `skills/`, `CHANGELOG.md` and `docs/workflows.md`, and no `LICENSE`. There is no `licenseFile` setting for the installers, and a search of `src/client` found no screen that shows the licence or links to it.
- Source: `LICENSE:51-52`. `src-tauri/tauri.conf.json:59-68`. Verified by reading the config. The built installers were not opened.
- Why not fixed: it is a build change, not a wording change. The `resources` list is mirrored by test stubs and by the release smoke checks, so it needs its own change with a build behind it.
- Proposed change: add `"../LICENSE": "LICENSE"` to `bundle.resources`, set `bundle.licenseFile` so the Windows installer shows it, and add a "License" link in Settings that opens the bundled file.

### C7. "Renew" and "no renewal" both appear (not fixed)

- Tag: consistency
- Location: `docs/licensing-explained.md:65`, `docs/licensing-operations.md:178`, `README.md:178`
- What is wrong: the explainer says "You're just not offered new releases until you renew" and the runbook says "until renewal". The README says "There is no subscription and no renewal." `LICENSE:16-17` says "A paid license is a one-time purchase and does not expire." The licence does not mention updates at all, so it cannot settle which of the two is right.
- Source: the three lines quoted. Verified by reading.
- Why not fixed: whether a second purchase to extend updates exists, and what it is called, is a sale term that has not been decided in any tracked file.
- Proposed wording, if no renewal product exists: "You're just not offered new releases after that."

### C8. Earlier releases shipped different terms from the ones the docs now describe (not fixed)

- Tag: consistency
- Location: `README.md:178`, `docs/licensing-explained.md:85-88`, `docs/licensing-terms.md:85-86`, `docs/decisions.md:1324`
- What is wrong: all four say every pre-1.0 release is free with no time limit, and the explainer adds that the grant "says so in as many words". That is true of the current file. It is not what each release's own file said:
  - v0.1.0 to v0.10.x shipped the MIT licence.
  - v0.11.0 to v0.14.1 shipped BUSL-1.1 with "Personal use and individual self-hosting are permitted; commercial hosting or resale of the Licensed Work is not."
  - v0.14.2 to the last v0.25 release shipped "solely for evaluation purposes for up to 30 days; continued or production use requires a paid license", with no exception for the beta.
  - v0.26.0 onwards ship the current text.
- Source: `git show <tag>:LICENSE` for each tag. `LICENSE:46-49`, "This License applies separately for each version". The MariaDB FAQ: "the licensor's edits would be forward-looking only and would not apply retroactively." Verified by reading.
- Why not fixed: the docs agree with the current `LICENSE`, and the files in old tags are history and cannot be edited.
- Proposed wording, once that is answered: a sentence in the README saying which releases shipped which terms, and that the current grant is meant to cover all of them.

## Findings that need a licensor decision

Count: 9. None applied. Each changes a Parameter in `LICENSE`.

Any new Additional Use Grant wording has to keep the phrases "one-time purchase" and "before version 1.0.0", and every day count in a paragraph about the trial or evaluation has to be 14, or `tests/docs/trial-length-claims.test.ts` fails.

### L1. Licensed Work names only the npm package

- Tag: licensor decision
- Location: `LICENSE:7-8`
- What is wrong: "Tandem (tandem-editor npm package)." The desktop app, the `tandem-reaper` binary bundled with it (`src-tauri/tauri.conf.json:44-47`), the Claude Code plugin and the source repository are not named. Issue #1908 already tracks this.
- Source: `LICENSE:7`. Issue #1908. Terraform's Parameter, for comparison: "Terraform Version 1.6.0 or later."
- Drafted wording:

  ```
  Licensed Work:        Tandem: the source code in the repository at
                        https://github.com/bloknayrb/tandem, and every
                        artefact built from it and distributed by the
                        Licensor, including the tandem-editor npm package,
                        the Tandem desktop application and the Tandem
                        plugin for Claude Code.
                        The Licensed Work is (c) 2026 Bryan Kolb.
  ```

  "The source code in the repository" also takes in third-party fonts and dependencies, which carry their own licences. If this wording is used, add "excluding third-party components, which remain under their own licences".

### L2. The Change Date has a cliff at 2029-06-10, and "general availability" has no meaning for a beta

- Tag: licensor decision
- Location: `LICENSE:20-22`
- What is wrong: "The earlier of 2029-06-10 or two years after the public general availability release of this specific version". Read as written, this does three things that ADR-040 section 5 does not intend. A version released after 2027-06-10 gets less than two years. A version released on or after 2029-06-10 has a Change Date that has already passed, so it is MIT on release. And a 0.x release is, by the licence's own words at `LICENSE:10-11`, "the public beta", so it is unclear whether it ever has a "general availability release" for the two years to run from. ADR-040 says the per-version clock is there for "ensuring commercial protection remains current across subsequent releases". Issue #1908 says the fixed date "never binds" if v1.0 lands in 2027. That is only true for versions released before 2027-06-10.
- Source: `LICENSE:20-22`. `docs/decisions.md:1324`. The BUSL Terms also convert each version at "the fourth anniversary of the first publicly available distribution of a specific version", whichever is first, so no wording can go past four years. The MariaDB FAQ recommends four years for most software. Terraform uses "Four years from the date the Licensed Work is published." Sentry and MaxScale use a plain date per release. Inferred from the text; the dates were worked out by hand.
- Drafted wording, option A, per-version clock with no cap:

  ```
  Change Date:          For each version of the Licensed Work, the second
                        anniversary of the date on which that version was
                        first made publicly available.
  ```

- Option B, keep a fixed date for the beta line only:

  ```
  Change Date:          For each version released before version 1.0.0,
                        2029-06-10. For version 1.0.0 and each later
                        version, the second anniversary of the date on
                        which that version was first made publicly
                        available.
  ```

- Option C, a plain date that is updated in `LICENSE` at each release, as Sentry and MaxScale do. This needs a release step and a record of which version got which date. `docs/licensing-terms.md:148-151` already notes that per-version conversion needs a tracking artefact.

  Two things to weigh. Option A starts each beta release's clock on the day it shipped, so a beta released in mid-2026 would convert in mid-2028, earlier than the 2029-06-10 that option B keeps. And whichever option is chosen applies to releases made after the change; versions already shipped keep the wording they shipped with.

### L3. Two sentences of the Additional Use Grant are prohibitions, not grants

- Tag: licensor decision
- Location: `LICENSE:15-16`, `LICENSE:19`
- What is wrong: "continued use after that requires a paid license from the Licensor" and "Commercial hosting or resale of the Licensed Work is not permitted." The Parameter is called an Additional Use *Grant*, and the other projects read write their limits as conditions on the extra grant, not as free-standing prohibitions: Terraform, "You may make production use of the Licensed Work, provided Your use does not include"; Sentry, "You may make use of the Licensed Work, provided that you do not". The drafting choice is the licensor's.
- Source: Terraform's and Sentry's `LICENSE` files. `LICENSE:9-19`. Verified by reading.
- Drafted wording. It is not a pure restyle. It differs from today's text in four ways, each a decision:
  - "a paid license" becomes "a license key issued by the Licensor", which also covers free grandfathered keys (wider; see L5).
  - The 14 days run from the first launch of any 1.0.0-or-later version, where today's text can be read as restarting with each version (narrower; see L4).
  - "Commercial hosting" becomes offering the work to third parties as a hosted service, paid or not (narrower).
  - "Resale" becomes "selling" (narrower).

  ```
  Additional Use Grant: You may make production use of any version of the
                        Licensed Work released before version 1.0.0 (the
                        public beta), without charge and without a time
                        limit, provided that the use is personal use or
                        individual self-hosting.

                        You may make production use of version 1.0.0 or
                        any later version, for personal use or individual
                        self-hosting, (a) for evaluation, for up to 14 days
                        from the first launch of any such version on a
                        given device, and (b) after that, for as long as
                        you hold a license key issued by the Licensor. A
                        purchased license key is a one-time purchase and
                        does not expire.

                        This Additional Use Grant does not extend to
                        offering the Licensed Work to third parties as a
                        hosted service, or to selling the Licensed Work.
  ```

  The draft folds in L4 and L5. L6 would add definitions under it.

### L4. The evaluation clock in the licence is not the clock in the product

- Tag: licensor decision
- Location: `LICENSE:13-16`
- What is wrong: "for evaluation for up to 14 days from first launch on a given device; continued use after that requires a paid license". Three points differ from `src/server/license/`.
  - The licence applies to each version separately (`LICENSE:47-49`), so "first launch" can be read as starting again with every new version. The product keeps one `trial.json` across versions.
  - The product's clock belongs to an app-data directory, not a device. `docs/licensing-terms.md:79-81` says "Deleting `trial.json` restarts it."
  - After day 14 the product keeps working in restricted mode. `docs/licensing-explained.md:101-103` says "you can still open them, read them, export them". The licence says continued use needs a paid licence, so a restricted-mode user of a production copy is outside the grant while using the product as designed.
- Source: the lines quoted. `src/server/license/license-state.ts:192`. The documents were read. That one `trial.json` carries across versions is inferred from the code, not tested.
- Drafted wording: clause (a) of the L3 draft is meant to make the clock run once. To remove doubt, end it with "counted once across all such versions". For restricted mode, add a sentence listing what stays allowed after the evaluation period without a license key. `docs/licensing-explained.md:101-103` is the list the product implements; the sentence should match it exactly.

### L5. "Paid license" leaves out the free licences the README promises, and "does not expire" has no stated scope

- Tag: licensor decision
- Location: `LICENSE:16-17`
- What is wrong: continued use "requires a paid license". `README.md:178` says "Beta users are grandfathered with a free license". A grandfathered user holds a licence that is not paid. Separately, "A paid license is a one-time purchase and does not expire" does not say which versions it covers. ADR-040 section 3 intends an update window and "paid major-version upgrades" (`docs/decisions.md:1320`), and `docs/licensing-explained.md:64` says new versions come "For one year from purchase."
- Source: the lines quoted. Verified by reading.
- Drafted wording: "a license key issued by the Licensor", as in the L3 draft, covers both kinds. For scope, add: "A license key covers every version of the Licensed Work first made publicly available before the end of the update period stated in the key, and continues to cover those versions after that period ends." This sentence narrows today's text, which sets no version limit. It also has to match the product: `README.md:178` says a license runs forever and only updates stop, so check that a key would never be asked to run a version this sentence excludes.

### L6. "Personal use", "individual self-hosting" and "commercial hosting" are not defined

- Tag: licensor decision
- Location: `LICENSE:9`, `LICENSE:13-14`, `LICENSE:19`
- What is wrong: the grant turns on three terms it does not define. The open cases are a freelancer or employee using Tandem on paid work, a person running it on their own machine for an employer, and an organisation running it for its staff. `docs/licensing-terms.md:42-45` reads the grant as excluding organisations. `docs/decisions.md:1316` names the audience as "individuals (writers, editors, researchers, developers) on their own documents", and many of those people write for a living. Terraform and Sentry both define their key terms inside the Parameter.
- Source: the lines quoted. Verified by reading.
- Drafted wording, to follow the grant:

  ```
                        "Personal use" means use by one natural person on
                        that person's own documents, including documents
                        made in the course of that person's own work.
                        "Individual self-hosting" means running the
                        Licensed Work on a device that person controls,
                        for that person's use only. Use by or on behalf of
                        a company or other organisation is not personal
                        use.
  ```

  Two decisions sit in this draft. The clause "including documents made in the course of that person's own work" decides whether paid work by one person counts. The last sentence decides whether an employee using Tandem for an employer counts; as drafted it does not, which matches `docs/licensing-terms.md:42-45`.

### L7. The Change License is named loosely

- Tag: licensor decision
- Location: `LICENSE:23`
- What is wrong: "MIT License". The GNU list says of the Expat licence: "Some people call this license 'the MIT License,' but that term is misleading, since MIT has used many licenses". The first covenant requires a Change License compatible with GPL 2.0 or later. The GNU list calls Expat "a lax, permissive non-copyleft free software license, compatible with the GNU GPL".
- Source: the GNU licence list. The SPDX text, covenant 1. Verified by reading.
- Drafted wording: `Change License:       MIT License (SPDX identifier: MIT)`

### L8. The Licensor is an individual, and ADR-040 plans a company

- Tag: licensor decision
- Location: `LICENSE:6`, `LICENSE:8`
- What is wrong: "Licensor: Bryan Kolb". `docs/decisions.md:1326` says "LLC + accountant before taking money." If the company sells licences, either it becomes the Licensor or it sells on the individual's behalf. `LICENSE:43-44` allows purchase from "the Licensor, its affiliated entities, or authorized resellers". Other names in the manifests differ too: `package.json:9` says `"author": "bloknayrb"`, and `.claude-plugin/plugin.json:5-7` says the author is "Tandem".
- Source: the lines quoted. Verified by reading.
- Drafted wording, only if the company is to hold the rights: `Licensor:             <company legal name>`, with the copyright line changed to match.

### L9. There is no line saying how to get a different licence

- Tag: licensor decision
- Location: `LICENSE:23-25`
- What is wrong: `LICENSE:41-44` tells a user outside the grant to "purchase a commercial license from the Licensor". The file gives no contact. Terraform, Sentry and MaxScale each add a line after the Parameters, for example Sentry's "For information about alternative licensing arrangements for the Software, please visit:". `docs/licensing-terms.md:59-61` says organisational licences cannot be sold yet, so the line would lead to a conversation and not a checkout.
- Source: the three project files. Verified by reading.
- Drafted wording, after `Change License`:

  ```
  For information about alternative licensing arrangements for the
  Licensed Work, please contact support@tandem.ink.
  ```

## What was not checked

- The built desktop installers were not opened. C6 rests on the bundle configuration.
- The plugin install path was not run.
- MariaDB's page was read as fetched HTML with the tags removed. Its numbered list of covenants came through with the numbering lost, so the covenant text quoted here is from SPDX.
- CockroachDB's licence was tried as a fourth comparison and the address returned 404.
- `CHANGELOG.md`, `docs/roadmap-history.md` and `docs/superpowers/specs/` were treated as history and not searched for restatements.
- Third-party notices for bundled dependencies and fonts were not reviewed.
