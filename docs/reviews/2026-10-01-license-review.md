# Licence review, 2026-10-01

This is an independent review of the repository `LICENSE` (Business Source License 1.1) and of every document, string and manifest that restates its terms. It was done by an agent, not by a lawyer. Nothing here says the licence is legally sufficient, enforceable or compliant. It is a cleaner draft plus a list of decisions.

Revised 2026-10-08 after a second review by the `license-reviewer` agent (`.claude/agents/license-reviewer.md`, which landed the day after this file was first written). That review found several drafted Parameters would change more than their findings said, and a set of restatements the first pass missed. The findings now carry that spec's tags, including `build` and `enforcement`.

Every `LICENSE:N` citation refers to the file as reviewed, at commit 585c069f. #2164 later removed lines 18 and 19 (a blank line and the resale sentence), so in the current file subtract two from any citation of line 20 or later.

## Summary

The Terms section of `LICENSE` matches the governing text word for word. The differences are all in the parts around it: the header line, a missing closing paragraph and the missing Covenants section, and a Notice heading with nothing under it. None of those were changed: adding or removing sections of the licence file is the licensor's call.

Eight restating places disagreed with `LICENSE` and were fixed. The other consistency and build findings are reported without a fix, each with the reason. Two gaps between `LICENSE` and what the product enforces are recorded under L4 and L5.

Nine findings need a decision from the licensor, because they change a Parameter. Drafted wording is given for each. None has been applied, except that #2164 removed the resale sentence (L3). Four legal questions are left to the licensor; they are listed under Questions left to the licensor. No counsel is being consulted (2026-10-09).

Legal judgements are out of scope for this file. The licensor makes them.

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
- Repository files at commit `9c89b02a`, and `LICENSE` at every release tag. Line references into `docs/decisions.md` were updated on 2026-10-08 to this branch's head, where they sit five lines lower. Every reference added on 2026-10-08 is to this branch's head.
- For the 2026-10-08 revision: `src-tauri/Cargo.toml` at each release tag, the `License` field of the desktop `.rpm` release assets, and the npm version list for `tandem-editor`

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

## Consistency and build findings

Count: 11. Fixed: 8. They are C1 to C4, C9 to C11, and one carrier of C7. Enforcement gaps are recorded under L4 and L5.

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
- Location: `docs/decisions.md:1329`, and the Context paragraph at `docs/decisions.md:1319`
- What is wrong: section 5 says the Change Date is "calculated as two years after the public general availability release of each specific version". `LICENSE:20-22` says "The earlier of 2029-06-10 or two years after" that release. The Context paragraph says "v1.0 GA + 2 years", which was the wording in v0.11.0 through v0.14.1 and not since.
- Source: `LICENSE:20-22`. `git show v0.11.0:LICENSE`. Verified by reading.
- Edit made: a dated note at the end of section 5, in the ADR's own amendment style, and on 2026-10-08 a pointer to it in the ADR's Status line. The original sentences are left as they were, because the gap is one of meaning that the ADR's readers should see recorded. C9, by contrast, corrects a single wrong word in place.

### C5. The README and the explainer say the beta is free without the limit the licence puts on it (not fixed)

- Tag: consistency
- Location: `README.md:178`, `docs/licensing-explained.md:85-87`, `docs/positioning.md:7`, `docs/positioning.md:106`, `docs/security.md:193`, `docs/roadmap.md:54`, `docs/decisions.md:1325`
- What is wrong: the README says "Tandem is free during the public beta — every pre-1.0 release, with no time limit and nothing to activate." The explainer says "Every pre-1.0 release is free to use, with no time limit". `docs/positioning.md` says "free during public beta" (line 7) and "free during the public beta" (line 106), `docs/security.md:193` says "during the public beta Tandem is free", and ADR-040 §3 says "Free during public beta." (`docs/roadmap.md:54` repeats it.) `LICENSE:9-11` grants that only for "Personal use and individual self-hosting". An organisation reading the README would think it is covered. `docs/licensing-terms.md:42-45` already says an organisation is outside the grant.
- Source: `LICENSE:9-11`. Verified by reading.
- Why not fixed: the README, the explainer and `docs/positioning.md` are public promises in the sense of the agent spec, and the fix narrows them. The licensor may prefer to widen the grant to match the README instead, which is a Parameter change (see L6). That choice is his. The ADR, roadmap and security carriers are not promises, but they restate the same choice, so they are left to move with it. The unpublished draft terms were fixed under C11.
- Neither option makes the claim true for v0.14.2 to v0.25, whose own `LICENSE` granted only a 30-day evaluation. Widening the current grant does not reach shipped versions either (C8). The proposed wording below therefore depends on the answer counsel gives on earlier releases.
- Proposed wording, if the README moves: "Tandem is free for personal use and individual self-hosting during the public beta, with no time limit and nothing to activate. Releases before v0.11.0 were published under the MIT License, which allows any use." And in the explainer: "Every pre-1.0 release is free for personal use and individual self-hosting, with no time limit and nothing to activate". The first draft of this sentence said "free for personal use … every pre-1.0 release", which would have misdescribed the MIT releases and dropped "individual self-hosting".

### C6. The desktop app ships no copy of the licence (not fixed)

- Tag: build
- Location: `src-tauri/tauri.conf.json:59-68`
- What is wrong: `LICENSE:51-52` says "You must conspicuously display this License on each original or modified copy of the Licensed Work." The npm package does carry it: the published `tandem-editor-0.28.0.tgz` contains `package/LICENSE`. The plugin installs from the GitHub repository, which has `LICENSE` at its root (inferred from `.claude-plugin/marketplace.json`, not tested). The desktop bundle's `resources` map lists the server, channel, bridge and client bundles, `sample/`, `skills/`, `CHANGELOG.md` and `docs/workflows.md`, and no `LICENSE`. There is no `licenseFile` setting for the installers, and a search of `src/client` found no screen that shows the licence or links to it.
- Source: `LICENSE:51-52`. `src-tauri/tauri.conf.json:59-68`. Verified by reading the config. The built installers were not opened.
- Why not fixed: it is a build change, not a wording change. The `resources` list is mirrored by test stubs and by the release smoke checks, so it needs its own change with a build behind it.
- Proposed change: add `"../LICENSE": "LICENSE"` to `bundle.resources`, set `bundle.licenseFile` so the Windows installer shows it, and add a "License" link in Settings that opens the bundled file. The Tauri config schema says only that `licenseFile` is "the path to the license file to be included in the appropriate bundles"; whether an installer then shows a licence page is inferred, not tested.
- What the `.rpm` installers do carry is an identifier, not the text. `bundle.license` is unset, and the Tauri schema says it defaults to the `license` field of `src-tauri/Cargo.toml`, so the `.rpm` metadata says `BUSL-1.1` from v0.15.0. An identifier in package metadata does not display the License. The v0.28.0 `.deb` has no `License` field and installs no licence or copyright file. The Windows and macOS installers were not checked. See C8 for the releases where the `.rpm` said `MIT`.

### C7. "Renew" and "no renewal" both appear (not fixed)

- Tag: consistency
- Location: `docs/licensing-explained.md:65`, `docs/licensing-operations.md:178`, `src/client/components/settings-tabs/SettingsLicenseTab.svelte:90`, `src/server/license/license-state.ts:353`, `docs/licensing-operations.md:264` ("entitlement possibly renewed"), `README.md:178`; fixed at `docs/positioning.md:106`
- What is wrong: the explainer says "You're just not offered new releases until you renew" and the runbook says "until renewal". The Settings licence tab links "Renew to receive updates again", and a code comment says users "won't receive new updates until they renew". The README says "There is no subscription and no renewal." `LICENSE:16-17` says "A paid license is a one-time purchase and does not expire." The licence does not mention updates at all, so it cannot settle which of the two is right.
- Source: the lines quoted. Verified by reading.
- Why not fixed: whether a second purchase to extend updates exists, and what it is called, is a sale term that has not been decided in any tracked file. The Settings link is in-app copy, so either side may move.
- Fixed: `docs/positioning.md:106` said updates are served "within the license's renewal window". It now says "update window", the name the rest of the docs use, which is right whichever way the renewal question goes.
- Proposed wording, if no renewal product exists: "You're just not offered new releases after that." For the Settings link, "Buy a new license to receive updates again" or, if a renewal product exists, keep "Renew".

### C8. Earlier releases shipped different terms from the ones the docs now describe (not fixed)

- Tag: consistency
- Location: `README.md:178`, `docs/licensing-explained.md:85-88`, `docs/licensing-terms.md:85-87`, `docs/decisions.md:1329`
- What is wrong: all four say every pre-1.0 release is free with no time limit, and the explainer adds that the grant "says so in as many words". That is true of the current file. It is not what each release's own file said:
  - v0.1.0 to v0.10.x shipped the MIT licence. On npm that range is 0.1.0 to 0.9.1; no 0.10 version was published there.
  - v0.11.0 to v0.14.1 shipped BUSL-1.1 with "Personal use and individual self-hosting are permitted; commercial hosting or resale of the Licensed Work is not."
  - v0.14.2 to the last v0.25 release shipped "solely for evaluation purposes for up to 30 days; continued or production use requires a paid license", with no exception for the beta.
  - v0.26.0 onwards ship the current text.
- The desktop app has its own history, which the four eras above do not describe:
  - `src-tauri/Cargo.toml` said `license = "MIT"` from v0.11.0 through v0.14.3, while the repository `LICENSE` was already BUSL-1.1. Through the `bundle.license` default (C6), the desktop `.rpm` installers of those releases declare `License: MIT`. From v0.15.0 they declare `BUSL-1.1`.
  - No desktop build has shipped the licence text (C6), and Licensed Work names only the npm package (L1).
- `CHANGELOG.md` has no entry for either relicensing (v0.11.0, v0.14.2). The v0.26.0 entry for #1909 says the README now states the licensing terms. Reported as history, not edited.
- Source: `git show <tag>:LICENSE` and `git show <tag>:src-tauri/Cargo.toml` for each tag. The `.rpm` release assets' `License` header. `npm view tandem-editor versions`. `LICENSE:46-49`, "This License applies separately for each version". The MariaDB FAQ: "the licensor's edits would be forward-looking only and would not apply retroactively." Verified by reading.
- Why not fixed: the docs agree with the current `LICENSE`, and the files in old tags are history and cannot be edited. Which terms govern the earlier desktop releases is left to the licensor.
- Proposed wording, once the licensor has decided which terms govern the earlier releases: a sentence in the README saying which releases shipped which terms, and that the current grant is meant to cover all of them.

### C9. ADR-040 calls BUSL's four-year limit a floor (fixed)

- Tag: consistency
- Location: `docs/decisions.md:1319`
- What is wrong: the Context paragraph said the work converts "at the earlier of the Change Date … **and** the BUSL per-version 4-year floor". A limit that wins whenever it comes first is a cap, not a floor.
- Source: the BUSL Terms, "the fourth anniversary of the first publicly available distribution of a specific version … whichever comes first". Verified by reading.
- Edit made: "floor" changed to "cap".

### C10. The security doc called the beta "unlicensed" (fixed)

- Tag: consistency
- Location: `docs/security.md:193`
- What is wrong: "during the public beta Tandem is free and unlicensed". Every beta release since v0.11.0 ships under BUSL-1.1, and ADR-040 uses "unlicensed" for the restricted state of a v1.0 install with no key.
- Source: `LICENSE`. `docs/decisions.md:1354`. Verified by reading.
- Edit made: "free and unlicensed" became "free and needs no license key". The sentence still says "free" without the personal-use limit; that half is C5.

### C11. The draft terms say the beta is free with no personal-use limit (fixed)

- Tag: consistency
- Location: `docs/licensing-terms.md:85-87`
- What is wrong: "every pre-1.0 (beta) version stays free with no time limit". The file is marked "not yet published", so it is not a public promise, and `LICENSE:9-11` limits the beta grant to personal use and individual self-hosting.
- Source: `LICENSE:9-11`. Verified by reading.
- Edit made: now says the beta "stays free for personal use and individual self-hosting with no time limit". That describes the current grant. What earlier releases' own files said is C8, and the sentence makes no claim about them. If the licensor widens the grant under C5 instead, revert this edit. `docs/decisions.md:1329` makes the same statement, but inside §5's description of a grant already scoped to personal use and self-hosting, so it was left as it is.

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
                        artifact built from it and distributed by the
                        Licensor, including the tandem-editor npm package,
                        the Tandem desktop application and the Tandem
                        plugin for Claude Code, excluding third-party
                        components, which remain under their own licenses.
                        Each version of the Licensed Work is a release
                        published on that repository's Releases page.
                        The Licensed Work is (c) 2026 Bryan Kolb.
  ```

  The third-party exclusion is not optional. The server, channel, monitor and stdio-bridge bundles inline their dependencies (`tsup.config.ts:43`, `noExternal: [/.*/]`; the CLI bundle deliberately does not, `:108-114`), and the desktop app ships a Node runtime as `binaries/node-sidecar` (`src-tauri/tauri.conf.json:44-47`). So third-party code is inside the distributed artifacts under today's wording as well.

  The version sentence is there because once the repository is the Licensed Work, every pushed commit is "publicly available", which would leave "version" unclear for L2 option A and for the BUSL four-year clause. It ties a version to a published release rather than to a git tag, because some tags (v0.5.0.1, v0.5.1, v0.6.4) have no release. It does not settle source published between releases, which on this wording is Licensed Work that belongs to no version. These readings are inferred, not settled.

  One named artifact is distributed exactly that way. The Claude Code plugin's marketplace entry (`.claude-plugin/marketplace.json`) points at `bloknayrb/tandem` with no `ref`, so the plugin installs from the default branch, not from a release (inferred from the entry, not tested; `skills/tandem/SKILL.md` has changed on `master` since v0.28.0). Under this sentence that copy belongs to no version, so no Additional Use Grant or Change Date attaches to it. This is a build item: pin the marketplace entry's `ref` to the release tag. The entry is not changed here.

### L2. The Change Date has a cliff at 2029-06-10, and "general availability" has no meaning for a beta

- Tag: licensor decision
- Location: `LICENSE:20-22`
- What is wrong: "The earlier of 2029-06-10 or two years after the public general availability release of this specific version". Read as written, this does three things that ADR-040 section 5 does not intend. A version released after 2027-06-10 gets less than two years. A version released on or after 2029-06-10 has a Change Date that has already passed, so it is MIT on release. And a 0.x release is, by the licence's own words at `LICENSE:10-11`, "the public beta", so it is unclear whether it ever has a "general availability release" for the two years to run from. ADR-040 says the per-version clock is there for "ensuring commercial protection remains current across subsequent releases". Issue #1908 says the fixed date "never binds" if v1.0 lands in 2027. That is only true for versions released before 2027-06-10.
- Source: `LICENSE:20-22`. `docs/decisions.md:1329`. The BUSL Terms also convert each version at "the fourth anniversary of the first publicly available distribution of a specific version", whichever is first, so no wording can go past four years. The MariaDB FAQ recommends four years for most software. Terraform uses "Four years from the date the Licensed Work is published." Sentry and MaxScale use a plain date per release. Inferred from the text; the dates were worked out by hand.
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

- Option C, a plain date that is updated in `LICENSE` at each release, as Sentry and MaxScale do. This needs a release step and a record of which version got which date. `docs/licensing-terms.md:149-152` already notes that per-version conversion needs a tracking artefact.

  Two things to weigh. Option A starts each beta release's clock on the day it shipped, so a beta released in mid-2026 would convert in mid-2028, earlier than the 2029-06-10 that option B keeps. That comparison assumes a beta has no "general availability release" under today's text and so falls back to the fixed date. If a beta's own release does count as general availability, today's text already converts it in mid-2028, and option A changes nothing for it. And whichever option is chosen applies to releases made after the change; versions already shipped keep the wording they shipped with.

### L3. Two sentences of the Additional Use Grant are prohibitions, not grants

- Tag: licensor decision
- Location: `LICENSE:15-16`, `LICENSE:19`
- What is wrong: "continued use after that requires a paid license from the Licensor" and "Commercial hosting or resale of the Licensed Work is not permitted." The constraint that governs this is the second Covenant of Licensor: the Additional Use Grant must be "an additional grant of rights to use that does not impose any additional restriction on the right granted in this License". The first sentence may restrict the base grant's unlimited non-production use, and the second may restrict its right to "redistribute". Whether either does is left to the licensor. #2164 removed the second sentence on this reading; the first remains. The other projects read write their limits as conditions on the extra grant, not as free-standing prohibitions: Terraform, "You may make production use of the Licensed Work, provided Your use does not include"; Sentry, "You may make use of the Licensed Work, provided that you do not". The drafting choice is the licensor's.
- Source: the SPDX text, Covenants of Licensor, item 2 (lines 65-67). Terraform's and Sentry's `LICENSE` files. `LICENSE:9-19`. Verified by reading.
- Drafted wording. It is not a pure restyle. It differs from today's text in seven ways, each a decision. Two of them, transfer and revocation, are left as bracketed choices in the draft, because no wording settles them without deciding them:
  - "a paid license" becomes "a license key the Licensor issued", which also covers free grandfathered keys (wider; see L5). If the Licensor later becomes a company (L8), keys issued earlier by the individual are not keys "the Licensor issued", so the wording would need to name both.
  - Transfer. "Issued to you" would keep a copied key out, but it would also keep out a key that was resold, given away, or bought by an employer for staff. Transfer is undefined today (`docs/licensing-terms.md:32`) and is on that file's list of open legal questions. "Issued by the Licensor" alone, as the 2026-10-01 draft said, lets a copied key in. The draft brackets three choices.
  - Paid use moves out of the separate commercial licence the Terms refer to ("purchase a commercial license from the Licensor") and into the Additional Use Grant itself. Whether the terms of sale could then still limit devices or transfer, or whether those limits would have to be written into the grant or the key, is left to the licensor. This is the largest change of the seven.
  - Revocation. Today's text has no revocation clause, so a key once issued runs, and the product agrees: a refund ends only the update entitlement, the issuance Worker's comment calls the run-license "perpetual by design" (`infra/license-issuance-worker/src/worker.ts:446-479`), and `docs/licensing-terms.md:28` says a key runs "including after a refund". The draft brackets a clause for the case where the licensor wants a key to be endable. It needs stated grounds, notice, and a fixed version of the terms, or it is an unconditional power to end a key that "does not expire"; a licensee cannot see a revocation offline. The terms of sale cannot supply grounds for grandfathered keys, which involve no sale. And "revoked" already means something narrower in this project: on a refund the issuance Worker writes `status: "revoked"`, and the update Worker refuses with reason `revoked` (`infra/license-update-worker/src/worker.ts:152`), while the key keeps running. If a revocation clause is adopted, that label has to be renamed (for example to `refunded`) or defined in the terms of sale. That is an enforcement item; the code is not edited here.
  - The 14 days run once, from the first launch of any 1.0.0-or-later version, where today's text can be read as restarting with each version (narrower; see L4).
  - "Commercial hosting" becomes offering the work to third parties as a hosted service, paid or not (narrower).
  - "Resale … is not permitted" becomes "This Additional Use Grant does not extend to … selling". As an exclusion from the extra grant, it no longer even claims to limit the base grant's right to redistribute copies, so on copies it is wider, not narrower. On hosting, it is narrower.

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
                        given device, counted once across all such
                        versions, and (b) after that, for as long as you
                        hold a license key the Licensor issued
                        [to you | for your use, or that was transferred to
                        you as the Licensor's terms of sale allow | (no
                        words)]
                        [, unless the Licensor has ended your right to use
                        it, by notice to you, on a ground stated in the
                        terms of sale in effect when the key was issued].
                        A license key the Licensor issues in return for
                        payment is a one-time purchase and does not
                        expire.

                        This Additional Use Grant does not extend to
                        offering the Licensed Work to third parties as a
                        hosted service, or to selling the Licensed Work.
  ```

  The 2026-10-01 draft said "A purchased license key". "Issues in return for payment" names who issues the key, because checkout runs through a merchant of record (`docs/decisions.md:1331`) and `LICENSE:43-44` treats the Licensor and its resellers as different sellers. If the revocation bracket is adopted, "does not expire" and the revocation clause sit side by side: a key does not lapse with time, but it can be ended on the stated grounds.

  The draft folds in L4's clock and L5's wording. It does not add L4's restricted-mode sentence, and it takes L5's first option (no version scope in `LICENSE`) by leaving the scope out. L6 would add definitions under it. It keeps the phrases "one-time purchase" and "before version 1.0.0" and only 14-day counts, so `tests/docs/trial-length-claims.test.ts` still passes.

### L4. The evaluation clock in the licence is not the clock in the product

- Tag: enforcement (the clock) and licensor decision (the wording)
- Location: `LICENSE:13-16`
- What is wrong: "for evaluation for up to 14 days from first launch on a given device; continued use after that requires a paid license". Three points differ from `src/server/license/`.
  - The licence applies to each version separately (`LICENSE:47-49`), so "first launch" can be read as starting again with every new version. The product keeps one `trial.json` across versions.
  - The product's clock belongs to an app-data directory, not a device. `docs/licensing-terms.md:79-81` says "Deleting `trial.json` restarts it."
  - After day 14 the product keeps working in restricted mode. The licence says continued use needs a paid licence, so a restricted-mode user of a production copy is outside the grant while using the product as designed. Three strings in the build already promise that use, unreachable today only because `LICENSE_GATE_ENABLED` is false: `src/client/components/LicenseWall.svelte:98-100` ("continue in read-only mode … reading, exporting, and chatting with Claude"), `src/server/mcp/license-gate.ts:31` ("Reading, opening and exporting still work") and `src/cli/license.ts:67`.
- What restricted mode is has itself moved. `docs/licensing-explained.md:101-103` and `src/server/license/connection-gate.ts:6-17` describe the gate as merged: documents read-only, chat open. ADR-040's accepted 2026-08-18 amendment (#1346, `docs/decisions.md:1354-1356`) inverts that: unlicensed means a fully editable editor with no AI at all. Its implementation is #1521, still open.
- Source: the lines quoted. `src/server/license/license-state.ts:192`. The documents were read. That one `trial.json` carries across versions is inferred from the code, not tested.
- The second point, a clock in a deletable file, is a deliberate soft gate (ADR-040 §3, `docs/licensing-terms.md:79-81`), and neither fix below addresses it. The two fixes are for the third point, restricted mode. Either closes it:
  - Change the product so nothing runs past day 14 without a key. That contradicts ADR-040's amendment and the three strings above.
  - Grant restricted mode in `LICENSE`. Clause (a) of the L3 draft already makes the clock run once ("counted once across all such versions"). Then add a sentence listing what stays allowed after the evaluation period without a license key. Key that list to the #1346 design, not to the explainer, which describes the gate that is being replaced. Be aware that such a sentence is a perpetual, free grant of production use for v1.0 and later, which is a larger Parameter decision than closing a wording gap.

### L5. "Paid license" leaves out the free licences the README promises, and "does not expire" has no stated scope

- Tag: licensor decision (the wording) and enforcement (the version scope)
- Location: `LICENSE:16-17`
- What is wrong: continued use "requires a paid license". `README.md:178` says "Beta users are grandfathered with a free license". A grandfathered user holds a licence that is not paid. Separately, "A paid license is a one-time purchase and does not expire" does not say which versions it covers. ADR-040 section 3 intends an update window and "paid major-version upgrades" (`docs/decisions.md:1325`), and `docs/licensing-explained.md:64` says new versions come "For one year from purchase."
- Source: the lines quoted. Verified by reading.
- Drafted wording: "a license key the Licensor issued to you", as in the L3 draft, covers both kinds.
- The version scope is where licence and product would part. A first draft added: "A license key covers every version of the Licensed Work first made publicly available before the end of the update period stated in the key, and continues to cover those versions after that period ends." The product would not honour that line:
  - The run gate checks only the key's signature and schema version, never a release date (`src/server/license/license-state.ts:160-174`).
  - There is one public build on GitHub Releases, and the only gated surface is the update endpoint (`docs/decisions.md:1331`, `:1343`). Distribution through npm is not gated either, although the npm CLI's server does enforce license-to-run.
  - So a buyer whose update period has ended can install a newer build by hand, and the product reports `licensed` for a version this sentence says the key does not cover.
  - Grandfathered keys carry no update period at all (`updateWindowEnd: null` at `infra/license-issuance-worker/src/worker.ts:374`, signed as `expiresAt` at `:280`; `docs/licensing-operations.md:76`), so "the update period stated in the key" is undefined for them.
- Two fixes:
  - Leave the version scope out of `LICENSE`, and let the update window stay a property of the update service. That matches the product as built. Under this option a key licenses every later version, new major versions included, so ADR-040's paid major-version upgrades would rest on the update service alone, which a hand install gets past.
  - Keep the sentence, add "If a key states no update period, it covers every version.", and make the run gate compare the running version's release date against the key's window. That second half is an enforcement change and is not drafted here.

### L6. "Personal use", "individual self-hosting" and "commercial hosting" are not defined

- Tag: licensor decision
- Location: `LICENSE:9`, `LICENSE:13-14`, `LICENSE:19`
- What is wrong: the grant turns on three terms it does not define. The open cases are a freelancer or employee using Tandem on paid work, a person running it on their own machine for an employer, and an organisation running it for its staff. `docs/licensing-terms.md:42-45` reads the grant as excluding organisations. `docs/decisions.md:1321` names the audience as "individuals (writers, editors, researchers, developers) on their own documents", and many of those people write for a living. `docs/positioning.md:47` and `:58` name the core use as reviewing someone else's document: "a freelancer reviewing a client's brief, an analyst checking a colleague's report", adding "Tandem is bought by the individual doing it". Terraform and Sentry both define their key terms inside the Parameter.
- Source: the lines quoted. Verified by reading.
- Drafted wording, to follow the grant:

  ```
                        "Personal use" means use by one natural person on
                        documents that person works on, including in the
                        course of that person's own paid work for clients.
                        "Individual self-hosting" means one natural person
                        running the Licensed Work on a device that person
                        controls, for that person's use only.
  ```

  The first draft of these definitions did not produce the outcomes it claimed. It said "that person's own documents", which ruled out reviewing a client's or colleague's draft, the use `docs/positioning.md` sells. It included "documents made in the course of that person's own work", which a closing sentence excluding use "on behalf of a company" then cancelled whenever a freelancer wrote for a corporate client. And that closing sentence attached only to "personal use", so an employee still qualified through "individual self-hosting" on their own device. The draft above fixes the first two.

  As drafted, these definitions put an employee inside the grant, and with them an organization that deploys Tandem to each employee's own machine. Adopting them without the sentence below decides that. It also contradicts `docs/licensing-terms.md:42-45` and §2 of that file, which read organizations out.

  The employee case is the licensor's decision. To put the employee outside the grant, add a sentence that reaches both terms and keeps the freelancer in:

  ```
                        Neither personal use nor individual self-hosting
                        includes use by or on behalf of an organization,
                        including by its employees in the course of their
                        employment. Use by a natural person in the course
                        of work that person does as an independent
                        contractor, directly or through a company that
                        person wholly owns, is personal use, and is not
                        use by or on behalf of that company or of the
                        client.
  ```

  The carve-out has to name the person's own company as well as the client. An earlier wording said only that such work "is not use on behalf of that client", which left the freelancer excluded as use by or on behalf of their own company.

  The cost of this option: under the L3 draft a license key extends only personal use and individual self-hosting, so no key sold at v1.0 would cover an employee using Tandem for their employer. The employed buyers `docs/positioning.md:58` names ("an analyst… legal, compliance, or consulting role… Tandem is bought by the individual doing it") would need a commercial licence, which `docs/licensing-terms.md` §2 says cannot be issued yet.

  To put the employee inside the grant, add nothing, and change `docs/licensing-terms.md`, which currently reads organizations out.

### L7. The Change License is named loosely

- Tag: licensor decision
- Location: `LICENSE:23`
- What is wrong: "MIT License". The GNU list says of the Expat licence: "Some people call this license 'the MIT License,' but that term is misleading, since MIT has used many licenses". The first covenant requires a Change License compatible with GPL 2.0 or later. The GNU list calls Expat "a lax, permissive non-copyleft free software license, compatible with the GNU GPL".
- Source: the GNU licence list. The SPDX text, covenant 1. Verified by reading.
- Drafted wording: `Change License:       MIT License (SPDX identifier: MIT)`

### L8. The Licensor is an individual, and ADR-040 plans a company

- Tag: licensor decision
- Location: `LICENSE:6`, `LICENSE:8`
- What is wrong: "Licensor: Bryan Kolb". `docs/decisions.md:1331` says "LLC + accountant before taking money." If the company sells licences, either it becomes the Licensor or it sells on the individual's behalf. `LICENSE:43-44` allows purchase from "the Licensor, its affiliated entities, or authorized resellers". Other names in the manifests differ too: `package.json:9` says `"author": "bloknayrb"`, and `.claude-plugin/plugin.json:5-7` says the author is "Tandem".
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

## Questions left to the licensor

Four legal questions are left to the licensor. They are noted where they arise: whether the grant's two prohibitions restrict the base grant (L3), whether terms of sale could still limit devices or transfer (L3), and the position of the earlier desktop releases (C8). The fourth has no finding of its own here:

### Contribution rights

- Tag: licensor decision
- Location: `LICENSE:6-8`, `CONTRIBUTING.md:3`
- A question on contribution rights is left to the licensor.

## What was not checked

- The built desktop installers were not opened. C6 rests on the bundle configuration, and on the `.rpm` metadata header of four releases (v0.11.0, v0.14.3, v0.15.0, v0.28.0).
- The plugin install path was not run.
- MariaDB's page was read as fetched HTML with the tags removed. Its numbered list of covenants came through with the numbering lost, so the covenant text quoted here is from SPDX.
- CockroachDB's licence was tried as a fourth comparison and the address returned 404.
- `CHANGELOG.md`, `docs/roadmap-history.md` and `docs/superpowers/specs/` were treated as history and not searched for restatements.
- Third-party notices for bundled dependencies and fonts were not reviewed.
