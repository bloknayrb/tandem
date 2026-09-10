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
import type {
  LicenseMetadata,
  LicenseState,
  SignatureVerified,
  SignedLicense,
} from "../../src/server/license/license-types.js";
import {
  licenseFilePath,
  TRIAL_DAYS,
  TRIAL_MS,
  trialFilePath,
} from "../../src/server/license/paths.js";
import { canonicalize } from "../../src/server/license/verifier.js";

const DAY = 86_400_000;

/**
 * Narrows the `LicenseState` discriminated union to its `gateActive: true`
 * arm. Every call site here passes `gateEnabled: true`, so the runtime value
 * is always narrowed already — this only makes that fact visible to the type
 * checker (see `LicenseState`'s discriminated-union doc comment).
 */
function assertGateActive(s: LicenseState): Extract<LicenseState, { gateActive: true }> {
  if (!s.gateActive) throw new Error("expected gateActive license state");
  return s;
}

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
  return (blob: string): SignatureVerified => {
    const parsed = JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as SignedLicense;
    const ok = crypto.verify(
      null,
      Buffer.from(canonicalize(parsed.metadata)),
      publicKey,
      Buffer.from(parsed.signature, "hex"),
    );
    if (!ok) throw new Error("Signature verification failed");
    return parsed.metadata as SignatureVerified;
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
  it("flag off ⇒ inactive gate (dark arm, no status)", () => {
    const s = resolveLicenseState({ appDataDir: tmp(), now: () => 0, gateEnabled: false });
    // Discriminated union: the dark arm is just `{ gateActive: false }` — the
    // synthetic "licensed" sentinel is gone (the status WIRE keeps emitting it
    // for back-compat; see routes/license.ts toLicenseStatusWire).
    expect(s).toEqual({ gateActive: false });
  });

  it("no trial.json yet ⇒ trial at day 0", () => {
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: tmp(), now: () => 0, gateEnabled: true }),
    );
    expect(s.status).toBe("trial");
    expect(s.status === "trial" && s.trial.daysRemaining).toBe(TRIAL_DAYS);
  });

  it("trial active within 14 days", () => {
    const dir = tmp();
    const t0 = 1_700_000_000_000;
    writeTrial(dir, t0);
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => t0 + 5 * DAY, gateEnabled: true }),
    );
    expect(s.status).toBe("trial");
    expect(s.status === "trial" && s.trial.daysRemaining).toBe(9);
  });

  it("restricted after 14 days with no license", () => {
    const dir = tmp();
    const t0 = 1_700_000_000_000;
    writeTrial(dir, t0);
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => t0 + 15 * DAY, gateEnabled: true }),
    );
    expect(s.status).toBe("restricted");
  });

  it("valid license ⇒ licensed, update window current", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const t0 = 1_700_000_000_000;
    const blob = signBlob(privateKey, meta({ expiresAt: new Date(t0 + 365 * DAY).toISOString() }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => t0,
        gateEnabled: true,
        verify: makeVerify(publicKey),
      }),
    );
    expect(s.status).toBe("licensed");
    expect(s.status === "licensed" && s.updateWindowCurrent).toBe(true);
    expect(s.status === "licensed" && s.licenseId).toBeDefined();
  });

  it("grandfathered license never expires the run-right or update window", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const blob = signBlob(privateKey, meta({ type: "grandfathered", expiresAt: null }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => 9_999_999_999_999,
        gateEnabled: true,
        verify: makeVerify(publicKey),
      }),
    );
    expect(s.status).toBe("licensed");
    expect(s.status === "licensed" && s.updateWindowCurrent).toBe(true);
  });

  it("licensed but past update window ⇒ still licensed, updateWindowCurrent false", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const t0 = 1_700_000_000_000;
    const blob = signBlob(privateKey, meta({ expiresAt: new Date(t0 - DAY).toISOString() }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => t0,
        gateEnabled: true,
        verify: makeVerify(publicKey),
      }),
    );
    expect(s.status).toBe("licensed");
    expect(s.status === "licensed" && s.updateWindowCurrent).toBe(false);
  });

  it("tampered signature ⇒ not licensed (falls through to trial)", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const good = signBlob(privateKey, meta());
    const signed = JSON.parse(Buffer.from(good, "base64").toString("utf-8")) as SignedLicense;
    signed.metadata.name = "Tampered";
    const tampered = Buffer.from(JSON.stringify(signed)).toString("base64");
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob: tampered }));
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => 0,
        gateEnabled: true,
        verify: makeVerify(publicKey),
      }),
    );
    expect(s.status).not.toBe("licensed");
  });

  it("unknown license version ⇒ not licensed", () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const blob = signBlob(privateKey, meta({ version: "2.0" }));
    fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob }));
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => 0,
        gateEnabled: true,
        verify: makeVerify(publicKey),
      }),
    );
    expect(s.status).not.toBe("licensed");
  });
});

// The gate's single most important property: a corrupt/unreadable file must
// fail CLOSED (never grant `licensed`). Asserted by test, not just inspection.
describe("resolveLicenseState — fail-closed on corrupt files", () => {
  it("corrupt license.json ⇒ not licensed (falls through to trial)", () => {
    const dir = tmp();
    fs.writeFileSync(licenseFilePath(dir), "{not valid json");
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => 0, gateEnabled: true }),
    );
    expect(s.status).toBe("trial");
  });

  it("corrupt trial.json ⇒ treated as a fresh day-0 trial (soft by design)", () => {
    const dir = tmp();
    fs.writeFileSync(trialFilePath(dir), "{not valid json");
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => 0, gateEnabled: true }),
    );
    expect(s.status).toBe("trial");
    expect(s.status === "trial" && s.trial.daysRemaining).toBe(TRIAL_DAYS);
  });

  it("non-date firstRunAt ⇒ restricted (NaN window resolves closed, never open)", () => {
    const dir = tmp();
    fs.writeFileSync(trialFilePath(dir), JSON.stringify({ version: 1, firstRunAt: "not-a-date" }));
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => 1_700_000_000_000,
        gateEnabled: true,
      }),
    );
    // new Date("not-a-date").getTime() === NaN ⇒ expiresAt NaN ⇒ nowMs < NaN is
    // false ⇒ restricted. Pin it so a refactor can't silently flip it open.
    expect(s.status).toBe("restricted");
  });
});

/**
 * #1788 decision 5: a `trial.json` that PARSES to a non-null body is
 * authoritative even when its `firstRunAt` cannot run a clock. Before the fix
 * `tf?.firstRunAt ? new Date(tf.firstRunAt).getTime() : nowMs` sent every FALSY
 * value down the ABSENT-FILE branch, so `firstRunAt: ""` was a perpetual 14-day
 * trial on every dispatch — a real fail-open, and the opposite direction to the
 * `"not-a-date"` case above, which already resolved closed.
 *
 * **The clock is the discriminator here, and it is `now: () => 0` on purpose.**
 * `TRIAL_MS` is 14 days (~1.21e9 ms), so a `firstRunAt` that coerces through a
 * string-lenient parse — `Date.parse(0)` → `"0"` → 946684800000 (2000), or a
 * lazy `new Date(null).getTime()` → 0 (1970) — expires long before any realistic
 * `now`, and these assertions would read `restricted` and PASS even with the
 * `typeof v === "string"` half of `trialFirstRunAt` deleted. At epoch 0 that
 * same mutation reads `trial` and goes red.
 *
 * Mutations these four cases exist to catch (hand-checked; restore from a file
 * copy, never `git checkout`):
 *   1. revert to `tf?.firstRunAt ? new Date(tf.firstRunAt).getTime() : nowMs` —
 *      all four go red (plus the whole-body-scalar case below, and the
 *      end-to-end disk case in license-armed-restricted.test.ts).
 *   2. drop the `typeof v === "string"` test in `trialFirstRunAt` — `0` goes red
 *      (`Date.parse(0)` coerces to `"0"` ⇒ a year-2000 clock).
 *   3. drop that guard AND spell the parse `new Date(v).getTime()` — `null` and
 *      `0` both go red (`new Date(null)` is a finite `0`, not `NaN`).
 */
describe("resolveLicenseState — unusable firstRunAt is not a fresh trial (#1788)", () => {
  function writeTrialBody(dir: string, body: unknown): void {
    fs.writeFileSync(trialFilePath(dir), JSON.stringify(body));
  }

  it.each([
    ["empty string", { version: 1, firstRunAt: "" }],
    ["null", { version: 1, firstRunAt: null }],
    ["numeric zero", { version: 1, firstRunAt: 0 }],
    ["key absent", { version: 1 }],
  ])("firstRunAt %s ⇒ restricted, not day 0", (_label, body) => {
    const dir = tmp();
    writeTrialBody(dir, body);
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => 0, gateEnabled: true }),
    );
    expect(s.status).toBe("restricted");
  });

  // The discriminating twin: a usable value still runs the clock. Realistic
  // `now` here (matching the `"not-a-date"` case above), because this one is
  // about the ordinary path, not about coercion.
  it("a valid recent ISO firstRunAt still ⇒ trial", () => {
    const dir = tmp();
    const now = Date.UTC(2026, 0, 1);
    writeTrialBody(dir, { version: 1, firstRunAt: new Date(now - DAY).toISOString() });
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => now, gateEnabled: true }),
    );
    expect(s.status).toBe("trial");
  });

  // The boundary of what `readJson` can actually see. It cannot separate "file
  // absent", "file unreadable", "unparseable JSON" and "the body is literally
  // null" — all four are `null` — so only that collapsed case is day 0. Any
  // other scalar body is a non-null parse and resolves closed. Recorded as two
  // cases so the next reader does not assume the file-existence claim is
  // stronger than it is.
  it("a whole-body scalar trial.json (0) ⇒ restricted", () => {
    const dir = tmp();
    writeTrialBody(dir, 0);
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => 0, gateEnabled: true }),
    );
    expect(s.status).toBe("restricted");
  });

  it("a whole-body null trial.json ⇒ day-0 trial (indistinguishable from absent)", () => {
    const dir = tmp();
    writeTrialBody(dir, null);
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => 0, gateEnabled: true }),
    );
    expect(s.status).toBe("trial");
    expect(s.status === "trial" && s.trial.daysRemaining).toBe(TRIAL_DAYS);
  });
});

// The 14-day boundary is strict `<`. Both edges deterministic with the injected
// clock (the PR deferred this; landing it before the v1.0 flag-flip).
describe("resolveLicenseState — trial boundary", () => {
  const t0 = 1_700_000_000_000;
  it("exactly at expiry ⇒ restricted", () => {
    const dir = tmp();
    writeTrial(dir, t0);
    const s = assertGateActive(
      resolveLicenseState({ appDataDir: dir, now: () => t0 + TRIAL_MS, gateEnabled: true }),
    );
    expect(s.status).toBe("restricted");
  });
  it("one ms before expiry ⇒ trial with 1 day remaining", () => {
    const dir = tmp();
    writeTrial(dir, t0);
    const s = assertGateActive(
      resolveLicenseState({
        appDataDir: dir,
        now: () => t0 + TRIAL_MS - 1,
        gateEnabled: true,
      }),
    );
    expect(s.status).toBe("trial");
    expect(s.status === "trial" && s.trial.daysRemaining).toBe(1);
  });
});

describe("ensureTrialStarted", () => {
  // Both clocks must be REAL epoch values, not the synthetic `123_000` this
  // test used before the clock-sanity bound landed. 123 s after the epoch is
  // 1970, which the bound now (correctly) reads as a dead-RTC timestamp and
  // repairs — so the old fixture would have proved the opposite of its name.
  it("writes trial.json once when gate enabled and does not overwrite", async () => {
    const dir = tmp();
    const t0 = Date.UTC(2026, 0, 1);
    await ensureTrialStarted(dir, () => t0, true);
    const first = fs.readFileSync(trialFilePath(dir), "utf-8");
    await ensureTrialStarted(dir, () => t0 + 60_000, true);
    expect(fs.readFileSync(trialFilePath(dir), "utf-8")).toBe(first);
  });

  /**
   * The clock-sanity bound (#1788 review). `Date.parse` accepts any well-formed
   * date, so before this a VALID BUT WRONG `firstRunAt` was judged usable and
   * never repaired — and it failed in both directions from the one root cause.
   *
   * These two cases are the ones a bare `Number.isFinite` check cannot see.
   * Deleting the bound turns both red; deleting only one edge turns one red.
   */
  it.each([
    [
      "a dead-RTC past timestamp (restricted forever without the bound)",
      new Date(Date.UTC(2016, 0, 1)).toISOString(),
    ],
    [
      "a far-future timestamp (perpetual trial without the bound)",
      new Date(Date.UTC(3000, 0, 1)).toISOString(),
    ],
  ])("repairs %s", async (_label, firstRunAt) => {
    const dir = tmp();
    const now = Date.UTC(2026, 0, 1);
    fs.writeFileSync(trialFilePath(dir), JSON.stringify({ version: 1, firstRunAt }));

    await ensureTrialStarted(dir, () => now, true);

    const body = JSON.parse(fs.readFileSync(trialFilePath(dir), "utf-8"));
    expect(body.firstRunAt).toBe(new Date(now).toISOString());
  });

  it("leaves a firstRunAt inside the bound alone", async () => {
    const dir = tmp();
    const now = Date.UTC(2026, 0, 1);
    const legit = new Date(now - 3 * 86_400_000).toISOString();
    fs.writeFileSync(trialFilePath(dir), JSON.stringify({ version: 1, firstRunAt: legit }));

    await ensureTrialStarted(dir, () => now, true);

    const body = JSON.parse(fs.readFileSync(trialFilePath(dir), "utf-8"));
    expect(body.firstRunAt).toBe(legit);
  });

  it("writes nothing when the gate is disabled", async () => {
    const dir = tmp();
    await ensureTrialStarted(dir, () => 123_000, false);
    expect(fs.existsSync(trialFilePath(dir))).toBe(false);
  });

  /**
   * The recovery route for #1788's closed path. Without it a body that parses
   * but cannot run a clock resolves `restricted` on every boot forever, and
   * `existsSync` guaranteed nothing ever rewrote it — the user is told their
   * trial ended having never had one, with no in-app recovery.
   *
   * Each case asserts the RESOLVED STATE, not just the file bytes: rewriting
   * the file with something still unusable would satisfy a bytes-changed
   * assertion and leave the device exactly as stuck.
   */
  describe("repairs a trial.json that cannot run a clock", () => {
    for (const [name, body] of [
      ['firstRunAt: ""', { version: 1, firstRunAt: "" }],
      ["firstRunAt: 0 (an epoch-ms schema revision)", { version: 1, firstRunAt: 0 }],
      ["firstRunAt absent", { version: 1 }],
      ["a whole-body scalar", 0],
      ["an array body", []],
      ["an unparseable-date string", { version: 1, firstRunAt: "yesterday" }],
    ] as Array<[string, unknown]>) {
      it(name, async () => {
        const dir = tmp();
        fs.writeFileSync(trialFilePath(dir), JSON.stringify(body));
        const now = Date.now();

        // Before: restricted, and no route out.
        expect(
          assertGateActive(
            resolveLicenseState({ appDataDir: dir, now: () => now, gateEnabled: true }),
          ).status,
        ).toBe("restricted");

        await ensureTrialStarted(dir, () => now, true);

        expect(
          assertGateActive(
            resolveLicenseState({ appDataDir: dir, now: () => now, gateEnabled: true }),
          ).status,
        ).toBe("trial");
      });
    }
  });

  it("leaves a running clock alone (a valid firstRunAt is never rewritten)", async () => {
    const dir = tmp();
    const started = new Date(Date.now() - 3 * DAY).toISOString();
    fs.writeFileSync(trialFilePath(dir), JSON.stringify({ version: 1, firstRunAt: started }));
    await ensureTrialStarted(dir, () => Date.now(), true);
    expect(JSON.parse(fs.readFileSync(trialFilePath(dir), "utf-8")).firstRunAt).toBe(started);
  });

  /**
   * The errno discrimination the repair is gated on. A file this process could
   * not PARSE is not evidence that the clock is broken — a truncated write, a
   * Windows AV/indexer lock mid-read — and rewriting on that evidence resets a
   * real, running clock. `readJson` already reads an unparseable body as day 0,
   * so the device is not stuck either way.
   */
  it("leaves an unparseable trial.json alone rather than resetting a real clock", async () => {
    const dir = tmp();
    fs.writeFileSync(trialFilePath(dir), "{ truncated");
    await ensureTrialStarted(dir, () => Date.now(), true);
    expect(fs.readFileSync(trialFilePath(dir), "utf-8")).toBe("{ truncated");
  });
});

describe("activateLicense", () => {
  it("rejects a garbage blob", async () => {
    await expect(activateLicense(tmp(), "not-a-license")).rejects.toThrow();
  });

  it("verifies + persists a valid license ⇒ licensed round-trip", async () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const blob = signBlob(privateKey, meta({ name: "Paid User" }));
    const state = assertGateActive(await activateLicense(dir, blob, makeVerify(publicKey)));
    expect(state.status).toBe("licensed");
    expect(state.status === "licensed" && state.license.name).toBe("Paid User");
    // license.json persisted with the exact blob (so the next resolve re-verifies).
    const saved = JSON.parse(fs.readFileSync(licenseFilePath(dir), "utf-8"));
    expect(saved.blob).toBe(blob);
  });

  it("rejects a license of an unknown schema version", async () => {
    const dir = tmp();
    const { publicKey, privateKey } = tempKeyPair();
    const blob = signBlob(privateKey, meta({ version: "2.0" }));
    await expect(activateLicense(dir, blob, makeVerify(publicKey))).rejects.toThrow();
  });
});
