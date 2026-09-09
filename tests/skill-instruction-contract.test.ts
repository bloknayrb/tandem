import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readShippedSkill(): string {
  return readFileSync(new URL("../skills/tandem/SKILL.md", import.meta.url), "utf8");
}

function readRepoText(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function frontmatter(skill: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1];
  expect(block, "the shipped skill has no frontmatter").toBeDefined();
  return block ?? "";
}

function namedSection(skill: string, heading: string): string {
  const pattern = new RegExp(
    `^## ${heading.replace(/\./g, "\\.")}\\r?\\n([\\s\\S]*?)(?=^## )`,
    "m",
  );
  const section = pattern.exec(skill)?.[1];
  expect(section, `the shipped skill has no ${heading} section`).toBeDefined();
  return section ?? "";
}

function gettingWokenSection(skill: string): string {
  return namedSection(skill, "Getting Woken While Idle");
}

function docxWorkflow(skill: string): string {
  return namedSection(skill, ".docx Review Workflow");
}

function hardRules(skill: string): string {
  return namedSection(skill, "Hard Rules");
}

function annotationGuideSection(skill: string): string {
  return namedSection(skill, "Annotation Guide");
}

/**
 * Extracts one numbered Hard Rule item's own text, up to (not including) the next
 * numbered item. Scoping to the literal `N. ` / `N+1. ` markers — rather than matching
 * loose keywords anywhere in the whole Hard Rules section — is what makes an assertion
 * here fail when rule N is deleted: a sibling rule that happens to share vocabulary
 * (e.g. `INVALID_ARGUMENT`, `tandem_appendContent`) can no longer stand in for it.
 */
function hardRuleItem(skill: string, n: number): string {
  const rules = hardRules(skill);
  const pattern = new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^${n + 1}\\. |$(?![\\s\\S]))`, "m");
  const item = pattern.exec(rules)?.[1];
  expect(item, `Hard Rule ${n} not found in the shipped skill`).toBeDefined();
  return item ?? "";
}

/**
 * Instruction guard: this tests the behavior Claude is told to perform. It is
 * intentionally lexical because SKILL.md is the public interface delivered to
 * the host; there is no executable implementation behind these instructions.
 */
function expectPerSessionAutoArmContract(skill: string): void {
  const wake = gettingWokenSection(skill);

  // Pinned exactly, and it is a TRIPWIRE rather than a constant: the installed copy only
  // refreshes when the bundled version is newer, so a wake-contract change that forgets the
  // bump ships to nobody. Pinning the current number forces a deliberate look here whenever
  // the version moves — including for an unrelated edit, which is the cost of the guard, not
  // a bug in it. When you land here: confirm the assertions below still describe the shipped
  // wake instructions, then move the number. Last moved to 18 by the Gc2a position-mapping group
  // (#1776): the Collaboration Etiquette bullet now says `tandem_getActivity`'s `cursor` is a
  // flat UTF-16 offset and a proximity hint only. That bullet is outside the wake section; every
  // wake assertion below was re-read against the bumped file and is unchanged. Before that, to
  // 17 by the #1821 docs-drift group B:
  // Hard Rule 1 now says offsets are UTF-16 code units, not characters. The wake section was
  // re-read against the bumped file and is unchanged. Before that, to 15 by the J1 group (#1771, #1820,
  // #1737): the dead Word-comment recipe fix, four SKILL.md content gaps (stale Hard Rule 4,
  // the missing tandem_annotationReply/Edit-Write/sub-agent-inbox rules), and the
  // mid-paragraph line-break rule. The sub-agent-inbox rule (Hard Rule 7) DOES reach into this
  // section — the wake section's own review fix scoped arming and the post-wake poll to the
  // orchestrator, and the "Wakes are best-effort" bullet carries the same qualifier — so the
  // orchestrator-only assertion below is part of the wake contract, not an extra. Every wake
  // assertion here was re-read against the bumped file.
  expect(skill).toMatch(/^version:\s*18$/m);
  expect(wake).toMatch(/hand-started session/i);
  expect(wake).toMatch(/first successful read-mode `tandem_status`/i);
  expect(wake).toMatch(/read `wakeUrl`/i);
  expect(wake).toContain(
    "Monitor({ ws: { url: <wakeUrl from tandem_status> }, persistent: true })",
  );
  // Hard Rule 7 forbids a sub-agent the poll a wake exists to trigger, so arming has to be
  // scoped too — an unqualified "arm one watch" here is read by the sub-agent that also loads
  // this skill, and its first wake drives the poll that empties the orchestrator's inbox.
  expect(wake).toMatch(/only the orchestrator arms a watch/i);
  expect(wake).toMatch(/Arm it at most once per session/i);
  expect(wake).toMatch(/Do not use Tandem's process-global subscriber count/i);
  expect(wake).not.toMatch(/only if Tandem's tool output has told you nothing is subscribed/i);

  expect(wake).toMatch(/Do not arm one if Tandem launched you/i);
  expect(wake).toMatch(/wake tells you \*that\* something happened, never \*what\*/i);
  expect(wake).toMatch(/Always call `tandem_checkInbox`/i);
  expect(wake).toMatch(/Keep polling every 2-3 tool calls regardless/i);
  expect(wake).toMatch(/If every wake arrives twice/i);
  expect(wake).toMatch(/(?:^|[.!?]\s+)Stop your watch with `TaskStop` and keep polling/i);
  expect(wake).toMatch(
    /If the Monitor tool is absent or the attempt fails, say so once and stop trying/i,
  );
  expect(wake).toMatch(/channel shim/i);
}

describe("shipped Tandem skill instruction contract", () => {
  it("attempts one session-local persistent wake watch on first hand-started use", () => {
    expectPerSessionAutoArmContract(readShippedSkill());
  });

  /**
   * The description is what decides whether the skill is invoked at all, so it is the
   * load-bearing half of the first-use fix — and it was unpinned: reverting it while
   * keeping the version bump passed every other test in this file. #1393 measured natural
   * first-use dispatch at 3 of 6, and every declining trace called `ToolSearch` before
   * `tandem_status`, so the description is read (if at all) before any tool call exists.
   */
  it("states the trigger as a precondition in time, not as an offering", () => {
    // Collapsed: the YAML folded block wraps mid-phrase, so a literal match would be
    // asserting on where the line breaks fall rather than on what the text says.
    const front = frontmatter(readShippedSkill()).replace(/\s+/g, " ");

    expect(front).toMatch(/before the first tandem_\* call/i);
    // A lone status check was the exact case a model rationalised as too small to
    // warrant the skill, so it is named rather than left to inference.
    expect(front).toMatch(/lone status check/i);
    expect(front).toMatch(/woken while idle/i);
    // "Provides workflow guidance…" described what the skill offers, which a model that
    // can answer from one `tandem_status` call correctly reads as skippable.
    expect(front).not.toMatch(/\bprovides workflow guidance\b/i);
  });

  it("rejects the version-9 process-global subscriber precondition", () => {
    const shipped = readShippedSkill();
    const mutant = shipped.replace(
      "Do not use Tandem's process-global subscriber count to decide whether this session is covered.",
      "Only arm if Tandem's tool output has told you nothing is subscribed.",
    );

    expect(mutant, "the mutation did not alter the guarded instruction").not.toBe(shipped);
    expect(() => expectPerSessionAutoArmContract(mutant)).toThrow();
  });

  it.each([
    [
      "the once-per-session limit",
      "Arm it at most once per session.",
      "Arm a persistent watch for this turn.",
    ],
    [
      "the failed-attempt stop rule",
      "If the Monitor tool is absent or the attempt fails, say so once and stop trying.",
      "If the Monitor tool is absent or the attempt fails, retry it on every turn.",
    ],
    [
      "the duplicate-watch stand-down direction",
      "Stop your watch with `TaskStop` and keep polling",
      "Never stop your watch with `TaskStop`; keep polling",
    ],
  ])("rejects a mutation that reverses %s", (_contract, from, to) => {
    const shipped = readShippedSkill();
    const mutant = shipped.replace(from, to);

    expect(mutant, "the mutation did not alter the guarded instruction").not.toBe(shipped);
    expect(() => expectPerSessionAutoArmContract(mutant)).toThrow();
  });

  it.each([
    ["shipped skill", readShippedSkill()],
    ["README", readRepoText("README.md")],
    ["troubleshooting guide", readRepoText("docs/troubleshooting.md")],
  ])("%s distinguishes the account gate from the Git Bash requirement", (_surface, text) => {
    expect(text).toMatch(
      /(?:built-in )?Monitor tool(?:(?!\n\n)[\s\S]){0,250}(?:needs|requires|wants) Git Bash|on Windows(?:(?!\n\n)[\s\S]){0,150}(?:needs|requires|wants) Git Bash/i,
    );
    expect(text).toMatch(
      /plugin monitor shares (?:that|the) (?:same )?per-account (?:feature )?gate/i,
    );
    expect(text).toMatch(/plugin monitor does not require Git Bash on Windows/i);
    expect(text).toMatch(/PowerShell/i);
  });

  it.each([
    ["README", readRepoText("README.md")],
    ["troubleshooting guide", readRepoText("docs/troubleshooting.md")],
  ])("%s describes the three transports as routes with automatic overlap", (_surface, text) => {
    expect(text).toMatch(/choose one setup route where possible/i);
    expect(text).toMatch(/plugin[^.]*built-in Monitor[^.]*start both automatically/i);
    expect(text).not.toMatch(
      /want exactly one of them|Use ONE of the three|alternatives — not layers/i,
    );
  });

  it("does not narrow automatic plugin/watch overlap to double-installed sessions", () => {
    const troubleshooting = readRepoText("docs/troubleshooting.md");
    expect(troubleshooting).toMatch(/plugin-only or double-installed session/i);
  });

  it("names the real two-step Word-comment recipe instead of the dead author:import filter (#1771)", () => {
    const workflow = docxWorkflow(readShippedSkill());

    // The dead framing this issue names: the recipe must not tell Claude to "read and act
    // on" an author:"import" result, since an un-promoted import never survives the
    // note-type filter. The literal call stays as the notesExcluded probe — this is not an
    // absence check on the call itself.
    expect(workflow).not.toMatch(/read and act on/i);

    // The one real signal (notesExcluded) plus the actual promoted-state discriminator
    // (importSource) must both be present.
    expect(workflow).toContain("notesExcluded");
    expect(workflow).toContain("importSource");

    // promotedFrom is stamped on every promoted note, including the user's own personal
    // notes — the recipe must say it is not a reliable import marker. `\b` word-boundaries
    // on "not"/"never" are load-bearing: a bare substring match is satisfied by the word
    // "note" itself (promotedFrom's own value), which is exactly the inverted claim this
    // guards against.
    expect(workflow).toMatch(
      /promotedFrom[\s\S]{0,200}\b(?:not|never)\b[\s\S]{0,60}(?:reliable|discriminat)/i,
    );

    // Solo mode holds the promotion like any other user comment. Anchored on the actual
    // disclosure sentence, not a bare /solo/i scan — the workflow's export step separately
    // mentions "withheld Solo-held annotations", which would satisfy a loose match even
    // with this sentence deleted.
    expect(workflow).toMatch(/the promotion is held like any other user comment/i);
  });

  /**
   * Review finding (annotation-model-reviewer-3): the promoted-import recipe
   * presented `tandem_getAnnotations({author:"user"})` + `importSource` as a
   * full read of a Word comment, but every threaded Word reply is stamped
   * `private: true` at import (docx-comments.ts) and `channelVisibleReplies`
   * (annotations.ts) strips it permanently — including after promotion — so
   * a Word thread's follow-ups never reach Claude via this recipe. The
   * recipe must disclose that, not just note-count `heldFromExport`, which
   * doesn't count withheld replies either.
   */
  it("discloses that Word thread replies never reach Claude, even promoted (annotation-model-reviewer-3)", () => {
    const workflow = docxWorkflow(readShippedSkill());
    expect(workflow).toMatch(
      /repl(?:y|ies)[\s\S]{0,200}never reach Claude|never reach Claude[\s\S]{0,200}repl(?:y|ies)/i,
    );
    expect(workflow).toMatch(
      /promot(?:ed|ion)[\s\S]{0,150}replies|replies[\s\S]{0,150}promot(?:ed|ion)/i,
    );
  });

  it("closes the four SKILL.md content gaps (#1820)", () => {
    const skill = readShippedSkill();
    const rules = hardRules(skill);
    const annotationGuide = annotationGuideSection(skill);
    const workflow = docxWorkflow(skill);

    // Rule 4: format-conditional newline handling, not the stale unconditional claim.
    // Scoped to Rule 4's own text (not the whole Hard Rules block) — Rule 5, added in the
    // same change, independently mentions `tandem_appendContent` and `INVALID_ARGUMENT`,
    // so a block-wide scan would keep passing even with Rule 4 deleted outright.
    const rule4 = hardRuleItem(skill, 4);
    expect(rule4).toContain("tandem_appendContent");
    expect(rule4).toContain("tandem_editList");
    expect(rule4).not.toMatch(
      /\.html?\b[\s\S]{0,80}INVALID_ARGUMENT|INVALID_ARGUMENT[\s\S]{0,80}\.html?\b/i,
    );
    expect(rule4).toMatch(
      /(?:plaintext|`\.txt`)[\s\S]{0,250}INVALID_ARGUMENT|INVALID_ARGUMENT[\s\S]{0,250}(?:plaintext|`\.txt`)/i,
    );
    expect(rule4).not.toContain("Newlines become literal characters.");

    // New Hard Rule: sub-agents must not poll the inbox (decision H).
    expect(rules).toMatch(
      /sub-agent[\s\S]{0,300}(?:must not|never)[\s\S]{0,150}tandem_checkInbox/i,
    );

    // New Hard Rule: no Edit/Write on a Tandem-open file.
    expect(rules).toContain("`Edit`");
    expect(rules).toContain("`Write`");
    expect(rules).toContain("EXTERNAL_CONFLICT");
    expect(rules).toMatch(
      /force: true[\s\S]{0,250}(?:ask the user|the user resolves)|(?:ask the user|the user resolves)[\s\S]{0,250}force: true/i,
    );

    // Rule 2 addendum: textSnapshotTruncated.
    expect(rules).toContain("textSnapshotTruncated");

    // Annotation Guide: tandem_annotationReply named as the idempotency-checked reply tool.
    expect(annotationGuide).toMatch(
      /tandem_annotationReply[\s\S]{0,250}idempotent|idempotent[\s\S]{0,250}tandem_annotationReply/i,
    );

    // Error Recovery: both new codes present.
    expect(skill).toContain("EXTERNAL_CONFLICT");
    expect(skill).toContain("NO_DOCUMENT");

    // .docx Review Workflow: heldFromExport noted on the export step.
    expect(workflow).toContain("heldFromExport");
  });

  it("docs/workflows.md's Multi-Model Workflow names orchestrator-only polling (#1820)", () => {
    const doc = readRepoText("docs/workflows.md");
    const section = /^## Multi-Model Workflow\r?\n([\s\S]*?)(?=^## )/m.exec(doc)?.[1];
    expect(section, "docs/workflows.md has no Multi-Model Workflow section").toBeDefined();

    expect(section).toMatch(/orchestrator/i);
    expect(section).toContain("tandem_checkInbox");
  });

  // #1790 item 3. Until now this file pinned the frontmatter `version:` NUMBER only, so a
  // content-only edit at an unchanged version was invisible — the miss that made v0.20.0 and
  // v0.20.1 never reach upgraders, since the refresh gate is version-keyed.
  //
  // The hash covers the text AFTER the frontmatter's closing `---`, with CRLF normalised
  // first (this repo's CRLF-staleness hazard must not red the suite). Excluding the
  // frontmatter is deliberate: a version bump alone does not churn the hash, so the loud case
  // is exactly "body changed, version did not".
  //
  // HONEST LIMIT: this forces a deliberate edit at the spot that says what to do. It cannot
  // prove the bump happened.
  it("reds on a body-only skill edit, not just a version change (#1790)", () => {
    const skill = readShippedSkill().replace(/\r\n/g, "\n");
    const frontmatterBlock = /^---\n[\s\S]*?\n---\n/.exec(skill)?.[0];
    expect(frontmatterBlock, "the shipped skill has no frontmatter").toBeDefined();
    const body = skill.slice((frontmatterBlock ?? "").length);
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);

    expect(
      { version: /^version:\s*(\d+)\s*$/m.exec(skill)?.[1], bodyHash },
      "skills/tandem/SKILL.md changed. Bump its frontmatter `version:` AND update BOTH " +
        "literals here in the same commit — the installed copy only refreshes when the " +
        "bundled version is newer, so a body edit at an unchanged version never ships.",
    ).toEqual({ version: "18", bodyHash: "1349598969cc" });
  });

  // #1770: the skill is the only surface that tells Claude what it may NOT do with a card
  // it did not write. The MCP tool descriptions carry the refusal, but a refusal read at
  // failure time is a worse teacher than a rule read before the call.
  it("scopes annotation authority to the author (#1770)", () => {
    const skill = readShippedSkill();
    expect(skill).toMatch(/NOT_OWNED/);
    expect(skill).toMatch(/ACCEPT_REFUSED/);
    // The positive half: withdrawing is what Claude may do instead of accepting.
    expect(skill).toMatch(
      /action: "dismiss"[\s\S]{0,120}withdraw|withdraw[\s\S]{0,160}action: "dismiss"/i,
    );
    expect(skill).toMatch(/resolvedBy/);
  });

  it("tells Claude not to insert mid-paragraph line breaks (#1737)", () => {
    const rules = hardRules(readShippedSkill());
    expect(rules).toMatch(
      /own soft-wrap handle display[\s\S]{0,80}mid-paragraph|mid-paragraph[\s\S]{0,80}own soft-wrap handle display/i,
    );
  });
});
