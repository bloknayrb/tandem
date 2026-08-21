/**
 * A stable, per-installation identifier for the connected server.
 *
 * Successive Tandem servers are reached at the SAME host:port — a `npm run dev`
 * client and the shipped product both live on `127.0.0.1:5173` / `:3479`, and
 * take turns — and one host:port is one `localStorage` bucket. So state written
 * while talking to one server is read back while talking to the next. That is
 * how #1387 leaks: scratchpad recovery keys were global to the bucket, so a
 * scratchpad opened on ANY server would restore content persisted while talking
 * to a DIFFERENT one. (Not a claim that `:5173` and `:3479` share storage — they
 * are two origins with two buckets. The Tauri WebView is a third,
 * `http://tauri.localhost`, and was never exposed to this.)
 *
 * The test harnesses used to be part of that rotation and no longer are: since
 * #1492 each runs on its own reserved pair from `scripts/test-ports.ts`, i.e.
 * its own origin and its own bucket. That removes one collision path; it does
 * not remove the dev-vs-product one, which is why this discriminator stays.
 *
 * The discriminator has to be stable across restarts — recovery exists to
 * survive them — which rules out `generationId`, new on every boot. The
 * server's session-store path (`storagePath` on `/api/info`) is one-to-one with
 * its app-data root: stable per installation, and distinct for any server that
 * sets `TANDEM_APP_DATA_DIR` — verified for E2E, perf and design baselines.
 * (Screenshots do NOT set their own: that config spreads the root Playwright
 * `webServer` verbatim, so it shares E2E's dir and id.) It is already exposed,
 * so this needs no new durable server state.
 *
 * Separation is by app-data root, not by binary: an npm-global install and the
 * desktop app both resolve the default root, so they share one id. That is the
 * intended reading — same user, same data — but it does mean "install" here is
 * shorthand for "app-data root".
 *
 * Deliberately NOT derived from the auth token: `shared/auth/token-file.ts`
 * resolves via `envPaths("tandem", { suffix: "" }).data` directly and ignores
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
    // `Math.imul` rather than `*`: the PRODUCT of a 32-bit accumulator and the
    // FNV prime reaches ~2^56, past float64's 53-bit mantissa, so plain
    // multiplication silently loses low bits. (The prime itself, 16777619, is
    // exactly representable — it is the product that overflows.)
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Derive the install id from a server's `storagePath`.
 *
 * Normalises separators, trailing separator and case first. Two spellings of
 * one directory MUST produce one id, or a restart would look like a different
 * installation and silently drop recovery.
 *
 * Only ONE of those three actually varies today. `storagePath` has a single
 * producer — `path.join(resolveAppDataDir(), "sessions")` — and `path.join`
 * already normalises separators to the platform's and strips a trailing one,
 * even when its input used the other kind. What survives it is casing: the
 * drive letter and `AppData` reach us however the env var or OS API spelled
 * them. The separator and trailing-slash handling is therefore defence in
 * depth, kept because the client is consuming a string it did not produce and
 * cannot re-derive.
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
