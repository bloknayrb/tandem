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
export const DEFAULT_NODE_VERSION = "22.23.5";

/**
 * SHA-256 of each release archive for `DEFAULT_NODE_VERSION`, keyed by Rust
 * target triple. Taken from the official SHASUMS256.txt on 2026-11-11; its signature
 * (`SHASUMS256.txt.sig`) verified against releaser key
 * 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 from nodejs/release-keys.
 */
export const NODE_ARCHIVE_SHA256 = {
  "x86_64-pc-windows-msvc": "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3",
  "aarch64-pc-windows-msvc": "c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13",
  "x86_64-apple-darwin": "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422",
  "aarch64-apple-darwin": "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d",
  "x86_64-unknown-linux-gnu": "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1",
  "aarch64-unknown-linux-gnu": "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3",
};
