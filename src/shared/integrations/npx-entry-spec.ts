/**
 * The canonical `npx` stdio tuple for the `tandem` MCP entry, in one place.
 *
 * A pure, dependency-free leaf for the same reason as `node-binary-name.ts`:
 * three places need this tuple and each had its own spelling. The **writer**
 * (`server/integrations/apply.ts#buildStdioTandemEntry`) emitted it as a raw
 * array literal, the **validator**
 * (`server/integrations/existing-config.ts#validateTandemEntry`) matched it
 * token-by-token, and the boot sweep now has to recognise it too. Textual
 * drift between three copies is exactly what this prevents.
 *
 * **The version is a PARAMETER, never resolved here.** `src/shared/integrations/`
 * is imported by eight files under `src/client/`, which build through **Vite,
 * not tsup** — so this module must not read `__TANDEM_VERSION__`/`__APP_VERSION__`
 * (esbuild leaves an absent define as a free global, and under Vite neither
 * define exists, so it would throw `ReferenceError` at runtime — the hazard
 * documented at `apply.ts`'s `resolveCliVersion`) and must not touch `node:fs`.
 * `apply.ts` keeps `resolveCliVersion()` and passes the spec in.
 *
 * Extraction prevents TEXTUAL drift, not semantic drift. The three-way test in
 * `tests/shared/npx-entry-spec.test.ts` is what pins the semantics: the tuple
 * `buildStdioTandemEntry` emits in fallback mode must be both accepted by
 * `validateTandemEntry` and matched by {@link isCanonicalNpxStdioArgs}.
 *
 * **That test is also this module's tracked criterion.** The boot sweep's
 * convergence rule is permanent rather than a dated migration *because*
 * `buildStdioTandemEntry` still emits this tuple as its fallback floor today.
 * That premise lives in code, so the test fails the moment it stops holding —
 * which is what makes "no sunset date" a defensible answer rather than an
 * indefinite deferral.
 */

/** `-y`, so `npm exec` never prompts. */
const NPX_HEAD = "-y";
/** The subcommand the stdio bridge is reached by. */
const NPX_TAIL = "mcp-stdio";

/**
 * `tandem-editor` bare, or `tandem-editor@<exact semver>` (optional prerelease).
 *
 * Deliberately rejects dist-tags (`@latest`, `@next`): a tag would re-resolve on
 * every spawn, which is the stale-global problem the exact pin exists to defeat
 * (ADR-023's `Update (#1177)`).
 */
const TANDEM_EDITOR_SPEC_RE = /^tandem-editor(@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?$/;

/** Canonical unpinned tuple, for the validator's `invalid-args` reason string. */
export const TANDEM_STDIO_NPX_ARGS: readonly string[] = [NPX_HEAD, "tandem-editor", NPX_TAIL];

/**
 * Build the args the writer emits when it cannot produce an absolute pair.
 *
 * `spec` is the full npm spec (`tandem-editor` or `tandem-editor@1.2.3`); the
 * caller owns version resolution — see this module's header.
 */
export function buildNpxStdioArgs(spec: string): string[] {
  return [NPX_HEAD, spec, NPX_TAIL];
}

/**
 * Is this args array the canonical npx stdio tuple?
 *
 * **Version-agnostic on purpose.** Any spec matching {@link TANDEM_EDITOR_SPEC_RE}
 * qualifies, pinned or not. The pin records the *writer's* default at the time
 * the entry was written, not a user's choice — so treating an old pin as intent
 * would refuse to repair precisely the entries an older Tandem wrote, which are
 * the ones most likely to be broken. (`tandem setup --apply` already rewrites an
 * old pin with no version gate; see `tests/cli/setup.test.ts`.)
 *
 * Matched by ARITY, INDEX and `typeof`, never by joining and searching. A
 * `args.join(" ").includes("mcp-stdio")` formulation would also match the
 * plugin manifest's 3-arg `tandem-channel` tuple
 * (`["-y", "tandem-editor@x", "channel"]`) and a hand-edited entry carrying
 * extra flags — both of which must fail.
 */
export function isCanonicalNpxStdioArgs(args: unknown): boolean {
  return (
    Array.isArray(args) &&
    args.length === 3 &&
    args[0] === NPX_HEAD &&
    typeof args[1] === "string" &&
    TANDEM_EDITOR_SPEC_RE.test(args[1]) &&
    args[2] === NPX_TAIL
  );
}
