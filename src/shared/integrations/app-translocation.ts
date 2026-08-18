/**
 * Is this path inside a macOS App Translocation mount?
 *
 * A pure string predicate with no dependencies, carved out for the same reason
 * as `node-binary-name.ts`: the rule has two consumers on opposite sides of the
 * codebase, and two spellings would let them drift.
 *
 * **The producer** (`server/integrations/apply.ts#resolveBundledDist`) uses it
 * to REFUSE to record a bundle path — a quarantined `.app` opened from outside
 * `/Applications` runs from a randomized read-only
 * `/private/var/folders/…/AppTranslocation/<uuid>/d/Tandem.app`, which is gone
 * on the next launch, so a config written from there works exactly once.
 *
 * **The diagnostic** (`cli/doctor.ts`) uses it to EXPLAIN that refusal, which
 * otherwise leaves only a `console.error` on the sidecar's stderr that nobody
 * running the desktop app can see.
 *
 * The two feed it **different inputs** — the producer tests the injected
 * `TANDEM_*_DIST` env var, doctor tests `process.execPath` — and that asymmetry
 * is deliberate but load-bearing, so it is stated here rather than left to be
 * rediscovered: doctor is reporting "this install is running from a
 * translocated mount", not "the producer refused a specific path". The two
 * coincide on the real desktop layout (the sidecar and the resources live in the
 * same `.app`) but they are not the same question, and only the producer knows
 * whether a refusal actually fired.
 *
 * Matched on the path SEGMENT, not a prefix: the mount is under
 * `/private/var/folders/…` on some releases and `/var/folders/…` on others, and
 * only the literal directory name is stable. Separator-agnostic so a
 * Windows-shaped fixture read on Linux in CI cannot accidentally match, and so a
 * directory merely *named* like the mount (`MyAppTranslocationTool`) does not.
 */
export function isAppTranslocatedPath(path: string): boolean {
  return /[/\\]AppTranslocation[/\\]/.test(path);
}
