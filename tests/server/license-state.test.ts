import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { readGateFlag } from "../../src/server/license/gate-flag.js";
import {
  activateLicense,
  ensureTrialStarted,
  resolveLicenseState,
} from "../../src/server/license/license-state.js";
import type { LicenseMetadata, SignedLicense } from "../../src/server/license/license-types.js";
import {
  licenseFilePath,
  TRIAL_DAYS,
  TRIAL_MS,
  trialFilePath,
} from "../../src/server/license/paths.js";
import { canonicalize } from "../../src/server/license/verifier.js";

const DAY = 86_400_000;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lic-"));
}

function tempKeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function signBlob(privateKey: string, meta: LicenseMetadata): string {
  const signature = crypto.sign(null, Buffer.from(canonicalize(meta)), privateKey);
  const signed: SignedLicense = { metadata: meta, signature: signature.toString("hex") };
  return Buffer.from(JSON.stringify(signed)).toString("base64");
}

/** Signature-only verifier against a test public key (mirrors verifyLicenseSignature). */
function makeVerify(publicKey: string) {
  return (blob: string): LicenseMetadata => {
    const parsed = JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as SignedLicense;
    const ok = crypto.verify(
      null,
      Buffer.from(canonicalize(parsed.metadata)),
      publicKey,
      Buffer.from(parsed.signature, "hex"),
    );
    if (!ok) throw new Error("Signature verification failed");
    return parsed.metadata;
  };
}

function meta(over: Partial<LicenseMetadata> = {}): LicenseMetadata {
  return {
    id: crypto.randomUUID(),
    name: "Test User",
    email: "test@example.com",
    type: "personal",
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    version: "1.0",
    ...over,
  };
}

function writeTrial(dir: string, firstRunAtMs: number): void {
  fs.writeFileSync(
    trialFilePath(dir),
    JSON.stringify({ version: 1, firstRunAt: new Date(firstRunAtMs).toISOString() }),
  );
}

describe("license paths + constants", () => {
  it("derives license/trial paths under the appData dir", () => {
    expect(licenseFilePath("/data")).toBe(path.join("/data", "license.json"));
    expect(trialFilePath("/data")).toBe(path.join("/data", "trial.json"));
  });
  it("trial is 14 days in ms", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_MS).toBe(14 * DAY);
  });
});

describe("gate flag", () => {
  it("off by default when define + env unset", () => {
    expect(readGateFlag({ defineValue: undefined, env: {} })).toBe(false);
  });
  it("env TANDEM_LICENSE_GATE=1 enables in dev/test", () => {
    expect(readGateFlag({ defineValue: undefined, env: { TANDEM_LICENSE_GATE: "1" } })).toBe(true);
  });
  it("define wins over env when present", () => {
    expect(readGateFlag({ defineValue: false, env: { TANDEM_LICENSE_GATE: "1" } })).toBe(false);
    expect(readGateFlag({ defineValue: true, env: {} })).toBe(true);
  });
});

describe("resolveLicenseState", () => {
  it("flag off ⇒ licensed/unrestricted", () => {
    const s = resolveLicenseState({ appDataDir: tmp(), now: () => 0, gateEnabled: false });
    expect(s).toMatchObject({ gateActive: false, status: "licensed", updateWindowCurrent: true });
  });

  it("no trial.json yet ⇒ trial at day 0", () => {
    const s = resolveLicenseState({ appDataDir: tmp(), now: () => 0, gateEnabled: true });
    expect(s.status).toBe("trial");
    expect(s.trial?.daysRemaining).toBe(TRIAL_DAYS);
  });

  it("trial active within 14 days", () => {
    const dir = tmp();
    const t0 = 1_700_000_000_000;
    writeTrial(dir, t0);
    const s = resolveLicenseState({ appDataDir: dir, now: () => t0 + 5 * DAY, gateEnabled: true });
    expect(s.status).toBe("trial");
    expect(s.trial?.daysRemaining).toBe(9);
  });

  it("restricted after 14 days with no license", () => {
    const dir = tmp();
    const t0 = 1_700_000_000_000;
    writeTrial(dir, t0);
    const s = resolveLicenseState({ appDataDir: dir, now: () => t0 + 15 * DAY, gateEnabled: true });
    expect(s.status).toBe("restricted");
  });

  it("valid license ⇒ licensed, update window current", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const t0 = 1_700_000_000_000;
    const blob = signBlob(privateKey, meta({ expiresAt: new Date(t0 + 365 * DAY).toISOString() }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = resolveLicenseState({
      appDataDir: dir,
      now: () => t0,
      gateEnabled: true,
      verify: makeVerify(publicKey),
    });
    expect(s.status).toBe("licensed");
    expect(s.updateWindowCurrent).toBe(true);
    expect(s.licenseId).toBeDefined();
  });

  it("grandfathered license never expires the run-right or update window", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const blob = signBlob(privateKey, meta({ type: "grandfathered", expiresAt: null }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = resolveLicenseState({
      appDataDir: dir,
      now: () => 9_999_999_999_999,
      gateEnabled: true,
      verify: makeVerify(publicKey),
    });
    expect(s.status).toBe("licensed");
    expect(s.updateWindowCurrent).toBe(true);
  });

  it("licensed but past update window ⇒ still licensed, updateWindowCurrent false", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const t0 = 1_700_000_000_000;
    const blob = signBlob(privateKey, meta({ expiresAt: new Date(t0 - DAY).toISOString() }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = resolveLicenseState({
      appDataDir: dir,
      now: () => t0,
      gateEnabled: true,
      verify: makeVerify(publicKey),
    });
    expect(s.status).toBe("licensed");
    expect(s.updateWindowCurrent).toBe(false);
  });

  it("tampered signature ⇒ not licensed (falls through to trial)", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const good = signBlob(privateKey, meta());
    const signed = JSON.parse(Buffer.from(good, "base64").toString("utf-8")) as SignedLicense;
    signed.metadata.name = "Tampered";
    const tampered = Buffer.from(JSON.stringify(signed)).toString("base64");
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob: tampered }));
    const s = resolveLicenseState({
      appDataDir: dir,
      now: () => 0,
      gateEnabled: true,
      verify: makeVerify(publicKey),
    });
    expect(s.status).not.toBe("licensed");
  });

  it("unknown license version ⇒ not licensed", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const blob = signBlob(privateKey, meta({ version: "2.0" }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = resolveLicenseState({
      appDataDir: dir,
      now: () => 0,
      gateEnabled: true,
      verify: makeVerify(publicKey),
    });
    expect(s.status).not.toBe("licensed");
  });
});

describe("ensureTrialStarted", () => {
  it("writes trial.json once when gate enabled and does not overwrite", async () => {
    const dir = tmp();
    await ensureTrialStarted(dir, () => 123_000, true);
    const first = fs.readFileSync(trialFilePath(dir), "utf-8");
    await ensureTrialStarted(dir, () => 999_000, true);
    expect(fs.readFileSync(trialFilePath(dir), "utf-8")).toBe(first);
  });

  it("writes nothing when the gate is disabled", async () => {
    const dir = tmp();
    await ensureTrialStarted(dir, () => 123_000, false);
    expect(fs.existsSync(trialFilePath(dir))).toBe(false);
  });
});

describe("activateLicense", () => {
  it("rejects a garbage blob", async () => {
    await expect(activateLicense(tmp(), "not-a-license")).rejects.toThrow();
  });
});
