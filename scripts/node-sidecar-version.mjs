/**
 * The Node.js runtime bundled as the Tauri sidecar: which version, and the
 * hashes that prove the download is that version.
 *
 * **Why this is its own module.** `download-node-sidecar.mjs` runs its work at
 * the top level — importing it spawns `rustc -vV`, can `process.exit(0)`, and
 * reaches a top-level `await download(...)`. Anything that needs to *read* the
 * pinned version (the CI drift check, its wiring test) therefore cannot import
 * it from there without triggering a real download.
 *
 * **Why the hashes live here (#1747).** `verifyChecksum` in the downloader
 * fetches `SHASUMS256.txt` from nodejs.org — the same host, same TLS session
 * class and same CDN as the tarball itself, with no check of
 * `SHASUMS256.txt.sig` against Node's release signing keys. Anything able to
 * serve a malicious tarball can serve the matching hash, so that check detects
 * transport corruption and truncated downloads and nothing else. It is worth
 * keeping and it is not an integrity control. These committed hashes are: they
 * change only in a reviewed commit, and they sit beside the version so that
 * bumping one without the other is a visible omission rather than a silent one.
 *
 * When bumping: change `DEFAULT_NODE_VERSION`, then replace every entry below
 * with the values from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.
 * `tests/scripts/node-sidecar-pin-wiring.test.ts` asserts the key set matches
 * the downloader's `TRIPLE_MAP`, so a dropped entry fails `check` rather than
 * surfacing on someone's first real download.
 */

/** Pinned Node.js version for the bundled sidecar. Verified against nodejs.org's release index. */
export const DEFAULT_NODE_VERSION = "22.23.4";

/**
 * SHA-256 of each release archive for `DEFAULT_NODE_VERSION`, keyed by Rust
 * target triple. Taken from the official SHASUMS256.txt on 2026-10-21; its signature
 * (`SHASUMS256.txt.sig`) verified against releaser key
 * 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 from nodejs/release-keys.
 */
export const NODE_ARCHIVE_SHA256 = {
  "x86_64-pc-windows-msvc": "cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20",
  "aarch64-pc-windows-msvc": "a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111",
  "x86_64-apple-darwin": "efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819",
  "aarch64-apple-darwin": "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428",
  "x86_64-unknown-linux-gnu": "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
  "aarch64-unknown-linux-gnu": "f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9",
};
