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
export const DEFAULT_NODE_VERSION = "22.23.2";

/**
 * SHA-256 of each release archive for `DEFAULT_NODE_VERSION`, keyed by Rust
 * target triple. Taken from the official SHASUMS256.txt on 2026-09-02.
 */
export const NODE_ARCHIVE_SHA256 = {
  "x86_64-pc-windows-msvc": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "aarch64-pc-windows-msvc": "fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3",
  "x86_64-apple-darwin": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
  "aarch64-apple-darwin": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "x86_64-unknown-linux-gnu": "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
  "aarch64-unknown-linux-gnu": "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
};
