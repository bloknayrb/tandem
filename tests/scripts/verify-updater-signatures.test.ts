import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { verifyManifest, verifyMinisign } from "../../scripts/ci/verify-updater-signatures.mjs";

/**
 * #1830 — nothing verified the updater `.sig` against `tauri.conf.json`'s
 * pubkey. `verify-release-manifest` asserted every entry's `signature` was a
 * non-empty STRING; a private key that no longer matches the baked-in public
 * key shipped green and broke the update on every installed copy.
 *
 * No fixture and no committed key: every case generates its own Ed25519
 * keypair and hand-builds the minisign file, so the tests describe the FORMAT
 * rather than one release's bytes.
 */

const TRUSTED = "timestamp:1757462400\tfile:Tandem_0.25.0_x64-setup.exe";

type Keypair = { publicKey: KeyObject; privateKey: KeyObject; raw: Buffer; keyId: Buffer };

function keypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // SPKI DER for Ed25519 is a 12-byte prefix + the 32-byte key.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  // A minisign key id is 8 random bytes chosen at keygen — it is NOT derived
  // from the key, which is why the wrong-keypair case below asserts failure
  // rather than a particular reason.
  return { publicKey, privateKey, raw: Buffer.from(raw), keyId: randomBytes(8) };
}

/** base64 of a minisign `.pub` file body. */
function pubFile(kp: Keypair): string {
  const payload = Buffer.concat([Buffer.from("Ed", "latin1"), kp.keyId, kp.raw]);
  return Buffer.from(
    `untrusted comment: minisign public key\n${payload.toString("base64")}\n`,
    "utf8",
  ).toString("base64");
}

/** base64 of a minisign `.sig` file body, as `latest.json` carries it. */
function sigFile(
  kp: Keypair,
  data: Buffer,
  opts: { algorithm?: string; trustedComment?: string; writtenComment?: string } = {},
): string {
  const algorithm = opts.algorithm ?? "ED";
  const signedComment = opts.trustedComment ?? TRUSTED;
  // `writtenComment` differing from `signedComment` is the tampered-comment
  // case: the artifact signature still verifies, only the global one does not.
  const writtenComment = opts.writtenComment ?? signedComment;

  const digest = createHash("blake2b512").update(data).digest();
  const signature = sign(null, digest, kp.privateKey);
  const payload = Buffer.concat([Buffer.from(algorithm, "latin1"), kp.keyId, signature]);
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(signedComment, "utf8")]),
    kp.privateKey,
  );

  const text =
    "untrusted comment: minisign signature\n" +
    `${payload.toString("base64")}\n` +
    `trusted comment: ${writtenComment}\n` +
    `${globalSignature.toString("base64")}\n`;
  return Buffer.from(text, "utf8").toString("base64");
}

describe("verifyMinisign", () => {
  const kp = keypair();
  const data = Buffer.from("the installer bytes");
  const publicKey = pubFile(kp);

  it("accepts a signature it was given the matching key for", () => {
    expect(verifyMinisign({ publicKey, signature: sigFile(kp, data), data })).toEqual({
      ok: true,
    });
  });

  it("rejects one flipped byte in the signed data", () => {
    const tampered = Buffer.from(data);
    tampered[0] ^= 0x01;
    expect(verifyMinisign({ publicKey, signature: sigFile(kp, data), data: tampered })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects a signature made with a different keypair", () => {
    const other = keypair();
    // Assert the failure, not which reason: a minisign key id is random at
    // keygen, so pinning "key-id" here would assert the fixture rather than
    // the code.
    expect(verifyMinisign({ publicKey, signature: sigFile(other, data), data }).ok).toBe(false);
  });

  it("rejects a non-prehashed `Ed` algorithm explicitly", () => {
    // Not by falling through to a `false` that reads like tampering, and not
    // by hashing differently and accepting it.
    expect(
      verifyMinisign({ publicKey, signature: sigFile(kp, data, { algorithm: "Ed" }), data }),
    ).toEqual({ ok: false, reason: "algorithm" });
  });

  it("rejects a tampered trusted comment", () => {
    const signature = sigFile(kp, data, { writtenComment: "timestamp:1\tfile:evil.exe" });
    expect(verifyMinisign({ publicKey, signature, data })).toEqual({
      ok: false,
      reason: "global-signature",
    });
  });

  it("answers `malformed` rather than throwing on unparseable input", () => {
    const truncated = Buffer.from(
      Buffer.from(sigFile(kp, data), "base64").toString("utf8").slice(0, 40),
      "utf8",
    ).toString("base64");
    expect(verifyMinisign({ publicKey, signature: truncated, data })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyMinisign({ publicKey, signature: "not base64 at all !!!", data })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyMinisign({ publicKey, signature: "", data })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("verifyManifest", () => {
  const kp = keypair();
  const publicKey = pubFile(kp);

  /**
   * The real v0.25.0 pairing shape: 11 platform keys over 7 distinct asset
   * URLs. `darwin-*`/`-app`, `linux-x86_64`/`-appimage` and
   * `windows-x86_64`/`-nsis` each share a url while carrying their own
   * signature — which is why deduping the VERIFICATION rather than the
   * DOWNLOAD leaves 4 of the 11 signature strings never read.
   */
  function manifest(badKey?: string) {
    const artifacts = new Map<string, Buffer>();
    const url = (n: string) => `https://api.github.com/assets/${n}`;
    const pairs: [string, string][] = [
      ["darwin-aarch64", "dmg-arm"],
      ["darwin-aarch64-app", "dmg-arm"],
      ["darwin-x86_64", "dmg-intel"],
      ["darwin-x86_64-app", "dmg-intel"],
      ["linux-x86_64", "appimage"],
      ["linux-x86_64-appimage", "appimage"],
      ["linux-x86_64-deb", "deb"],
      ["linux-x86_64-rpm", "rpm"],
      ["windows-x86_64", "nsis"],
      ["windows-x86_64-nsis", "nsis"],
      ["windows-x86_64-msi", "msi"],
    ];
    const platforms: Record<string, { url: string; signature: string }> = {};
    for (const [key, asset] of pairs) {
      if (!artifacts.has(asset)) artifacts.set(asset, Buffer.from(`bytes of ${asset}`));
      const data = artifacts.get(asset) as Buffer;
      const signer = key === badKey ? keypair() : kp;
      platforms[key] = { url: url(asset), signature: sigFile(signer, data) };
    }
    const fetchBytes = vi.fn(async (u: string) => {
      const asset = u.split("/").pop() as string;
      const bytes = artifacts.get(asset);
      if (!bytes) throw new Error(`no such asset ${u}`);
      return bytes;
    });
    return { platforms, fetchBytes };
  }

  it("verifies all 11 entries from 7 downloads and names the bad key", async () => {
    // `windows-x86_64-nsis` shares its url with `windows-x86_64`, which is
    // good: an implementation that dedupes verification by url reports 7
    // results and never reads this signature.
    const { platforms, fetchBytes } = manifest("windows-x86_64-nsis");
    const result = await verifyManifest({ publicKey, platforms, fetchBytes });

    expect(result.results).toHaveLength(11);
    expect(fetchBytes).toHaveBeenCalledTimes(7);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.key)).toEqual(["windows-x86_64-nsis"]);
    expect(result.results.filter((r) => r.ok)).toHaveLength(10);
  });

  it("passes a manifest whose every signature verifies", async () => {
    const { platforms, fetchBytes } = manifest();
    const result = await verifyManifest({ publicKey, platforms, fetchBytes });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(11);
    expect(fetchBytes).toHaveBeenCalledTimes(7);
  });

  // The three cannot-evaluate cases. Each must THROW: a gate that resolves
  // `{ ok: true }` having verified nothing is the #1229 shape ci.yml names.
  it("throws on an entry with no signature", async () => {
    const { platforms, fetchBytes } = manifest();
    delete (platforms["linux-x86_64-deb"] as { signature?: string }).signature;
    await expect(verifyManifest({ publicKey, platforms, fetchBytes })).rejects.toThrow(
      /linux-x86_64-deb/,
    );
  });

  it("throws when a download rejects", async () => {
    const { platforms } = manifest();
    const fetchBytes = vi.fn(async () => {
      throw new Error("404 Not Found");
    });
    await expect(verifyManifest({ publicKey, platforms, fetchBytes })).rejects.toThrow(/404/);
  });

  it("throws on an empty or absent platforms object", async () => {
    // The one that kills the default implementation: a plain
    // `Object.entries(platforms)` walk returning
    // `{ ok: failures.length === 0 }` resolves `{ ok: true, results: [] }`
    // here — success having verified nothing.
    const fetchBytes = vi.fn(async () => Buffer.alloc(0));
    await expect(verifyManifest({ publicKey, platforms: {}, fetchBytes })).rejects.toThrow(
      /platforms/,
    );
    await expect(
      verifyManifest({
        publicKey,
        platforms: undefined as unknown as Record<string, never>,
        fetchBytes,
      }),
    ).rejects.toThrow(/platforms/);
    expect(fetchBytes).not.toHaveBeenCalled();
  });
});

/**
 * Review round 1. The entrypoint guard called `realpathSync(process.argv[1])`
 * with no `try`, and `realpathSync` throws `ENOENT` on a path that does not
 * exist. `process.argv[1]` is not guaranteed to be one — under `node -e` it is
 * whatever positional word follows the eval string — so importing this module
 * for its two pure exports died at EVALUATION time, before either export was
 * reachable. A guard that decides "am I the entrypoint?" must never be able to
 * abort the import it is guarding.
 *
 * A child process, not an in-process import: vitest already holds this module
 * in its ESM cache with a real `argv[1]`, so the failure is unreachable from
 * inside the suite.
 */
describe("the entrypoint guard survives an argv[1] that is not a path", () => {
  const modUrl = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../scripts/ci/verify-updater-signatures.mjs",
    ),
  ).href;

  function importUnder(argv1: string) {
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import(process.env.MOD); console.log(typeof m.verifyMinisign, typeof m.verifyManifest);",
        argv1,
      ],
      { encoding: "utf8", env: { ...process.env, MOD: modUrl } },
    );
  }

  it("imports cleanly when argv[1] does not exist", () => {
    const res = importUnder("SOMEARG_NOT_A_PATH");
    // Assert on stderr too: an ENOENT here names `lstat` and the bogus word,
    // which is a far clearer failure message than a bare non-zero status.
    expect(res.stderr).not.toMatch(/ENOENT/);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("function function");
  });

  it("does not run main() when argv[1] is empty or absent", () => {
    // Regression pin for the `!== null` half rather than a second reproduction
    // of the crash: two UNRESOLVABLE paths must not compare equal and drag
    // `main()` — which reaches for GITHUB_TOKEN and the network — into a
    // process that only wanted the exports. (Windows drops a "" argument
    // entirely, so this arrives as either an empty string or no argv[1] at
    // all; both take the same branch.)
    const res = importUnder("");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("function function");
  });
});
