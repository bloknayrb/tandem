/**
 * The wizard's saved-setup merge (#2198): pre-fill from `integrations.json`,
 * and save back without losing what the wizard does not own.
 *
 * Before this, `begin()` read only the detected installs and `save()` POSTed a
 * file built from the picked cards alone — a whole-file replace. Every Apply
 * therefore dropped `workingDirectory` (the cwd Tandem's Claude spawns in),
 * `tokenSecretRef` (orphaning its keychain secret), `nodeBinary`, every
 * `other-mcp` or not-detected-right-now record and `defaultIntegrationId`, and
 * preselected targets the user never chose. Harmless while the wizard opened
 * only for people with nothing saved; the v1.0 walkthrough sends everyone
 * through it.
 *
 * The rules, all pure so they are tested without a component:
 *   - A detected install MATCHES a saved record of its kind by `configPath`
 *     (separator- and case-folded — Windows casing, older record forms), or,
 *     when there is exactly one record and one install of that kind, by kind
 *     alone (Apply itself collapses per kind).
 *   - A matched card is built FROM the record: its id, ref, cwd and the rest
 *     ride along, so nothing is minted fresh for it.
 *   - Saving rebuilds the file in its ORIGINAL order from the fresh record
 *     (re-read at save time, so a cwd change made meanwhile survives), with
 *     only the wizard-owned fields — the config path, a newly entered token,
 *     the apply intent — taken from the card. The launcher takes the first
 *     launchable claude-code record, so order is behaviour.
 *   - A record the user did not pick is kept unchanged; one they explicitly
 *     unchecked this session is kept as `apply: "skip"` (the schema's
 *     configured-but-disabled, which the launcher honours). New picks append.
 */

import type {
  ExistingMcpInstall,
  IntegrationConfig,
  IntegrationsFile,
} from "../../shared/integrations/contract.js";
import { INTEGRATIONS_SCHEMA_VERSION } from "../../shared/integrations/contract.js";

/** The wizard card — re-declared here so this module needs no Svelte. */
export interface MergePicked {
  id: string;
  config: IntegrationConfig;
  /** Built from a saved record (its id is the record's). */
  fromRecord?: true;
}

/**
 * The single source of truth for "the on-disk tandem entry is hand-edited /
 * invalid, leave it alone". Shared by `isSelectable` (preselection), the
 * save's apply intent (`applyIntentFor` → "skip"), and the card's status line
 * — these three must never diverge or the UI lies about what apply will do.
 */
export function tandemEntryValidationFailed(install: ExistingMcpInstall): boolean {
  return install.tandemValidation !== undefined && install.tandemValidation.status !== "valid";
}

/** A Tandem entry on disk that the wizard would leave in place. */
export function hasValidTandemEntry(install: ExistingMcpInstall): boolean {
  return install.tandemEntry !== undefined && !tandemEntryValidationFailed(install);
}

/** The keychain refs a set of records holds. */
export function refsOf(records: readonly IntegrationConfig[]): Set<string> {
  return new Set(
    records
      .map((r) => r.tokenSecretRef)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0),
  );
}

export function normalizeConfigPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function recordConfigPath(record: IntegrationConfig): string | undefined {
  return "configPath" in record && typeof record.configPath === "string"
    ? record.configPath
    : undefined;
}

/** The saved record a detected install stands for, if any. */
export function matchRecord(
  install: ExistingMcpInstall,
  records: readonly IntegrationConfig[],
  installs: readonly ExistingMcpInstall[],
): IntegrationConfig | undefined {
  const kind = install.target.kind;
  const sameKind = records.filter((r) => r.kind === kind);
  const key = normalizeConfigPath(install.target.configPath);
  const exact = sameKind.find((r) => {
    const p = recordConfigPath(r);
    return p !== undefined && normalizeConfigPath(p) === key;
  });
  if (exact) return exact;
  const installsOfKind = installs.filter((i) => i.target.kind === kind);
  return sameKind.length === 1 && installsOfKind.length === 1 ? sameKind[0] : undefined;
}

/** A card built from a saved record: everything rides along except the
 * apply intent, which `buildSaveFile` decides. */
export function recordToConfig(
  install: ExistingMcpInstall,
  record: IntegrationConfig,
): IntegrationConfig {
  const { apply: _apply, ...rest } = record;
  return "configPath" in rest
    ? ({ ...rest, configPath: install.target.configPath } as IntegrationConfig)
    : (rest as IntegrationConfig);
}

/**
 * Something is already set up: a saved Claude record, or a valid entry on
 * disk. It is what the walkthrough's Keep keeps, and it makes the pre-fill
 * selective — only a user with neither gets "preselect everything connectable".
 */
export function isSomethingSetUp(
  installs: readonly ExistingMcpInstall[],
  records: readonly IntegrationConfig[],
): boolean {
  return records.some((r) => r.kind !== "other-mcp") || installs.some(hasValidTandemEntry);
}

/** Whether a selectable install starts checked. A saved record decides for
 * itself (`skip` is the user's own "disabled"); otherwise a valid entry on
 * disk does. */
export function preselects(
  install: ExistingMcpInstall,
  record: IntegrationConfig | undefined,
  selective: boolean,
): boolean {
  if (!selective) return true;
  return record ? record.apply !== "skip" : hasValidTandemEntry(install);
}

/** The detected install a card or record writes to, by config path. */
export function findInstallFor(
  config: IntegrationConfig,
  existing: readonly ExistingMcpInstall[],
): ExistingMcpInstall | undefined {
  const p = recordConfigPath(config);
  if (p === undefined) return undefined;
  const key = normalizeConfigPath(p);
  return existing.find((e) => normalizeConfigPath(e.target.configPath) === key);
}

/**
 * A ticked card that is neither the saved setup nor already set up on disk
 * (#2199): the user is changing something, so the walkthrough's Connect leads
 * rather than its Keep.
 */
export function picksSomethingNew(
  picked: readonly MergePicked[],
  existing: readonly ExistingMcpInstall[],
): boolean {
  return picked.some((p) => {
    if (p.fromRecord) return false;
    const install = findInstallFor(p.config, existing);
    return install === undefined || !hasValidTandemEntry(install);
  });
}

function applyIntentFor(
  config: IntegrationConfig,
  existing: readonly ExistingMcpInstall[],
): IntegrationConfig["apply"] {
  // `other-mcp` is constrained to apply: "skip" by the schema.
  if (config.kind === "other-mcp") return "skip";
  // A hand-edited entry on disk that failed validation is left alone: apply
  // would replace it with the canonical shape and erase the customisation.
  const matched = findInstallFor(config, existing);
  return matched !== undefined && tandemEntryValidationFailed(matched) ? "skip" : "create";
}

export interface BuildSaveInput {
  /** The record as re-read at save time. */
  saved: IntegrationsFile;
  picked: readonly MergePicked[];
  existing: readonly ExistingMcpInstall[];
  /** Saved records the user unchecked this session. */
  deselected: ReadonlySet<string>;
  /** Each saved record's `tokenSecretRef` when the wizard opened, by id — the
   * baseline a newly entered token is told apart from. */
  originalRefs: ReadonlyMap<string, string | undefined>;
}

export interface BuildSaveOutput {
  file: IntegrationsFile;
  /** The ids to APPLY: the picked cards only, never a kept record. */
  applyIds: string[];
  /** Saved refs a newly entered token replaced: delete them once the new
   * file is persisted, and never before. */
  superseded: string[];
  /** A card built from a saved record whose record is gone from the fresh
   * read (removed, or rewritten under a new id, while the wizard was open):
   * saving would re-add it from a stale copy, so the caller must not. */
  stale: boolean;
}

export function buildSaveFile(input: BuildSaveInput): BuildSaveOutput {
  const { saved, picked, existing, deselected, originalRefs } = input;
  const pickedById = new Map(picked.map((p) => [p.id, p]));
  const superseded: string[] = [];
  const integrations = saved.integrations.map((record): IntegrationConfig => {
    const card = pickedById.get(record.id);
    if (card) {
      pickedById.delete(record.id);
      const original = originalRefs.get(record.id);
      const newRef = card.config.tokenSecretRef;
      const replaced = newRef !== undefined && newRef !== original;
      // The ref the new token replaces is the one on disk NOW.
      const onDisk = record.tokenSecretRef;
      if (replaced && onDisk !== undefined && onDisk !== newRef) superseded.push(onDisk);
      const cardPath = recordConfigPath(card.config);
      const merged = {
        ...record,
        ...("configPath" in record && cardPath !== undefined ? { configPath: cardPath } : {}),
        ...(replaced ? { tokenSecretRef: newRef } : {}),
      } as IntegrationConfig;
      return { ...merged, apply: applyIntentFor(merged, existing) } as IntegrationConfig;
    }
    if (deselected.has(record.id) && record.kind !== "other-mcp") {
      return { ...record, apply: "skip" } as IntegrationConfig;
    }
    return record;
  });
  const stale = [...pickedById.values()].some((card) => card.fromRecord === true);
  for (const card of pickedById.values()) {
    integrations.push({
      ...card.config,
      apply: applyIntentFor(card.config, existing),
    } as IntegrationConfig);
  }
  const keepsDefault =
    saved.defaultIntegrationId !== undefined &&
    integrations.some((i) => i.id === saved.defaultIntegrationId);
  return {
    file: {
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations,
      ...(keepsDefault ? { defaultIntegrationId: saved.defaultIntegrationId } : {}),
    },
    applyIds: picked.map((p) => p.id),
    // Never one the new file still references: a hand-edited file can share a
    // ref between records, and deleting it would orphan the other one.
    superseded: superseded.filter((ref) => !refsOf(integrations).has(ref)),
    stale,
  };
}
