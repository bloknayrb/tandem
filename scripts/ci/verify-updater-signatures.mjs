#!/usr/bin/env node
/**
 * #1830 — verify every `latest.json` platform signature against the minisign
 * public key baked into `src-tauri/tauri.conf.json`.
 *
 * What existed before: `tauri-release.yml`'s "Validate updater signing key"
 * step asserts only that `TAURI_SIGNING_PRIVATE_KEY` is non-empty, and
 * `verify-release-manifest` asserts every platform key is present, every `url`
 * resolves to an attached asset, and every entry's `signature` is a non-empty
 * STRING — never that the signature verifies. So a private key that no longer
 * matches `plugins.updater.pubkey` ships green and breaks the update on every
 * installed copy, surfacing as user reports weeks later.
 *
 * Minisign format, for the next reader (there is no library here — Node
 * builtins only, deliberately: this job runs no `npm ci`, so it has no
 * `node_modules`):
 *
 *   A `.pub` / `.sig` file is line-oriented text. `tauri.conf.json`'s `pubkey`
 *   and `latest.json`'s `signature` are that whole FILE, base64-wrapped:
 *
 *     untrusted comment: <anything>
 *     <base64: alg(2) | key_id(8) | signature(64)>
 *     trusted comment: <anything>
 *     <base64: global_signature(64)>
 *
 *   `alg` is `Ed` (pure Ed25519 over the file) or `ED` (Ed25519 over a
 *   BLAKE2b-512 digest of it). Tauri signs with `ED`. The global signature
 *   covers `signature || trusted_comment`, which is what binds the trusted
 *   comment to the artifact — tamper with it and the artifact signature still
 *   verifies, so both halves must be checked.
 *
 * The two exports are pure so the WALK is testable. The wrong implementation
 * this exists to prevent is not a broken single-signature check: it is a walk
 * that dedupes the VERIFICATION rather than the DOWNLOAD, leaving 4 of the 11
 * platform entries' `signature` strings never read (the 11 keys point at 7
 * distinct asset URLs — `darwin-*`/`-app`, `linux-x86_64`/`-appimage` and
 * `windows-x86_64`/`-nsis` each pair up).
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Tauri signs with the prehashed variant. A bare `Ed` is a different scheme. */
const PREHASHED_ALGORITHM = "ED";

class MalformedError extends Error {}

function fail(reason) {
  return { ok: false, reason };
}

/** Base64 of a minisign file body -> its non-blank lines. */
function unwrapFile(base64, label) {
  if (typeof base64 !== "string" || base64.trim() === "") {
    throw new MalformedError(`${label} is empty`);
  }
  const text = Buffer.from(base64, "base64").toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    throw new MalformedError(`${label} has ${lines.length} non-blank line(s), expected >= 2`);
  }
  return lines;
}

function decodeExact(base64, bytes, label) {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== bytes) {
    throw new MalformedError(`${label} decoded to ${buf.length} bytes, expected ${bytes}`);
  }
  return buf;
}

function parsePublicKey(publicKey) {
  const lines = unwrapFile(publicKey, "public key");
  // alg(2) | key_id(8) | key(32)
  const payload = decodeExact(lines[lines.length - 1], 42, "public key payload");
  return { keyId: payload.subarray(2, 10), key: payload.subarray(10, 42) };
}

function parseSignature(signature) {
  const lines = unwrapFile(signature, "signature");
  // alg(2) | key_id(8) | sig(64)
  const payload = decodeExact(lines[1], 74, "signature payload");
  const trustedLine = lines[2];
  if (typeof trustedLine !== "string" || !trustedLine.startsWith("trusted comment:")) {
    throw new MalformedError("signature has no `trusted comment:` line");
  }
  if (typeof lines[3] !== "string") {
    throw new MalformedError("signature has no global-signature line");
  }
  return {
    algorithm: payload.subarray(0, 2).toString("latin1"),
    keyId: payload.subarray(2, 10),
    signature: payload.subarray(10, 74),
    // minisign signs the comment text after the fixed `trusted comment: `
    // prefix, not the whole line.
    trustedComment: trustedLine.slice("trusted comment: ".length),
    globalSignature: decodeExact(lines[3], 64, "global signature"),
  };
}

function ed25519(rawKey) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify one minisign signature.
 *
 * @param {{ publicKey: string, signature: string, data: Buffer | Uint8Array }} args
 *   `publicKey` and `signature` are the base64-wrapped file bodies exactly as
 *   they appear in `tauri.conf.json` and `latest.json`.
 * @returns {{ ok: true } | { ok: false, reason: "algorithm" | "key-id" | "signature" | "global-signature" | "malformed" }}
 */
export function verifyMinisign({ publicKey, signature, data }) {
  let pub;
  let sig;
  try {
    pub = parsePublicKey(publicKey);
    sig = parseSignature(signature);
  } catch (err) {
    if (err instanceof MalformedError) return fail("malformed");
    throw err;
  }

  // Reject an unexpected algorithm EXPLICITLY. A legacy non-prehashed `Ed`
  // must not fall through to a `false` that reads like tampering, and must
  // not be accepted by hashing differently.
  if (sig.algorithm !== PREHASHED_ALGORITHM) return fail("algorithm");
  if (!sig.keyId.equals(pub.keyId)) return fail("key-id");

  let key;
  try {
    key = ed25519(pub.key);
  } catch {
    return fail("malformed");
  }

  const digest = createHash("blake2b512").update(data).digest();
  if (!edVerify(null, digest, key, sig.signature)) return fail("signature");

  const globalPayload = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!edVerify(null, globalPayload, key, sig.globalSignature)) return fail("global-signature");

  return { ok: true };
}

/**
 * Walk a `latest.json` `platforms` object, verifying EVERY entry.
 *
 * The download is deduped by `url`; the verification is not. Those two are the
 * whole point of the split — see the header.
 *
 * It THROWS rather than resolving `{ ok: … }` whenever it cannot evaluate: an
 * empty or absent `platforms`, an entry with no `signature`, or a `fetchBytes`
 * rejection. A gate that reports success when it could not evaluate is the
 * #1229 failure mode `ci.yml` names.
 *
 * @param {{ publicKey: string, platforms: Record<string, { url: string, signature: string }>, fetchBytes: (url: string) => Promise<Buffer | Uint8Array> }} args
 */
export async function verifyManifest({ publicKey, platforms, fetchBytes }) {
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms)) {
    throw new Error("latest.json has no `platforms` object — nothing to verify");
  }
  const entries = Object.entries(platforms);
  if (entries.length === 0) {
    throw new Error("latest.json `platforms` is empty — nothing to verify");
  }
  if (typeof fetchBytes !== "function") {
    throw new TypeError("verifyManifest requires a fetchBytes(url) function");
  }

  /** @type {Map<string, Promise<Buffer>>} */
  const downloads = new Map();
  const results = [];

  for (const [key, platform] of entries) {
    const url = platform?.url;
    if (typeof url !== "string" || url === "") {
      throw new Error(`platform \`${key}\` has no \`url\` — cannot evaluate`);
    }
    const signature = platform?.signature;
    if (typeof signature !== "string" || signature === "") {
      throw new Error(`platform \`${key}\` has no \`signature\` — cannot evaluate`);
    }
    if (!downloads.has(url)) {
      downloads.set(
        url,
        Promise.resolve(fetchBytes(url)).then((bytes) => Buffer.from(bytes)),
      );
    }
    // A rejection propagates: an artifact we could not download is a
    // signature we did not check, not a signature that passed.
    const data = await downloads.get(url);
    const outcome = verifyMinisign({ publicKey, signature, data });
    results.push({ key, ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
  }

  const failures = results.filter((r) => !r.ok).map(({ key, reason }) => ({ key, reason }));
  return { ok: failures.length === 0, results, failures };
}

// --- CLI -------------------------------------------------------------------
// Env-reading plus one call to verifyManifest, nothing else.

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const conf = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const publicKey = conf?.plugins?.updater?.pubkey;
  if (!publicKey) throw new Error("src-tauri/tauri.conf.json has no plugins.updater.pubkey");

  const token = requireEnv("GH_TOKEN");
  const repo = requireEnv("GH_REPO");
  const releaseId = requireEnv("RELEASE_ID");

  const api = async (url) => {
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    return res.json();
  };

  // `arrayBuffer()` always yields bytes. Do NOT copy the content-type-driven
  // body parsing from the neighbouring github-script step: that shape exists
  // because octokit picks its parser from the response content-type, which is
  // whatever was recorded at upload time.
  const fetchBytes = async (url) => {
    const res = await fetch(url, {
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const assets = await api(
    `https://api.github.com/repos/${repo}/releases/${releaseId}/assets?per_page=100`,
  );
  const manifestAsset = assets.find((a) => a.name === "latest.json");
  if (!manifestAsset) {
    throw new Error(`latest.json is not attached to release ${releaseId}`);
  }
  const manifest = JSON.parse((await fetchBytes(manifestAsset.url)).toString("utf8"));

  const { ok, results, failures } = await verifyManifest({
    publicKey,
    platforms: manifest.platforms,
    fetchBytes,
  });

  for (const result of results) {
    console.log(result.ok ? `ok    ${result.key}` : `FAIL  ${result.key} (${result.reason})`);
  }
  if (!ok) {
    const named = failures.map((f) => `${f.key} (${f.reason})`).join(", ");
    throw new Error(
      `${failures.length} of ${results.length} platform signature(s) do not verify against ` +
        `plugins.updater.pubkey: ${named}. Do NOT publish — every installed copy trusts that key.`,
    );
  }
  console.log(`all ${results.length} platform signatures verify against plugins.updater.pubkey`);
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
