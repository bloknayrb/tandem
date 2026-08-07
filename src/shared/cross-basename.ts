/**
 * `path.basename` on Linux does not treat `\` as a separator, so a Windows-style
 * path like `C:\Users\alice\notes.md` comes back whole — which on the one
 * platform CI runs on turns a scrub into a no-op and a basename allowlist into
 * a full-path match. Split on both separators instead.
 *
 * Dependency-free and platform-agnostic on purpose: the two callers are a
 * `src/shared/` allowlist predicate (`integrations/node-binary-name.ts`) and an
 * express response scrubber (`server/mcp/routes/_shared.ts`), and neither may
 * import the other's dependencies.
 */
export function crossBasename(p: string): string {
  return p.split(/[/\\]/).pop() || "";
}
