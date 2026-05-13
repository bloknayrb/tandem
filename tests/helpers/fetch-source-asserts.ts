import { expect } from "vitest";

/**
 * Assert that `src` contains a `fetchWithTimeout(...)` call against `endpoint`
 * paired with the given timeout constant. The endpoint may appear as the
 * literal path (`/api/foo-bar`) or as the corresponding `API_*` identifier
 * (`API_FOO_BAR`) — both are accepted so callers using the centralized
 * `src/shared/api-paths.ts` constants pass without test churn.
 */
export function expectFetchWithTimeoutEndpoint(
  src: string,
  endpoint: string,
  timeoutConstant: string,
): void {
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEndpoint = escapeRe(endpoint);
  const escapedTimeout = escapeRe(timeoutConstant);
  const constantName = `API_${endpoint
    .replace(/^\/api\//, "")
    .replace(/-/g, "_")
    .toUpperCase()}`;
  const endpointAlternation = `(?:${escapedEndpoint}|${constantName})`;
  expect(src).toMatch(
    new RegExp(`fetchWithTimeout\\([\\s\\S]*?${endpointAlternation}[\\s\\S]*?${escapedTimeout}`),
  );
}

export function countMatches(src: string, re: RegExp): number {
  return src.match(re)?.length ?? 0;
}
