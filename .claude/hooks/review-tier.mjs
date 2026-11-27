#!/usr/bin/env node
/**
 * Classify a path into a review tier (ADR-058), from .claude/review-tiers.json.
 *
 *   node .claude/hooks/review-tier.mjs <path> <existed-before:0|1> [created-list-file]
 *
 * Prints `A`, `B` or `outside` (a path outside the repo, such as a plan file
 * under ~/.claude/plans, which no tier applies to). Exits 0 whatever it prints;
 * on any error it prints `A`, because a classifier that cannot decide must not
 * wave a change through the light path.
 *
 * `existed-before` is whether the file existed when the Edit/Write was
 * requested; `created-list-file` lists paths this session created, so a test
 * file the session made stays Tier B when it is edited again.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real path: import.meta.url is already resolved by the ESM loader, and the
// edited path is resolved the same way below, so a symlinked checkout compares
// like with like.
const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));

/** `**` spans directories, `*` stays within one. Everything else is literal. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (rel, globs) => globs.some((g) => globToRegExp(g).test(rel));

/**
 * The tier for one repo-relative, forward-slashed path.
 * `created` is true when the file did not exist before this edit, or this
 * session created it earlier.
 */
export function classify(rel, tiers, { created }) {
  // A file inside an agent's git worktree is a change to the project at the
  // path below the worktree root: classify that, so an isolated-worktree
  // agent editing src/ or a CLAUDE.md still gets the Tier A nudge.
  const inWorktree = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(rel);
  if (inWorktree) rel = inWorktree[1];
  // Agent scratch inside the repo dir (plan files, worktree roots, hook
  // state) is not a change to the project; no tier applies.
  if (matchesAny(rel, tiers.notAChange ?? [])) return "outside";
  if (matchesAny(rel, tiers.alwaysTierA)) return "A";
  if (matchesAny(rel, tiers.tierB)) return "B";
  if (created && matchesAny(rel, tiers.tierBNewFilesOnly)) return "B";
  return "A";
}

/**
 * `file` with symlinks resolved, through its nearest existing ancestor: the
 * file itself may not exist yet (a Write that creates it).
 */
export function realpathish(file) {
  let head = path.resolve(file);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(file);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** Repo-relative and forward-slashed, or null for a path outside the repo. */
export function toRepoRelative(file, root = ROOT) {
  const abs = realpathish(path.resolve(root, file.replace(/\\/g, "/")));
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

export function loadTiers(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, ".claude", "review-tiers.json"), "utf8"));
}

function main() {
  const [file, existedBefore, createdList] = process.argv.slice(2);
  const rel = toRepoRelative(file ?? "");
  if (rel === null) {
    process.stdout.write("outside");
    return;
  }
  const createdThisSession =
    !!createdList &&
    existsSync(createdList) &&
    readFileSync(createdList, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) => toRepoRelative(line) === rel);
  process.stdout.write(classify(rel, loadTiers(), { created: existedBefore === "0" || createdThisSession }));
}

// Real paths on both sides, so a symlinked checkout does not skip main().
const real = (p) => {
  try {
    return p ? realpathSync(p) : null;
  } catch {
    return null;
  }
};
const invoked = real(process.argv[1]);
if (invoked !== null && invoked === real(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch {
    process.stdout.write("A");
  }
}
