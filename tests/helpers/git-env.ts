/**
 * `process.env` minus every `GIT_*` variable, for anything a test spawns into a
 * throwaway repo (#1957).
 *
 * `git push` from a LINKED worktree exports `GIT_DIR=<repo>/.git/worktrees/<name>`
 * to the pre-push hook, and the hook runs the suite. A `git init` that inherits
 * it ignores `cwd`, re-initializes the REAL repository instead, and — with
 * `GIT_DIR` set and no work tree — writes `core.bare = true` into the config
 * every worktree shares. The main checkout then fails every git command with
 * "this operation must be run in a work tree". A git-reading script spawned
 * with the same env reads the real repository, not the fixture.
 */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}
