/**
 * A stable, per-installation identifier for the connected server.
 *
 * Every Tandem server on a machine shares one browser origin
 * (`127.0.0.1:5173` / `:3479`), so `localStorage` written while talking to one
 * server is visible to every other. That is how #1387 leaks: scratchpad
 * recovery keys were global to the origin, so a scratchpad opened on ANY server
 * would restore content persisted while talking to a DIFFERENT one.
 *
 * The discriminator has to be stable across restarts — recovery exists to
 * survive them — which rules out `generationId`, new on every boot. The
 * server's session-store path (`storagePath` on `/api/info`) is one-to-one with
 * its app-data root: stable per installation, and distinct for any server that
 * sets `TANDEM_APP_DATA_DIR` (E2E, perf, design baselines, screenshots). It is
 * already exposed, so this needs no new durable server state.
 *
 * Deliberately NOT derived from the auth token: `shared/auth/token-file.ts`
 * resolves via `envPaths("tandem").data` directly and ignores
 * `TANDEM_APP_DATA_DIR`, so a test server and the real server share one token
 * file — it would collide in precisely the case this exists to separate.
 *
 * Client-side, not `shared/`, because the derivation exists only to let a
 * browser tell two servers apart; nothing on the server needs it. If the server
 * ever publishes an `installId` of its own, this module goes away rather than
 * moving — the normalisation below exists only because the client is guessing
 * how a path it did not produce is spelled.
 */

/**
 * FNV-1a, 32-bit, hex. **Not a security boundary**: a collision degrades to the
 * pre-#1387 behaviour (a cross-install restore), so this only needs to separate
 * a handful of paths on one machine, not resist an adversary. A non-crypto hash
 * also keeps this synchronous — `crypto.subtle` is async and would push a
 * promise into the persistence hook's attach path for no benefit.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // `Math.imul` rather than `*`: the 32-bit FNV prime overflows a float64
    // mantissa, so plain multiplication silently loses low bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Derive the install id from a server's `storagePath`.
 *
 * Normalises separators, trailing separator and case first, because the same
 * directory reaches us spelled differently depending on who resolved it:
 * Windows APIs return backslashes and a drive letter whose case is not
 * guaranteed, while a path that has been through `env-paths` or an env var may
 * arrive with forward slashes. Two spellings of one directory MUST produce one
 * id, or a restart would look like a different installation and silently drop
 * recovery.
 *
 * The lowercase is unconditional, which differs from `doc-hash.ts`'s rule for
 * the same problem (it lowercases only on Windows, because POSIX paths are
 * case-sensitive). The cost here is that two POSIX directories differing only
 * in case share an id — a collision, which by the note above degrades to
 * pre-#1387 behaviour rather than breaking anything. Worth it to avoid
 * threading a platform flag into the browser for a case that needs two
 * same-named-but-differently-cased Tandem installs to matter.
 */
export function installIdFromStoragePath(storagePath: string): string {
  const normalized = storagePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return fnv1a32(normalized);
}
