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

function gettingWokenSection(skill: string): string {
  const section = /^## Getting Woken While Idle\r?\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1];
  expect(section, "the shipped skill has no idle-wake instructions").toBeDefined();
  return section ?? "";
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
  // wake instructions, then move the number. Last moved to 12 for the absent-tools rule
  // (#1463), which does not touch this section.
  expect(skill).toMatch(/^version:\s*12$/m);
  expect(wake).toMatch(/hand-started session/i);
  expect(wake).toMatch(/first successful read-mode `tandem_status`/i);
  expect(wake).toMatch(/read `wakeUrl`/i);
  expect(wake).toContain(
    "Monitor({ ws: { url: <wakeUrl from tandem_status> }, persistent: true })",
  );
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
});
