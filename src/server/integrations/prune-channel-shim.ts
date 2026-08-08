import { homedir } from "node:os";
import { join } from "node:path";
import { removeConfigEntries } from "./apply.js";

/**
 * One-shot removal of the legacy default-on `mcpServers.tandem-channel` entry
 * from `~/.claude.json` (Track E, 2026-08-07).
 *
 * ## Why this exists at all
 *
 * `shouldRegisterChannelShim` no longer writes the shim by default, but that
 * only fixes future installs. Every user who has already run setup carries the
 * entry, and **nothing rewrites MCP config outside a re-run of setup** — so
 * without this the fix would reach approximately nobody. The shim ships inside
 * the app bundle and the npm package, so a new build is the only event we can
 * rely on; this hooks that event, exactly as `refreshSkillIfStale` does for the
 * bundled skill.
 *
 * ## Why it is a MIGRATION and not a policy
 *
 * The intent problem is unsolvable from the config alone: an entry written by
 * the old default and an entry written by `--with-channel-shim` are byte-
 * identical, because they were produced by the same code. A prune that ran on
 * every boot would therefore delete a deliberate opt-in, every time, forever —
 * silently overriding a choice the user made explicitly. That is strictly worse
 * than the problem being fixed.
 *
 * So it runs **once per install**, gated on a marker file, and never again. A
 * user who opts back in afterwards keeps the shim permanently. The marker is
 * written whenever the prune reaches a decision — including when it decides
 * there was nothing to remove — because "we already asked this question" is the
 * fact being recorded, not "we removed something".
 *
 * ## What it deliberately will not do
 *
 * It does not touch `mcpServers.tandem` (the HTTP entry carrying the user's
 * bearer token), it does not create `~/.claude.json`, it does not rewrite
 * malformed JSON, and it does not rewrite the file at all when the key is
 * absent. Those four properties come from `removeConfigEntries`, which is the
 * uninstall path's scrubber and already has exactly the conservative semantics
 * a boot-time mutation of someone else's config file needs. Rolling a fresh
 * JSON edit here instead would have re-derived all four, badly.
 *
 * Failure is silent by design: this is best-effort housekeeping on a file
 * Tandem does not own, and a read-only or locked config must never keep the
 * server from starting.
 */

/** Marker filename under the app-data root. Presence = "already considered". */
export const CHANNEL_SHIM_PRUNE_MARKER = "channel-shim-pruned";

export type PruneOutcome =
  /** The marker was already present — this install has been considered. */
  | "already-done"
  /** The entry was found and removed. */
  | "pruned"
  /** No entry to remove; marker written so we do not look again. */
  | "nothing-to-prune"
  /** Something went wrong. The marker is NOT written, so a later run retries. */
  | "failed";

export interface PruneChannelShimOptions {
  /** Overrides `homedir()`. Tests only — never plumbed to a request body. */
  homeOverride?: string;
  /** App-data root that holds the marker file. */
  appDataDir: string;
}

export async function pruneLegacyChannelShimEntry(
  opts: PruneChannelShimOptions,
): Promise<PruneOutcome> {
  const fs = await import("node:fs/promises");
  const markerPath = join(opts.appDataDir, CHANNEL_SHIM_PRUNE_MARKER);

  try {
    await fs.access(markerPath);
    return "already-done";
  } catch {
    // Marker absent — first consideration on this install.
  }

  const configPath = join(opts.homeOverride ?? homedir(), ".claude.json");

  try {
    const result = await removeConfigEntries(configPath, ["tandem-channel"]);

    // A refusal (missing file, malformed JSON, oversized, unsafe path) is NOT a
    // decision — it is an absence of one. Writing the marker there would burn
    // the single attempt against a config we never actually read, so a user
    // whose Claude config is temporarily unreadable would keep the stale entry
    // forever. Leave the marker unwritten and let a later boot try again.
    if (result.status !== "removed" && result.status !== "no-op") return "failed";

    await fs.mkdir(opts.appDataDir, { recursive: true });
    await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, "utf-8");

    if (result.status === "removed") {
      console.error(
        "[Tandem] Removed the legacy default-on `tandem-channel` MCP entry. " +
          "It was attached but not delivering, and its presence masked the " +
          "warning that nothing was notifying Claude. Re-add it any time with " +
          "`tandem setup --apply --with-channel-shim`.",
      );
      return "pruned";
    }
    return "nothing-to-prune";
  } catch (err) {
    console.error(
      `[Tandem] Channel-shim prune failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return "failed";
  }
}
