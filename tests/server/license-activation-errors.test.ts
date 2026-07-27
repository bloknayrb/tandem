/**
 * Activation failure taxonomy, paste normalization, and the
 * licensed-but-unverifiable state.
 *
 * Before these changes every one of the cases below produced the SAME sentence:
 * "License could not be verified. Check that you pasted the full license." —
 * including a filesystem write failure, which told a buyer holding a valid key
 * that their key was bad.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { LicenseActivationError } from "../../src/server/license/activation.js";
import {
  _resetLicenseWarningsForTests,
  activateLicense,
  resolveLicenseState,
} from "../../src/server/license/license-state.js";
import type {
  LicenseMetadata,
  SignatureVerified,
  SignedLicense,
} from "../../src/server/license/license-types.js";
import { normalizePastedLicense } from "../../src/server/license/paste.js";
import { licenseFilePath } from "../../src/server/license/paths.js";
import {
  canonicalize,
  LicenseVerifyError,
  verifyLicenseSignature,
} from "../../src/server/license/verifier.js";
import { activationErrorMessage } from "../../src/shared/license-copy.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lic-err-"));
}

function tempKeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function meta(over: Partial<LicenseMetadata> = {}): LicenseMetadata {
  return {
    id: crypto.randomUUID(),
    name: "Jane Doe",
    email: "jane@example.com",
    type: "personal",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    version: "1.0",
    ...over,
  };
}

function signBlob(privateKey: string, m: LicenseMetadata): string {
  const signature = crypto.sign(null, Buffer.from(canonicalize(m)), privateKey);
  const signed: SignedLicense = { metadata: m, signature: signature.toString("hex") };
  return Buffer.from(JSON.stringify(signed)).toString("base64");
}

/**
 * A verifier bound to a throwaway keypair, matching the production seam.
 *
 * Throws `LicenseVerifyError` with a real code, exactly as
 * `verifyLicenseSignature` does — a plain `Error` here would make every injected
 * failure classify as `UNKNOWN` and the code-carrying paths would go untested.
 */
function verifierFor(publicKey: string) {
  return (blob: string): SignatureVerified => {
    let decoded: SignedLicense;
    try {
      decoded = JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as SignedLicense;
    } catch (err) {
      throw new LicenseVerifyError("MALFORMED", "test verifier: unparsable", { cause: err });
    }
    const ok = crypto.verify(
      null,
      Buffer.from(canonicalize(decoded.metadata)),
      publicKey,
      Buffer.from(decoded.signature, "hex"),
    );
    if (!ok) throw new LicenseVerifyError("BAD_SIGNATURE", "test verifier: bad signature");
    return decoded.metadata as SignatureVerified;
  };
}

describe("normalizePastedLicense", () => {
  const { publicKey, privateKey } = tempKeyPair();
  const blob = signBlob(privateKey, meta());
  const verify = verifierFor(publicKey);

  it("repairs a quoted-printable soft break — the one real email corruption", () => {
    // An MTA that re-encodes the body inserts `=` before a wrapped line break.
    // base64 reads that interior `=` as padding and silently TRUNCATES, so the
    // buyer gets a rejection for a key that left the Worker intact.
    const mangled = `${blob.slice(0, 76)}=\r\n${blob.slice(76)}`;
    expect(() => verify(mangled)).toThrow();
    expect(normalizePastedLicense(mangled)).toBe(blob);
    expect(verify(normalizePastedLicense(mangled))).toBeTruthy();
  });

  it("leaves an unmangled blob byte-identical", () => {
    expect(normalizePastedLicense(blob)).toBe(blob);
    expect(normalizePastedLicense(`  \n${blob}\n  `)).toBe(blob);
  });

  it("converges — one pass can CREATE a soft break out of non-matching neighbours", () => {
    // `activateLicense` persists this output and its comment promises the bytes
    // contain no soft break. A single left-to-right pass does not deliver that:
    // the `=\r` and the `\n\n` here are not a match individually, but removing
    // the inner `=\r\n` splices them into one.
    expect("X=\r=\r\n\nY".replace(/=\r?\n/g, "")).toBe("X=\r\nY"); // still broken
    expect(normalizePastedLicense("X=\r=\r\n\nY")).toBe("XY"); // converged
    expect(normalizePastedLicense("X=\r=\r\n\nY")).not.toMatch(/=\r?\n/);
  });

  it("is idempotent, so a persisted blob is not re-repaired on every read", () => {
    const once = normalizePastedLicense("A=\r=\r\n\n=\r\nB");
    expect(normalizePastedLicense(once)).toBe(once);
  });

  describe("regressions — inputs that already worked and must NOT be 'repaired'", () => {
    // Each of these was a candidate "hardening" that would have REJECTED blobs
    // which activate fine today. base64 is far more tolerant than it looks.
    it("a typical blob has no `+` or `/`, but a buyer's own name can produce one", () => {
      // Careful here — an earlier version of this test asserted that a real
      // blob can NEVER contain `+` or `/`, and that is false. The sextet
      // arithmetic is right (they're only reachable from source bytes
      // `>`/`?`/`~`/DEL at one position), but the premise that those bytes
      // can't appear in the JSON is wrong: `cleanName` doesn't strip them and
      // the email shape check permits them in the local part.
      for (let i = 0; i < 20; i++) {
        expect(signBlob(tempKeyPair().privateKey, meta({ name: `Jane ${i}` }))).toMatch(
          /^[A-Za-z0-9=]+$/,
        );
      }
      // ...but a perfectly ordinary name defeats that "never".
      expect(signBlob(tempKeyPair().privateKey, meta({ name: "Who?" }))).toMatch(/[+/]/);
    });

    it("base64url mangling is harmless — the decoder treats the alphabets as equal", () => {
      // This is the assertion that actually matters, and it holds regardless of
      // whether a given blob contains `+`/`/`. Exercised on a real signed blob
      // whose name forces both characters to appear, so the substitution below
      // is not a no-op.
      const kp = tempKeyPair();
      const withSymbols = signBlob(kp.privateKey, meta({ name: "Who? ~" }));
      expect(withSymbols).toMatch(/[+/]/);

      const urlSafe = withSymbols.replace(/\+/g, "-").replace(/\//g, "_");
      expect(urlSafe).not.toBe(withSymbols);
      expect(Buffer.from(urlSafe, "base64").equals(Buffer.from(withSymbols, "base64"))).toBe(true);
      // And it still verifies end to end, which is the property buyers care about.
      expect(verifierFor(kp.publicKey)(normalizePastedLicense(urlSafe))).toBeTruthy();
    });

    it("accepts a hard-wrapped blob (whitespace is ignored on decode)", () => {
      const wrapped = (blob.match(/.{1,76}/g) ?? []).join("\n");
      expect(verify(normalizePastedLicense(wrapped))).toBeTruthy();
    });

    it("accepts CRLF wrapping without a quoted-printable marker", () => {
      const wrapped = (blob.match(/.{1,76}/g) ?? []).join("\r\n");
      expect(verify(normalizePastedLicense(wrapped))).toBeTruthy();
    });
  });
});

describe("verifyLicenseSignature error codes", () => {
  it("TOO_LONG when the whole email was pasted", () => {
    expect(() => verifyLicenseSignature("x".repeat(10_001))).toThrow(
      expect.objectContaining({ code: "TOO_LONG" }),
    );
  });

  it("MALFORMED for something that isn't a license at all", () => {
    expect(() => verifyLicenseSignature("hello there")).toThrow(
      expect.objectContaining({ code: "MALFORMED" }),
    );
  });

  it("BAD_SIGNATURE for a well-formed blob signed by a different key", () => {
    const { privateKey } = tempKeyPair();
    expect(() => verifyLicenseSignature(signBlob(privateKey, meta()))).toThrow(
      expect.objectContaining({ code: "BAD_SIGNATURE" }),
    );
  });
});

describe("activateLicense error taxonomy", () => {
  const { publicKey, privateKey } = tempKeyPair();
  const verify = verifierFor(publicKey);

  it("UNSUPPORTED_VERSION points at updating Tandem, not at the key", async () => {
    const dir = tmp();
    const blob = signBlob(privateKey, meta({ version: "9.0" }));
    await expect(activateLicense(dir, blob, verify)).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
    });
    expect(activationErrorMessage("UNSUPPORTED_VERSION")).toMatch(/newer version of Tandem/);
  });

  it("WRITE_FAILED — a filesystem fault is never reported as a bad license", async () => {
    const dir = tmp();
    const blob = signBlob(privateKey, meta());
    // The blob is already proven good at the point the write happens, so this
    // must not surface as "check that you pasted the full license".
    // `atomicWriteConfigFile` opens the temp file with `wx, 0o600` rather than
    // calling `writeFile`, so the mock has to sit on `open`.
    const spy = vi
      .spyOn(fs.promises, "open")
      .mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    try {
      await expect(activateLicense(dir, blob, verify)).rejects.toMatchObject({
        code: "WRITE_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
    expect(activationErrorMessage("WRITE_FAILED")).toMatch(/valid, but Tandem couldn't save/);
  });

  it("TOO_LONG is rejected BEFORE the normalizer allocates", async () => {
    // The route's Content-Length pre-check is sidesteppable with chunked
    // transfer encoding, and the shared body parser admits 70 MB — so this
    // bound, not that one, is what stops a paste from becoming memory pressure.
    const dir = tmp();
    await expect(activateLicense(dir, "x".repeat(20_001), verify)).rejects.toMatchObject({
      code: "TOO_LONG",
    });
    // Nothing was written.
    expect(fs.existsSync(licenseFilePath(dir))).toBe(false);
  });

  it("creates the app-data directory if it does not exist yet", async () => {
    // `tandem activate ./jane.license` is frequently the FIRST thing a buyer
    // runs — before Tandem has ever launched and created this directory.
    const dir = path.join(tmp(), "never", "created");
    expect(fs.existsSync(dir)).toBe(false);
    const blob = signBlob(privateKey, meta());
    await activateLicense(dir, blob, verify);
    expect(fs.existsSync(licenseFilePath(dir))).toBe(true);
  });

  it("every code maps to distinct, actionable copy", () => {
    const codes = [
      "TOO_LONG",
      "MALFORMED",
      "BAD_SIGNATURE",
      "UNSUPPORTED_VERSION",
      "WRITE_FAILED",
      "UNKNOWN",
    ] as const;
    const messages = codes.map((c) => activationErrorMessage(c));
    expect(new Set(messages).size).toBe(codes.length);
    // The old catch-all must not survive anywhere in the taxonomy.
    for (const m of messages) expect(m).not.toBe("License could not be verified.");
  });

  it("LicenseActivationError carries its code", () => {
    const err = new LicenseActivationError("MALFORMED", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("MALFORMED");
  });
});

describe("licensed-but-unverifiable state", () => {
  const { privateKey } = tempKeyPair();
  const otherKey = tempKeyPair();

  function seedLicense(dir: string, blob: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
  }

  it("flags a license file that does not verify, instead of silently claiming a trial", () => {
    const dir = tmp();
    // Signed by a key this build doesn't trust — e.g. issued before a rotation.
    seedLicense(dir, signBlob(otherKey.privateKey, meta()));
    const state = resolveLicenseState({
      appDataDir: dir,
      now: () => Date.now(),
      gateEnabled: true,
      verify: verifierFor(tempKeyPair().publicKey),
    });
    expect(state.gateActive).toBe(true);
    // Enforcement is deliberately UNCHANGED — an unverified license must not
    // unlock, so we still fall through to the trial clock.
    expect(state.gateActive && state.status).toBe("trial");
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(
      "BAD_SIGNATURE",
    );
  });

  it("flags it on the restricted arm too (trial already expired)", () => {
    const dir = tmp();
    seedLicense(dir, signBlob(otherKey.privateKey, meta()));
    fs.writeFileSync(
      path.join(dir, "trial.json"),
      JSON.stringify({
        version: 1,
        firstRunAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      }),
    );
    const state = resolveLicenseState({
      appDataDir: dir,
      now: () => Date.now(),
      gateEnabled: true,
      verify: verifierFor(tempKeyPair().publicKey),
    });
    expect(state.gateActive && state.status).toBe("restricted");
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(
      "BAD_SIGNATURE",
    );
  });

  it("also flags an unknown schema version", () => {
    const dir = tmp();
    const { publicKey, privateKey: pk } = tempKeyPair();
    seedLicense(dir, signBlob(pk, meta({ version: "9.0" })));
    const state = resolveLicenseState({
      appDataDir: dir,
      now: () => Date.now(),
      gateEnabled: true,
      verify: verifierFor(publicKey),
    });
    // Distinct from BAD_SIGNATURE — the signature is fine, the schema isn't.
    // That distinction is the whole reason the code is carried rather than a
    // boolean: this user needs "update Tandem", not "have it reissued".
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(
      "UNSUPPORTED_VERSION",
    );
  });

  it("is absent when there is no license file at all — an ordinary trial", () => {
    const dir = tmp();
    const state = resolveLicenseState({
      appDataDir: dir,
      now: () => Date.now(),
      gateEnabled: true,
      verify: verifierFor(tempKeyPair().publicKey),
    });
    expect(state.gateActive && state.status).toBe("trial");
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(
      undefined,
    );
  });

  it("is absent on a genuinely licensed device", () => {
    const dir = tmp();
    const { publicKey } = (() => {
      const kp = tempKeyPair();
      seedLicense(dir, signBlob(kp.privateKey, meta()));
      return kp;
    })();
    const state = resolveLicenseState({
      appDataDir: dir,
      now: () => Date.now(),
      gateEnabled: true,
      verify: verifierFor(publicKey),
    });
    expect(state.gateActive && state.status).toBe("licensed");
  });

  it("logs the condition ONCE, not on every dispatch", () => {
    // `resolveLicenseState` runs per gated MCP call, per Hocuspocus
    // authenticate, and per 60s client poll. An unthrottled warning here would
    // emit continuously for as long as the bad file exists, burying the rest of
    // the log a support request would ask for. The UI is what surfaces this to
    // the user on every read; the log only needs to say it once.
    _resetLicenseWarningsForTests();
    const dir = tmp();
    seedLicense(dir, signBlob(otherKey.privateKey, meta()));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const verify = verifierFor(tempKeyPair().publicKey);
      for (let i = 0; i < 25; i++) {
        resolveLicenseState({ appDataDir: dir, now: () => Date.now(), gateEnabled: true, verify });
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("stays inert when the gate is dark", () => {
    const dir = tmp();
    seedLicense(dir, signBlob(privateKey, meta()));
    const state = resolveLicenseState({
      appDataDir: dir,
      now: () => Date.now(),
      gateEnabled: false,
    });
    expect(state).toEqual({ gateActive: false });
  });
});
