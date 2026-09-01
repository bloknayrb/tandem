/**
 * `path.basename` on Linux does not treat `\` as a separator, so a Windows-style
 * path like `C:\Users\alice\notes.md` comes back whole — which on the one
 * platform CI runs on turns a scrub into a no-op and a basename allowlist into
 * a full-path match. Split on both separators instead.
 *
 * Dependency-free and platform-agnostic on purpose: callers span all three
 * trees -- a `src/shared/` allowlist predicate (`integrations/node-binary-name.ts`),
 * an express response scrubber (`server/mcp/routes/_shared.ts`), the file-open
 * pipeline (`server/documents/open.ts`) and the client's document workspace
 * (`client/hooks/useDocumentWorkspace.svelte.ts`) -- and none may import
 * another's dependencies. That list is illustrative rather than a maintained
 * census; the constraint it explains is the load-bearing part.
 */
export function crossBasename(p: string): string {
  return p.split(/[/\\]/).pop() || "";
}
