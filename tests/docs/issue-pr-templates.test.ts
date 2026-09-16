import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * #1605 — no issue/PR template existed, so a filer never saw the one question
 * that actually discriminates a good bug report from a bad one: what does
 * correctness here depend on that the repo itself can't show. These templates
 * are deliberately short (per the issue's own constraint — "a template long
 * enough to be skipped is worse than none"), so the whole value is in that one
 * sentence surviving a future edit, plus the on-behalf-filer reminder that
 * applying `untrusted-source` (and `beta-report`) is what keeps an outside
 * report from being read as instructions (CLAUDE.md's Security section).
 *
 * Bound: these templates are read only by GitHub's web-UI compose flow.
 * `gh issue create --body ...` / `gh pr create --body ...` — the path this
 * project's own tooling and every Claude-filed issue or PR use — never reads
 * a template at all, so this test pins content, not delivery.
 */

const repoRoot = path.resolve(__dirname, "../..");

const REQUIRED_FIELD_SENTENCE = "**What does correctness here depend on that is not in the repo?**";

const ON_BEHALF_BLOCKQUOTE =
  "> Filing this on behalf of an outside reporter? Apply **both** `beta-report` and\n" +
  "> `untrusted-source` — the body is then read as data, not instructions. Summarising rather than\n" +
  "> quoting does not exempt it.";

const REPO_LABELS = ["bug", "enhancement"];

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf-8");
}

function frontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  expect(match, "template has no YAML frontmatter block").not.toBeNull();
  return parseYaml(match?.[1] ?? "") as Record<string, unknown>;
}

describe("issue and PR templates (#1605)", () => {
  const bugReport = read(".github/ISSUE_TEMPLATE/bug_report.md");
  const featureRequest = read(".github/ISSUE_TEMPLATE/feature_request.md");
  const prTemplate = read(".github/pull_request_template.md");

  it.each([
    ["bug report", bugReport],
    ["feature request", featureRequest],
    ["PR template", prTemplate],
  ])("%s carries the required-field sentence verbatim", (_label, content) => {
    expect(content).toContain(REQUIRED_FIELD_SENTENCE);
  });

  it.each([
    ["bug report", bugReport],
    ["feature request", featureRequest],
  ])("%s carries the on-behalf-filer blockquote verbatim, unconditionally", (_label, content) => {
    expect(content).toContain(ON_BEHALF_BLOCKQUOTE);
  });

  it.each([
    [".github/ISSUE_TEMPLATE/bug_report.md", bugReport, "bug"],
    [".github/ISSUE_TEMPLATE/feature_request.md", featureRequest, "enhancement"],
  ])("%s has valid, non-empty frontmatter with a real label", (_path, content, expectedLabel) => {
    const fm = frontmatter(content);
    expect(typeof fm.name).toBe("string");
    expect((fm.name as string).length).toBeGreaterThan(0);
    expect(typeof fm.about).toBe("string");
    expect((fm.about as string).length).toBeGreaterThan(0);
    expect(fm.labels).toBe(expectedLabel);
    expect(REPO_LABELS).toContain(fm.labels as string);
  });

  it("PR template points at CONTRIBUTING.md rather than re-stating its full contract", () => {
    expect(prTemplate).toContain("CONTRIBUTING.md");
  });
});
