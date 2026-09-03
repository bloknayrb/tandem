import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Parser, parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = path.join(ROOT, ".github/workflows");

/**
 * #1745 — every third-party action except `azure/login` was referenced by a
 * mutable tag, in jobs holding `TAURI_SIGNING_PRIVATE_KEY`, the Apple signing
 * identity, the Azure code-signing session and `GITHUB_TOKEN`. A force-moved tag
 * on any of them executes arbitrary code with the release signing material, and
 * the desktop updater trusts the minisign key baked into `tauri.conf.json`, so a
 * signed malicious build auto-installs on every user.
 *
 * This is the guard on the pin. It is an ADR-051 wiring test: none of the five
 * workflows is read by any required check on its own (`tauri-release.yml` runs
 * only on `v*` tags, `publish.yml` only on a published release), so without
 * something inside `check` reading them, un-pinning is a one-line edit nobody
 * sees.
 *
 * What this guard does NOT buy, so nobody reads it as more than it is:
 *
 *   - **Pins are not transitive.** Freezing `tauri-apps/tauri-action` freezes
 *     that repo's `action.yml`, not the refs inside it. A composite action whose
 *     own steps say `uses: actions/setup-node@v4` still resolves a mutable tag,
 *     inside the job holding the signing material.
 *   - **A 40-hex ref is a shape, not an identity.** GitHub resolves
 *     `owner/repo@<sha>` against the whole fork network, so a SHA existing only
 *     in a fork resolves and runs. Nothing offline can detect that; the
 *     provenance check in CONTRIBUTING.md is a human step, by necessity. The
 *     owner/repo SET below is what stops a typosquat or a brand-new action
 *     arriving unnoticed.
 *   - **`npm ci` runs in the same jobs**, before the signing steps, with no
 *     `--ignore-scripts`. Compromising one transitive dependency is a cheaper
 *     attack than moving a tag, and pinning actions does nothing about it.
 *
 * Following the existing wiring tests: parse YAML rather than substring-match
 * the file, pin SETS rather than validating whatever members happen to be there
 * (ADR-051 rule 3), and throw rather than return a sentinel when something is
 * missing — an assertion that silently passes when its subject is deleted is the
 * likeliest reversion.
 */

// ADR-051 rule 3. A new workflow file fails this until it is added here, which
// is what stops one arriving unpinned.
const WORKFLOW_FILES = [
  "ci.yml",
  "claude-code-review.yml",
  "publish.yml",
  "tauri-release.yml",
  "tauri-webdriver.yml",
];

// The complete inventory of third-party actions this repo executes. Editing it
// means adding or removing a dependency that runs with repository secrets, which
// is exactly the change that should not pass without a human looking. Dependabot
// bumps the SHA, never the owner/repo, so weekly bumps do not touch this list.
const ALLOWED_ACTIONS = [
  "actions/checkout",
  "actions/github-script",
  "actions/setup-node",
  "actions/setup-python",
  "actions/upload-artifact",
  "anthropics/claude-code-action",
  "azure/login",
  "dtolnay/rust-toolchain",
  "swatinem/rust-cache",
  "tauri-apps/tauri-action",
];

const RUST_TOOLCHAIN = "dtolnay/rust-toolchain";
const RUST_TOOLCHAIN_SITES = 4;

const SHA_PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

type Step = { uses?: string; with?: Record<string, unknown> };
type Job = { uses?: string; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function read(file: string): string {
  return readFileSync(path.join(WORKFLOW_DIR, file), "utf-8");
}

/**
 * Every `uses:` value the workflow actually executes: step-level, and job-level
 * for the reusable-workflow form. The job-level arm has no instance today — it
 * is here because the count check below compares this walk against a raw scan,
 * and a `uses:` shape the walker cannot see would otherwise read as a false
 * positive and get "fixed" by loosening the scan.
 */
function walkUses(file: string): string[] {
  const wf = parse(read(file)) as Workflow;
  const found: string[] = [];
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    if (!job || typeof job !== "object") {
      throw new Error(`${file}: job '${jobId}' is not a mapping`);
    }
    if (typeof job.uses === "string") found.push(job.uses);
    for (const step of job.steps ?? []) {
      if (typeof step?.uses === "string") found.push(step.uses);
    }
  }
  return found;
}

/**
 * Count `uses:` keys in the raw token stream — deliberately WIDER than the
 * walker, so a `uses:` in a shape `walkUses` does not visit fails the equality
 * check below instead of vanishing.
 *
 * This reads the CST rather than line-matching, and that is load-bearing in both
 * directions. `tauri-release.yml` is dense with prose comments and long `run: |`
 * bodies; a line regex counts `# uses: actions/foo@v1` in a comment and a
 * `uses:` inside a shell heredoc, producing a false red. The cheapest repair for
 * a false red is to loosen the pattern, which removes the widening detection —
 * so the scan has to be right rather than merely strict.
 */
function countUsesTokens(file: string): number {
  const src = read(file);
  let count = 0;
  for (const token of new Parser().parse(src)) {
    visitTokens(token, (t) => {
      if (t.type === "scalar" && t.source === "uses") count++;
    });
  }
  return count;
}

function visitTokens(token: unknown, fn: (t: { type?: string; source?: string }) => void): void {
  if (!token || typeof token !== "object") return;
  fn(token as { type?: string; source?: string });
  for (const value of Object.values(token as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) visitTokens(item, fn);
    } else if (value && typeof value === "object") {
      visitTokens(value, fn);
    }
  }
}

/** Raw lines carrying a pinned ref, for the comment check (comments are not in the parse tree). */
function pinnedLines(file: string): string[] {
  return read(file)
    .split("\n")
    .filter((line) => /^\s*(?:- )?uses:/.test(line));
}

describe("every action in every workflow is SHA-pinned (#1745)", () => {
  it("the set of workflow files is pinned, so a new one cannot arrive unpinned", () => {
    const found = readdirSync(WORKFLOW_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
    expect(found).toEqual([...WORKFLOW_FILES].sort());
  });

  it("no composite actions exist, so none can smuggle an unpinned ref past this file", () => {
    // The `./`-prefixed local-action form is the complete bypass of everything
    // else here: `.github/actions/x/action.yml` can hold
    // `uses: dtolnay/rust-toolchain@stable`, be referenced as
    // `uses: ./.github/actions/x`, and leave all five workflows byte-identical.
    // The empty literal IS the rule — any composite action, pinned or not, fails
    // this until someone deliberately extends this file to sweep it. Both
    // spellings, because `action.yaml` is equally valid and a `.yml`-only glob
    // would miss it.
    const actionsDir = path.join(ROOT, ".github/actions");
    const found: string[] = [];
    const walk = (dir: string) => {
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as never;
      } catch {
        return; // directory does not exist — the expected state
      }
      for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/^action\.ya?ml$/.test(entry.name)) found.push(path.relative(ROOT, full));
      }
    };
    walk(actionsDir);
    expect(found).toEqual([]);
  });

  for (const file of WORKFLOW_FILES) {
    describe(file, () => {
      it("every executed `uses:` is a 40-hex commit SHA", () => {
        const uses = walkUses(file);
        expect(uses.length).toBeGreaterThan(0);
        for (const ref of uses) {
          // `docker://` is NOT exempted. Nothing uses it, and an exemption
          // written because "none exist today" is the bypass — a
          // `docker://ghcr.io/x/y:latest` is the most mutable ref form there is.
          // Local `./` refs are equally unexempted; the composite-action check
          // above is what keeps that honest.
          expect(ref, `${file}: '${ref}' is not pinned to a 40-hex commit SHA`).toMatch(SHA_PINNED);
        }
      });

      it("every action is one this repo has deliberately taken on", () => {
        const owners = walkUses(file).map((ref) =>
          ref.slice(0, ref.lastIndexOf("@")).toLowerCase(),
        );
        for (const owner of owners) {
          expect(ALLOWED_ACTIONS, `${file}: '${owner}' is not in the allowed set`).toContain(owner);
        }
      });

      it("the token scan and the walker agree on how many `uses:` there are", () => {
        // Wider than the walker on purpose: a mismatch means a `uses:` exists in
        // a position the walker does not visit. Fail rather than skip it.
        expect(
          countUsesTokens(file),
          `${file}: raw \`uses:\` keys and walked \`uses:\` values disagree — ` +
            `a \`uses:\` exists somewhere walkUses() does not look. Extend the walker; ` +
            `do not loosen the scan.`,
        ).toBe(walkUses(file).length);
      });

      it("every pinned ref carries a version comment", () => {
        // Presence, not truth: `# see PR 1745` passes, and so would a comment
        // naming the wrong version. A stricter regex was tried and rejected —
        // `/#\s*v?\d/` fails on this repo's own `# stable` pin for
        // dtolnay/rust-toolchain, and a `(v?\d|stable)` alternation is a hole
        // with a name. A weak assertion described accurately beats a regex that
        // looks strict and is not. Reading raw text is a deliberate exception to
        // ADR-051 rule 2 — comments are absent from the parse tree.
        for (const line of pinnedLines(file)) {
          expect(
            line,
            `${file}: pinned ref has no trailing version comment: ${line.trim()}`,
          ).toMatch(/@[0-9a-f]{40}\s+#\s*\S/);
        }
      });
    });
  }

  it("every dtolnay/rust-toolchain site passes `toolchain: stable` explicitly", () => {
    // The action derives its toolchain from the ref NAME, so a SHA pin without
    // this would try to install a toolchain literally named 4360b52... . The
    // failure is loud rather than silent, which makes this a build-breakage
    // trap rather than a security one — but the compensation is invisible from
    // the pin diff, so it is pinned here. The count is asserted (rule 3) so
    // deleting a site cannot shrink the check to vacuity.
    const sites: Array<{ file: string; with?: Record<string, unknown> }> = [];
    for (const file of WORKFLOW_FILES) {
      const wf = parse(read(file)) as Workflow;
      for (const job of Object.values(wf.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step?.uses === "string" && step.uses.startsWith(`${RUST_TOOLCHAIN}@`)) {
            sites.push({ file, with: step.with });
          }
        }
      }
    }
    expect(sites).toHaveLength(RUST_TOOLCHAIN_SITES);
    for (const site of sites) {
      expect(
        site.with?.toolchain,
        `${site.file}: rust-toolchain site missing \`toolchain: stable\``,
      ).toBe("stable");
    }
  });
});

describe("dependabot keeps the pins current (#1744)", () => {
  // This describe OWNS the Dependabot facts; no other test asserts them.
  const config = parse(readFileSync(path.join(ROOT, ".github/dependabot.yml"), "utf-8")) as {
    version?: number;
    updates?: Array<Record<string, unknown>>;
  };

  it("declares the three ecosystems this repo actually has", () => {
    expect(config.version).toBe(2);
    const ecosystems = (config.updates ?? []).map((u) => u["package-ecosystem"]);
    expect(ecosystems).toEqual(["github-actions", "npm", "cargo"]);
  });

  it("the github-actions entry is pinned by exact equality", () => {
    // ADR-051 rule 3, and the reason it is the WHOLE object rather than a few
    // fields: "ecosystem present and non-empty" is satisfied by a config that
    // produces zero PRs forever — `open-pull-requests-limit: 0` (the documented
    // way to disable updates), an `ignore` catch-all, a `target-branch` pointing
    // somewhere nobody looks, or a yearly interval. Exact equality subsumes that
    // family the way it subsumes the `|| true` family for npm scripts.
    //
    // Deliberately ungrouped: grouping would collapse a week of action bumps
    // into one PR mutating a dozen 40-hex strings, which is precisely the
    // artifact in which one wrong SHA is invisible.
    const entry = (config.updates ?? []).find((u) => u["package-ecosystem"] === "github-actions");
    expect(entry).toEqual({
      "package-ecosystem": "github-actions",
      directory: "/",
      schedule: { interval: "weekly" },
    });
  });
});
