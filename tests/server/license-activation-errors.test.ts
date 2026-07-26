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
import { LicenseActivationError } from "../../src/server/license/errors.js";
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
import { activationErrorMessage } from "../../src/server/license/messages.js";
import { normalizePastedLicense } from "../../src/server/license/paste.js";
import { licenseFilePath } from "../../src/server/license/paths.js";
import { canonicalize, verifyLicenseSignature } from "../../src/server/license/verifier.js";

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

/** A verifier bound to a throwaway keypair, matching the production seam. */
function verifierFor(publicKey: string) {
  return (blob: string): SignatureVerified => {
    const decoded = JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as SignedLicense;
    const ok = crypto.verify(
      null,
      Buffer.from(canonicalize(decoded.metadata)),
      publicKey,
      Buffer.from(decoded.signature, "hex"),
    );
    if (!ok) throw new Error("bad signature");
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

  describe("regressions — inputs that already worked and must NOT be 'repaired'", () => {
    // Each of these was a candidate "hardening" that would have REJECTED blobs
    // which activate fine today. base64 is far more tolerant than it looks.
    it("accepts the base64url alphabet as equivalent to +/", () => {
      const urlSafe = blob.replace(/\+/g, "-").replace(/\//g, "_");
      expect(Buffer.from(urlSafe, "base64").equals(Buffer.from(blob, "base64"))).toBe(true);
      expect(verify(normalizePastedLicense(urlSafe))).toBeTruthy();
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
    const spy = vi
      .spyOn(fs.promises, "writeFile")
      .mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    try {
      await expect(activateLicense(dir, blob, verify)).rejects.toMatchObject({
        code: "WRITE_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
    expect(activationErrorMessage("WRITE_FAILED")).toMatch(/valid, but Tandem couldn't save it/);
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
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(true);
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
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(true);
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
    expect(state.gateActive && state.status !== "licensed" && state.licenseUnverifiable).toBe(true);
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
