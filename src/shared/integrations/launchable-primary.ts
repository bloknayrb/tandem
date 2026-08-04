/**
 * The single definition of "is this integration a launchable primary?" —
 * i.e. an assistant Tandem can actually spawn and drive as the user's primary
 * collaborator, as opposed to one it merely writes config for.
 *
 * Two things make an integration launchable:
 *   1. Its `kind` is one Tandem knows how to launch ({@link LAUNCHABLE_PRIMARY_KINDS}).
 *      `claude-desktop` is excluded — Tandem writes its config but never spawns
 *      it. `other-mcp` is excluded — Tandem doesn't know the client at all.
 *   2. Its `apply` intent is not `"skip"`. A skipped entry is one Tandem
 *      records but deliberately does not write to disk, so there is no
 *      configured assistant behind it to launch.
 *
 * Lives in `src/shared/integrations/` (alongside `contract.ts`) because both
 * the server and the client need the identical answer — a client that thinks
 * an entry is launchable while the server disagrees produces a UI offering a
 * launch the server will 404.
 *
 * **This replaces three hand-written shapes that had drifted:**
 *   1. A `ClaudeCodeIntegration | CodexIntegration` **type predicate** used to
 *      narrow before reading `workingDirectory` — `server/launcher/api-routes.ts`,
 *      `server/launcher/supervisor.ts`, `server/integrations/storage.ts`.
 *   2. A plain `boolean` helper over a fully-typed `IntegrationConfig` —
 *      `client/hooks/useIntegrationWizard.svelte.ts`.
 *   3. A loose duck-typed test over `{ kind?: string; apply?: string }` parsed
 *      straight from a `GET /api/integrations` response —
 *      `client/components/settings-tabs/SettingsClaudeCodeTab.svelte`, and
 *      `client/components/IntegrationWizardModal.svelte`, which checked only
 *      the kind and **not** `apply !== "skip"` (the drift this consolidates
 *      away: adopting this predicate there adds the missing `apply` term).
 *
 * The generic-plus-intersection return type is what lets one function serve
 * all three: it narrows whatever it was given, so a caller holding a
 * discriminated `IntegrationConfig` gets `ClaudeCodeIntegration |
 * CodexIntegration` back, while a caller holding a loose parsed JSON object
 * gets its own type with `kind` pinned.
 */

/** Integration kinds Tandem can spawn and drive, not merely configure. */
export const LAUNCHABLE_PRIMARY_KINDS = ["claude-code", "codex"] as const;

export type LaunchablePrimaryKind = (typeof LAUNCHABLE_PRIMARY_KINDS)[number];

/**
 * The minimum an object must expose to be tested. Deliberately looser than
 * `IntegrationConfig` so a raw `GET /api/integrations` body — where every
 * field is `string | undefined` until validated — can be passed directly.
 */
export interface LaunchablePrimaryFields {
  kind?: string;
  apply?: string;
}

/**
 * Kind-only half of the test, for callers that hold a bare kind string
 * (a `DetectedTarget.kind`, a `provider` field) rather than a whole
 * integration record. Prefer {@link isLaunchablePrimary} whenever the `apply`
 * intent is available — a launchable *kind* with `apply: "skip"` is not a
 * launchable integration.
 */
export function isLaunchablePrimaryKind(
  kind: string | null | undefined,
): kind is LaunchablePrimaryKind {
  return LAUNCHABLE_PRIMARY_KINDS.includes(kind as LaunchablePrimaryKind);
}

/**
 * True when `integration` is an assistant Tandem can launch as the primary
 * collaborator. Narrows its argument, so the launcher call sites can read
 * `workingDirectory` off the result without a cast.
 *
 * Accepts `null` / `undefined` (the common `find(...)` result) and answers
 * `false` — callers should not have to guard first.
 */
export function isLaunchablePrimary<T extends LaunchablePrimaryFields>(
  integration: T | null | undefined,
): integration is T & { kind: LaunchablePrimaryKind } {
  return (
    integration != null && isLaunchablePrimaryKind(integration.kind) && integration.apply !== "skip"
  );
}
