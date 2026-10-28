/**
 * The licence grace period (#2231, ADR-040 amendment 2026-10-28).
 *
 * Two halves: the grace record module (`grace.ts`) on its own, and the grace
 * arm of `resolveLicenseState` over real files. Everything here passes
 * `gateEnabled: true` and an injected signature verifier; the build's gate
 * flag is irrelevant, and the dark build's "never touches the grace file" is
 * pinned in `license-ai-refusal.test.ts`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGraceMemoForTests,
  clearGraceRecords,
  GRACE_KEY_READ_ERROR,
  GRACE_MAX_ENTRIES,
  graceKeyForBlob,
  graceKeyForRaw,
  readGraceStart,
  recordGraceStart,
} from "../../src/server/license/grace.js";
import {
  _resetLicenseWarningsForTests,
  resolveLicenseState,
} from "../../src/server/license/license-state.js";
import type {
  LicenseMetadata,
  LicenseState,
  SignatureVerified,
  SignedLicense,
} from "../../src/server/license/license-types.js";
import {
  GRACE_MS,
  LICENSE_GRACE_DAYS,
  licenseFilePath,
  licenseGraceFilePath,
  trialFilePath,
} from "../../src/server/license/paths.js";
import { canonicalize } from "../../src/server/license/verifier.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lic-grace-"));
  dirs.push(d);
  return d;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  _resetGraceMemoForTests();
  _resetLicenseWarningsForTests();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  for (const d of dirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      // gone already
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── signing helpers (a temp keypair; mirrors license-state.test.ts) ──────────

const keys = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function meta(over: Partial<LicenseMetadata> = {}): LicenseMetadata {
  return {
    id: crypto.randomUUID(),
    email: "buyer@example.com",
    type: "personal",
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    version: "1.0",
    keyId: "0123456789abcdef",
    ...over,
  };
}

function signBlob(m: LicenseMetadata): string {
  const signature = crypto.sign(null, Buffer.from(canonicalize(m)), keys.privateKey);
  const signed: SignedLicense = { metadata: m, signature: signature.toString("hex") };
  return Buffer.from(JSON.stringify(signed)).toString("base64");
}

/** Signature-only verifier against the test key; throws a plain Error on a bad one. */
function verify(blob: string): SignatureVerified {
  const parsed = JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as SignedLicense;
  const ok = crypto.verify(
    null,
    Buffer.from(canonicalize(parsed.metadata)),
    keys.publicKey,
    Buffer.from(parsed.signature, "hex"),
  );
  if (!ok) throw new Error("Signature verification failed");
  return parsed.metadata as SignatureVerified;
}

/** A blob signed by a DIFFERENT key: well-formed, fails `verify`. */
function foreignBlob(): string {
  const other = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const m = meta();
  const signature = crypto.sign(null, Buffer.from(canonicalize(m)), other.privateKey);
  return Buffer.from(
    JSON.stringify({ metadata: m, signature: signature.toString("hex") }),
  ).toString("base64");
}

function writeLicense(dir: string, blob: string): void {
  fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
}

function writeTrial(dir: string, firstRunAtMs: number): void {
  fs.writeFileSync(
    trialFilePath(dir),
    JSON.stringify({ version: 1, firstRunAt: new Date(firstRunAtMs).toISOString() }),
  );
}

function writeGraceEntries(dir: string, entries: Record<string, string>): void {
  fs.writeFileSync(licenseGraceFilePath(dir), JSON.stringify({ version: 1, entries }));
}

function readGraceFile(dir: string): { version: number; entries: Record<string, string> } {
  return JSON.parse(fs.readFileSync(licenseGraceFilePath(dir), "utf-8"));
}

function resolve(
  dir: string,
  nowMs: number,
  grace: "off" | "read" | "record" = "record",
): Extract<LicenseState, { gateActive: true }> {
  const s = resolveLicenseState({
    appDataDir: dir,
    now: () => nowMs,
    gateEnabled: true,
    verify,
    grace,
  });
  if (!s.gateActive) throw new Error("expected an active gate");
  return s;
}

// ── grace.ts ────────────────────────────────────────────────────────────────

describe("grace record keys", () => {
  it("hashes a parsed blob, stably, and distinct blobs apart", () => {
    expect(graceKeyForBlob("abc")).toBe(graceKeyForBlob("abc"));
    expect(graceKeyForBlob("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(graceKeyForBlob("abc")).not.toBe(graceKeyForBlob("abd"));
  });

  it("hashes unparseable bytes with their length, so a shared long prefix still keys apart", () => {
    const prefix = "x".repeat(70 * 1024);
    expect(graceKeyForRaw(prefix)).not.toBe(graceKeyForRaw(`${prefix}y`));
    expect(graceKeyForRaw("{")).toBe(graceKeyForRaw("{"));
  });

  it("a non-ENOENT read error records under one constant key", () => {
    expect(GRACE_KEY_READ_ERROR).toBe("read-error");
  });
});

describe("grace record storage", () => {
  it("absent ⇒ null; record ⇒ read back; clear ⇒ gone", () => {
    const dir = tmp();
    expect(readGraceStart(dir, "k", T0)).toBeNull();
    recordGraceStart(dir, "k", T0, T0);
    _resetGraceMemoForTests(); // prove it is on disk, not only in memory
    expect(readGraceStart(dir, "k", T0 + DAY)).toBe(T0);
    expect(clearGraceRecords(dir)).toBe(true);
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(false);
    expect(readGraceStart(dir, "k", T0)).toBeNull();
    // Clearing nothing is still success.
    expect(clearGraceRecords(dir)).toBe(true);
  });

  it("never overwrites a usable first-failure date", () => {
    const dir = tmp();
    recordGraceStart(dir, "k", T0, T0);
    _resetGraceMemoForTests();
    recordGraceStart(dir, "k", T0 + 5 * DAY, T0 + 5 * DAY);
    expect(readGraceFile(dir).entries.k).toBe(new Date(T0).toISOString());
  });

  it.each([
    ["more than a day in the future", new Date(T0 + 2 * DAY).toISOString()],
    ["before 2020 (a dead RTC)", "2016-01-01T00:00:00.000Z"],
    ["unparseable", "not a date"],
  ])("ignores a stored date that is %s", (_name, value) => {
    const dir = tmp();
    writeGraceEntries(dir, { k: value });
    expect(readGraceStart(dir, "k", T0)).toBeNull();
    // …and repairs it on the next record.
    recordGraceStart(dir, "k", T0, T0);
    expect(readGraceFile(dir).entries.k).toBe(new Date(T0).toISOString());
  });

  it("ignores a non-string value and a body that is not ours", () => {
    const dir = tmp();
    fs.writeFileSync(
      licenseGraceFilePath(dir),
      JSON.stringify({ version: 1, entries: { k: 1_700_000_000_000 } }),
    );
    expect(readGraceStart(dir, "k", T0)).toBeNull();
    fs.writeFileSync(licenseGraceFilePath(dir), "[1,2,3]");
    expect(readGraceStart(dir, "k", T0)).toBeNull();
  });

  it(`keeps at most ${GRACE_MAX_ENTRIES} entries, dropping the oldest and keeping the new one`, () => {
    const dir = tmp();
    const entries: Record<string, string> = {};
    for (let i = 0; i < GRACE_MAX_ENTRIES; i++) {
      entries[`k${i}`] = new Date(T0 - (GRACE_MAX_ENTRIES - i) * DAY).toISOString();
    }
    writeGraceEntries(dir, entries);
    recordGraceStart(dir, "new", T0, T0);
    const kept = Object.keys(readGraceFile(dir).entries);
    expect(kept).toHaveLength(GRACE_MAX_ENTRIES);
    expect(kept).toContain("new");
    expect(kept).not.toContain("k0");
  });

  it.skipIf(process.platform === "win32")("writes the record owner-only (0o600)", () => {
    const dir = tmp();
    recordGraceStart(dir, "k", T0, T0);
    expect(fs.statSync(licenseGraceFilePath(dir)).mode & 0o777).toBe(0o600);
    // No temp file left behind.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never throws when the record cannot be written, and remembers the date in memory", () => {
    const parent = tmp();
    const notADir = path.join(parent, "file");
    fs.writeFileSync(notADir, "");
    expect(() => recordGraceStart(notADir, "k", T0, T0)).not.toThrow();
    // Bounded for the life of the process even though nothing landed.
    expect(readGraceStart(notADir, "k", T0 + DAY)).toBe(T0);
    expect(errSpy).toHaveBeenCalledTimes(1);
    // One failed write: never retried per call.
    recordGraceStart(notADir, "k", T0, T0);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("a directory at the record's path: read is null, record and clear never throw", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(licenseGraceFilePath(dir), "inner"), { recursive: true });
    expect(readGraceStart(dir, "k", T0)).toBeNull();
    expect(() => recordGraceStart(dir, "k", T0, T0)).not.toThrow();
    expect(() => clearGraceRecords(dir)).not.toThrow();
    expect(clearGraceRecords(dir)).toBe(false);
  });
});

// ── resolveLicenseState's grace arm ─────────────────────────────────────────

describe("resolveLicenseState — grace period (#2231)", () => {
  /** A failing licence on an expired trial. */
  function failingExpired(): { dir: string; blob: string } {
    const dir = tmp();
    const blob = foreignBlob();
    writeLicense(dir, blob);
    writeTrial(dir, T0 - 30 * DAY);
    return { dir, blob };
  }

  it(`a failing licence with no record ⇒ grace, ${LICENSE_GRACE_DAYS} days left, and "record" writes it`, () => {
    const { dir, blob } = failingExpired();
    const s = resolve(dir, T0, "record");
    expect(s).toMatchObject({
      status: "grace",
      updateWindowCurrent: false,
      licenseUnverifiable: "UNKNOWN",
      grace: {
        firstFailedAt: new Date(T0).toISOString(),
        endsAt: new Date(T0 + GRACE_MS).toISOString(),
        daysRemaining: LICENSE_GRACE_DAYS,
      },
    });
    expect(readGraceFile(dir).entries).toEqual({
      [graceKeyForBlob(blob)]: new Date(T0).toISOString(),
    });
  });

  it('"read" reports the grace but never writes', () => {
    const { dir } = failingExpired();
    expect(resolve(dir, T0, "read").status).toBe("grace");
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(false);
  });

  it('"off" (the default) is the pre-#2231 answer: restricted + unverifiable, no file', () => {
    const { dir } = failingExpired();
    expect(resolve(dir, T0, "off")).toEqual({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
      licenseUnverifiable: "UNKNOWN",
    });
    const dflt = resolveLicenseState({ appDataDir: dir, now: () => T0, gateEnabled: true, verify });
    expect(dflt).toMatchObject({ status: "restricted" });
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(false);
  });

  it("counts down from the FIRST failure, and restricts once the period has run", () => {
    const { dir } = failingExpired();
    resolve(dir, T0);
    const day13 = resolve(dir, T0 + 13 * DAY);
    expect(day13.status === "grace" && day13.grace.daysRemaining).toBe(1);
    const lastMs = resolve(dir, T0 + GRACE_MS - 1);
    expect(lastMs.status).toBe("grace");
    // Never an unlock past the period: the paying-customer refusal returns.
    expect(resolve(dir, T0 + GRACE_MS)).toEqual({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
      licenseUnverifiable: "UNKNOWN",
    });
  });

  it("an existing record 14 days old ⇒ restricted at once (read mode too)", () => {
    const { dir, blob } = failingExpired();
    writeGraceEntries(dir, { [graceKeyForBlob(blob)]: new Date(T0 - 14 * DAY).toISOString() });
    expect(resolve(dir, T0, "read").status).toBe("restricted");
    expect(resolve(dir, T0, "record").status).toBe("restricted");
  });

  it("grace outranks a running trial — a licence holder is not framed as a trial user", () => {
    const dir = tmp();
    writeLicense(dir, foreignBlob());
    writeTrial(dir, T0 - 2 * DAY);
    expect(resolve(dir, T0).status).toBe("grace");
  });

  it("an ended grace with the trial still running ⇒ trial + licenseUnverifiable", () => {
    const dir = tmp();
    const blob = foreignBlob();
    writeLicense(dir, blob);
    writeTrial(dir, T0 - 2 * DAY);
    writeGraceEntries(dir, { [graceKeyForBlob(blob)]: new Date(T0 - 20 * DAY).toISOString() });
    expect(resolve(dir, T0)).toMatchObject({ status: "trial", licenseUnverifiable: "UNKNOWN" });
  });

  it("deleting license.json and putting the same bytes back keeps the first-failure date", () => {
    const { dir, blob } = failingExpired();
    resolve(dir, T0);
    fs.unlinkSync(licenseFilePath(dir));
    expect(resolve(dir, T0 + 5 * DAY)).toMatchObject({ status: "restricted" });
    _resetGraceMemoForTests(); // a restart: only the file remembers
    writeLicense(dir, blob);
    const back = resolve(dir, T0 + 10 * DAY);
    expect(back.status === "grace" && back.grace.firstFailedAt).toBe(new Date(T0).toISOString());
    expect(back.status === "grace" && back.grace.daysRemaining).toBe(4);
  });

  it("a different failing licence gets its own entry (no stronger than the trial clock)", () => {
    const { dir } = failingExpired();
    resolve(dir, T0);
    writeLicense(dir, foreignBlob());
    const other = resolve(dir, T0 + 20 * DAY);
    expect(other.status).toBe("grace");
    expect(Object.keys(readGraceFile(dir).entries)).toHaveLength(2);
  });

  it("deleting license-grace.json mid-process: this process still remembers, and puts it back", () => {
    const { dir, blob } = failingExpired();
    resolve(dir, T0);
    fs.unlinkSync(licenseGraceFilePath(dir));
    const s = resolve(dir, T0 + 3 * DAY);
    expect(s.status === "grace" && s.grace.firstFailedAt).toBe(new Date(T0).toISOString());
    expect(readGraceFile(dir).entries[graceKeyForBlob(blob)]).toBe(new Date(T0).toISOString());
  });

  it("an unparseable licence file is keyed by its bytes (MALFORMED)", () => {
    const dir = tmp();
    fs.writeFileSync(licenseFilePath(dir), "{ not json");
    writeTrial(dir, T0 - 30 * DAY);
    expect(resolve(dir, T0)).toMatchObject({ status: "grace", licenseUnverifiable: "MALFORMED" });
    expect(Object.keys(readGraceFile(dir).entries)).toEqual([graceKeyForRaw("{ not json")]);
  });

  it("a licence file that cannot be read is keyed by the constant read-error key (UNKNOWN)", () => {
    const dir = tmp();
    // A directory at license.json: EISDIR, not ENOENT.
    fs.mkdirSync(licenseFilePath(dir));
    writeTrial(dir, T0 - 30 * DAY);
    expect(resolve(dir, T0)).toMatchObject({ status: "grace", licenseUnverifiable: "UNKNOWN" });
    expect(Object.keys(readGraceFile(dir).entries)).toEqual([GRACE_KEY_READ_ERROR]);
    // …so a permanently unreadable file still runs out.
    expect(resolve(dir, T0 + GRACE_MS).status).toBe("restricted");
  });

  it("an unwritable record still bounds the grace for the life of the process", () => {
    const { dir } = failingExpired();
    fs.mkdirSync(path.join(licenseGraceFilePath(dir), "inner"), { recursive: true });
    expect(resolve(dir, T0).status).toBe("grace");
    expect(resolve(dir, T0 + GRACE_MS).status).toBe("restricted");
  });

  it("a verifying licence clears the record in record mode (and only there)", () => {
    const dir = tmp();
    writeLicense(dir, signBlob(meta()));
    writeGraceEntries(dir, { stale: new Date(T0 - DAY).toISOString() });
    expect(resolve(dir, T0, "read").status).toBe("licensed");
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(true);
    expect(resolve(dir, T0, "record").status).toBe("licensed");
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(false);
  });

  it("a verifying licence stays licensed when the record cannot be cleared", () => {
    const dir = tmp();
    writeLicense(dir, signBlob(meta()));
    fs.mkdirSync(path.join(licenseGraceFilePath(dir), "inner"), { recursive: true });
    expect(resolve(dir, T0, "record").status).toBe("licensed");
  });

  it("an absent licence is never in grace", () => {
    const dir = tmp();
    writeTrial(dir, T0 - 30 * DAY);
    expect(resolve(dir, T0)).toEqual({
      gateActive: true,
      status: "restricted",
      updateWindowCurrent: false,
    });
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(false);
  });

  it("the dark arm reads and writes nothing", () => {
    const { dir } = failingExpired();
    expect(
      resolveLicenseState({ appDataDir: dir, now: () => T0, gateEnabled: false, grace: "record" }),
    ).toEqual({ gateActive: false });
    expect(fs.existsSync(licenseGraceFilePath(dir))).toBe(false);
  });
});
