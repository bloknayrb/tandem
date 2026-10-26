import crypto from "crypto";
import type { Request, Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as licenseState from "../../src/server/license/license-state.js";
import type { LicenseState } from "../../src/server/license/license-types.js";
import * as verifier from "../../src/server/license/verifier.js";
import { canonicalize } from "../../src/server/license/verifier.js";
import {
  handleGetLicenseStatus,
  makeActivateLicenseHandler,
  scrubForNonLoopback,
  toLicenseStatusWire,
} from "../../src/server/mcp/routes/license.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import {
  LICENSE_SAVED_STATE_UNREADABLE,
  LICENSE_SAVED_STATE_UNREADABLE_MESSAGE,
} from "../../src/shared/license-copy.js";
import { allocPort } from "../helpers/alloc-port.js";

const FULL: LicenseState = {
  gateActive: true,
  status: "licensed",
  updateWindowCurrent: true,
  license: {
    id: "lic-123",
    email: "jane@example.com",
    type: "personal",
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    version: "1.0",
    keyId: "0123456789abcdef",
  },
  licenseId: "lic-123",
};

function fakeRes(): Response & { body: unknown; statusCode: number } {
  const r = {
    body: undefined as unknown,
    statusCode: 200,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r as unknown as Response & { body: unknown; statusCode: number };
}

function reqFrom(remoteAddress: string): Request {
  return { socket: { remoteAddress } } as unknown as Request;
}

describe("scrubForNonLoopback", () => {
  it("drops the licensee email and licenseId", () => {
    const scrubbed = scrubForNonLoopback(FULL);
    expect(scrubbed).toEqual({
      gateActive: true,
      status: "licensed",
      daysRemaining: undefined,
      updateWindowCurrent: true,
    });
    expect(scrubbed).not.toHaveProperty("license");
    expect(scrubbed).not.toHaveProperty("licenseId");
  });

  it("carries trial daysRemaining when present", () => {
    const trialState: LicenseState = {
      gateActive: true,
      status: "trial",
      updateWindowCurrent: false,
      trial: { firstRunAt: "x", expiresAt: "y", daysRemaining: 7 },
    };
    expect(scrubForNonLoopback(trialState).daysRemaining).toBe(7);
  });
});

describe("handleGetLicenseStatus", () => {
  it("responds with a status object for a loopback caller", () => {
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("127.0.0.1"), res);
    expect((res.body as { status: string }).status).toBeDefined();
  });

  it("never leaks license/licenseId to a non-loopback caller", () => {
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("203.0.113.5"), res);
    expect(res.body).not.toHaveProperty("license");
    expect(res.body).not.toHaveProperty("licenseId");
    expect((res.body as { status: string }).status).toBeDefined();
  });
});

function activateReq(opts: { origin?: string; body?: unknown }): Request {
  return {
    headers: opts.origin ? { origin: opts.origin } : {},
    socket: { remoteAddress: "127.0.0.1" },
    body: opts.body,
  } as unknown as Request;
}

/** No launcher wired — the shape every pre-#1521 case here was written against. */
const handleActivateLicense = makeActivateLicenseHandler();

describe("handleActivateLicense", () => {
  it("rejects a non-allowlisted origin with 403 before touching the body", async () => {
    const res = fakeRes();
    await handleActivateLicense(
      activateReq({ origin: "https://evil.example", body: { license: "x" } }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("FORBIDDEN");
  });

  it("rejects a missing license body with 400 BAD_REQUEST", async () => {
    const res = fakeRes();
    await handleActivateLicense(activateReq({ origin: "http://127.0.0.1:5173", body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("BAD_REQUEST");
  });

  it("rejects a garbage license with a generic 400 that never echoes the blob", async () => {
    const secret = "SUPER-SECRET-GARBAGE-BLOB-BYTES";
    const res = fakeRes();
    await handleActivateLicense(
      activateReq({ origin: "http://127.0.0.1:5173", body: { license: secret } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("INVALID_LICENSE");
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it("gives a 403 a buyer can act on, not internal integrations vocabulary", async () => {
    // The gates are shared with the integrations module, whose default copy
    // names "integration routes" and TANDEM_ALLOW_UNAUTHENTICATED_LAN. The
    // client renders `json.message` verbatim in the activation form, so the
    // override is the whole point — and asserting only on `error: FORBIDDEN`
    // (as this suite used to) would stay green if it were dropped.
    const res = fakeRes();
    await handleActivateLicense(
      activateReq({ origin: "https://evil.example", body: { license: "x" } }),
      res,
    );
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/computer running Tandem/);
    expect(message).not.toMatch(/integration routes/);
    expect(message).not.toMatch(/TANDEM_ALLOW_UNAUTHENTICATED_LAN/);
  });

  /**
   * Review round 2. The refusal used to end "… or run `tandem activate` on
   * it." unconditionally. On a desktop install that is the wrong-root no-op
   * #1789 removed from the Settings hint two functions away: the CLI writes
   * `license.json` under the npm env-paths root while the sidecar reads the
   * Tauri app-data dir, so it prints "✓ License activated" and nothing changes.
   * `npmCliSharesAppDataRoot()` is the same discriminant `loopbackLicenseWire`
   * already uses, and an overridden root is the fail-closed direction.
   */
  it("drops the CLI clause when the npm CLI would write a root this server never reads", async () => {
    const saved = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = path.join(os.tmpdir(), "tandem-desktop-root-fixture");
    try {
      const res = fakeRes();
      await handleActivateLicense(
        activateReq({ origin: "https://evil.example", body: { license: "x" } }),
        res,
      );
      const message = (res.body as { message: string }).message;
      expect(res.statusCode).toBe(403);
      // The actionable half survives; only the no-op instruction goes.
      expect(message).toMatch(/computer running Tandem/);
      expect(message).toMatch(/paste the key there/);
      expect(message).not.toContain("tandem activate");
    } finally {
      if (saved === undefined) delete process.env.TANDEM_APP_DATA_DIR;
      else process.env.TANDEM_APP_DATA_DIR = saved;
    }
  });

  it("keeps the CLI clause when the npm CLI and this server share a root", async () => {
    const saved = process.env.TANDEM_APP_DATA_DIR;
    delete process.env.TANDEM_APP_DATA_DIR;
    try {
      const res = fakeRes();
      await handleActivateLicense(
        activateReq({ origin: "https://evil.example", body: { license: "x" } }),
        res,
      );
      expect((res.body as { message: string }).message).toContain("tandem activate");
    } finally {
      if (saved === undefined) delete process.env.TANDEM_APP_DATA_DIR;
      else process.env.TANDEM_APP_DATA_DIR = saved;
    }
  });

  it("reports a filesystem failure as 500 LICENSE_WRITE_FAILED, not a bad key", async () => {
    // The distinction the taxonomy exists for: "your input is wrong" (400) vs
    // "our disk is wrong" (500). Previously every cause collapsed into a 400
    // telling the buyer to check their paste.
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const meta = {
      id: crypto.randomUUID(),
      email: "jane@example.com",
      type: "personal" as const,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      version: "1.0",
      keyId: "0123456789abcdef",
    };
    const sig = crypto.sign(null, Buffer.from(canonicalize(meta)), privateKey);
    const blob = Buffer.from(
      JSON.stringify({ metadata: meta, signature: sig.toString("hex") }),
    ).toString("base64");

    // Make the verifier accept it, and the write fail.
    const verifySpy = vi
      .spyOn(verifier, "verifyLicenseSignature")
      .mockImplementation((s: string) => {
        const d = JSON.parse(Buffer.from(s, "base64").toString("utf-8"));
        if (
          !crypto.verify(
            null,
            Buffer.from(canonicalize(d.metadata)),
            publicKey,
            Buffer.from(d.signature, "hex"),
          )
        ) {
          throw new Error("bad");
        }
        return d.metadata;
      });
    const openSpy = vi
      .spyOn(fs.promises, "open")
      .mockRejectedValue(Object.assign(new Error("EROFS"), { code: "EROFS" }));
    try {
      const res = fakeRes();
      await handleActivateLicense(
        activateReq({ origin: "http://127.0.0.1:5173", body: { license: blob } }),
        res,
      );
      expect(res.statusCode).toBe(500);
      expect((res.body as { error: string }).error).toBe("LICENSE_WRITE_FAILED");
      expect((res.body as { message: string }).message).toMatch(/valid, but Tandem couldn't save/);
    } finally {
      openSpy.mockRestore();
      verifySpy.mockRestore();
    }
  });
});

describe("activation that saved the key but cannot re-read the state", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers 500 LICENSE_SAVED_STATE_UNREADABLE, never INVALID_LICENSE", async () => {
    // license.json is already written when the re-read throws (a corrupt
    // trial.json, say). INVALID_LICENSE here made `tandem activate` and the
    // Settings form report a failure for an installed key.
    vi.spyOn(licenseState, "activateLicense").mockResolvedValue(FULL);
    vi.spyOn(licenseState, "resolveLiveLicenseState").mockImplementation(() => {
      throw new Error("trial.json is corrupt");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await handleActivateLicense(
      activateReq({ origin: "http://127.0.0.1:5173", body: { license: "a-good-key" } }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: LICENSE_SAVED_STATE_UNREADABLE,
      message: LICENSE_SAVED_STATE_UNREADABLE_MESSAGE,
    });
    expect(JSON.stringify(res.body)).not.toContain("trial.json is corrupt");
  });
});

describe("activation resumes a launcher the licence refused (#1521)", () => {
  let dir: string;
  let saved: string | undefined;
  let verifySpy: ReturnType<typeof vi.spyOn>;

  /**
   * A response that records WHEN it was answered. `statusCode` starts at a
   * sentinel rather than the 200 Express defaults to, so "no error status was
   * set" is something a case can assert and fail.
   */
  function recordingRes(log: string[]) {
    const r = {
      body: undefined as unknown,
      statusCode: -1,
      status(code: number) {
        r.statusCode = code;
        return r;
      },
      json(b: unknown) {
        log.push("answered");
        r.body = b;
        return r;
      },
    };
    return r as unknown as Response & { body: unknown; statusCode: number };
  }

  beforeEach(() => {
    saved = process.env.TANDEM_APP_DATA_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-activate-resume-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
    // Any blob verifies: these cases are about what happens AFTER a good key.
    verifySpy = vi.spyOn(verifier, "verifyLicenseSignature").mockImplementation(
      () =>
        ({
          id: "lic-1",
          email: "jane@example.com",
          type: "personal",
          createdAt: new Date(0).toISOString(),
          expiresAt: null,
          version: "1.0",
          keyId: "0123456789abcdef",
        }) as ReturnType<typeof verifier.verifyLicenseSignature>,
    );
  });

  afterEach(() => {
    verifySpy.mockRestore();
    if (saved === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const goodReq = () =>
    activateReq({ origin: "http://127.0.0.1:5173", body: { license: "a-good-key" } });

  it("sends nothing until resumeAfterLicence has resolved, then answers the licence wire", async () => {
    const log: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({
        resumeAfterLicence: async () => {
          log.push("resume-started");
          await held;
          log.push("resume-done");
        },
      }),
    });
    const res = recordingRes(log);
    const pending = handler(goodReq(), res);
    await vi.waitFor(() => expect(log).toContain("resume-started"));
    // Still held: the client must not hear "activated" yet.
    expect(log).not.toContain("answered");
    expect(res.body).toBeUndefined();
    release();
    await pending;
    expect(log).toEqual(["resume-started", "resume-done", "answered"]);
    expect(res.statusCode).toBe(-1); // no error status was set
    expect(res.body).toMatchObject({ gateActive: expect.any(Boolean) });
  });

  it("still answers success when resume throws — the key is already saved", async () => {
    const log: string[] = [];
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({
        resumeAfterLicence: async () => {
          throw new Error("integrations.json is corrupt");
        },
      }),
    });
    const res = recordingRes(log);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handler(goodReq(), res);
    expect(log).toEqual(["answered"]);
    expect(res.statusCode).toBe(-1);
    expect(res.body).toMatchObject({ gateActive: expect.any(Boolean) });
  });

  it("answers success with no supervisor wired, or a null one", async () => {
    for (const handler of [
      makeActivateLicenseHandler(),
      makeActivateLicenseHandler({ getSupervisor: () => null }),
    ]) {
      const res = recordingRes([]);
      await handler(goodReq(), res);
      expect(res.statusCode).toBe(-1);
      expect(res.body).toMatchObject({ gateActive: expect.any(Boolean) });
    }
  });

  /**
   * #2205: `tandem activate` hands the key over from Node `fetch`, which sends
   * no Origin. An ABSENT Origin is admitted; a PRESENT one must still be
   * allowlisted, and loopback still holds unconditionally.
   */
  it("admits an absent Origin from a loopback socket (the CLI, #2205)", async () => {
    const resume = vi.fn(async () => {});
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({ resumeAfterLicence: resume }),
    });
    const res = recordingRes([]);
    await handler(activateReq({ body: { license: "a-good-key" } }), res);
    expect(res.statusCode).toBe(-1);
    expect(res.body).toMatchObject({ gateActive: expect.any(Boolean) });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("still admits every allowlisted browser Origin (#2205 did not narrow the client path)", async () => {
    for (const origin of ["http://127.0.0.1:5173", "http://tauri.localhost", "tauri://localhost"]) {
      const resume = vi.fn(async () => {});
      const handler = makeActivateLicenseHandler({
        getSupervisor: () => ({ resumeAfterLicence: resume }),
      });
      const res = recordingRes([]);
      await handler(activateReq({ origin, body: { license: "a-good-key" } }), res);
      expect(res.statusCode, origin).toBe(-1);
      expect(resume, origin).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses Origin: "null" — a present Origin, and a grant if ever allowed (#2205)', async () => {
    const resume = vi.fn(async () => {});
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({ resumeAfterLicence: resume }),
    });
    const res = recordingRes([]);
    await handler(activateReq({ origin: "null", body: { license: "a-good-key" } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "FORBIDDEN", code: "BAD_ORIGIN" });
    expect(resume).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "license.json"))).toBe(false);
  });

  it("refuses an empty Origin — present, not absent (#2205)", async () => {
    const resume = vi.fn(async () => {});
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({ resumeAfterLicence: resume }),
    });
    // Built directly: `activateReq` drops a falsy origin.
    const req = {
      headers: { origin: "" },
      socket: { remoteAddress: "127.0.0.1" },
      body: { license: "a-good-key" },
    } as unknown as Request;
    const res = recordingRes([]);
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(resume).not.toHaveBeenCalled();
  });

  it("still refuses an absent Origin from a non-loopback socket (#2205)", async () => {
    const resume = vi.fn(async () => {});
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({ resumeAfterLicence: resume }),
    });
    const req = {
      headers: {},
      socket: { remoteAddress: "203.0.113.5" },
      body: { license: "a-good-key" },
    } as unknown as Request;
    const res = recordingRes([]);
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "FORBIDDEN" });
    expect(resume).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "license.json"))).toBe(false);
  });

  it("answers an Origin-less request with no parsed body 400, before any write (#2205)", async () => {
    // A simple-request POST (text/plain, form-urlencoded) arrives with
    // `req.body` undefined — the required JSON field is the preflight proof.
    const resume = vi.fn(async () => {});
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({ resumeAfterLicence: resume }),
    });
    const res = recordingRes([]);
    await handler(activateReq({ body: undefined }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: "BAD_REQUEST" });
    expect(resume).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "license.json"))).toBe(false);
  });

  it("never resumes on a refused key", async () => {
    verifySpy.mockImplementation(() => {
      throw new Error("bad");
    });
    const resume = vi.fn(async () => {});
    const handler = makeActivateLicenseHandler({
      getSupervisor: () => ({ resumeAfterLicence: resume }),
    });
    const res = recordingRes([]);
    await handler(goodReq(), res);
    expect(res.statusCode).toBe(400);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("POST /api/license/activate is wired to the launcher (#1521)", () => {
  it("startMcpServerHttp hands its launcher getter to the activate route", async () => {
    const saved = process.env.TANDEM_APP_DATA_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-activate-wired-"));
    process.env.TANDEM_APP_DATA_DIR = dir;
    const verifySpy = vi.spyOn(verifier, "verifyLicenseSignature").mockImplementation(
      () =>
        ({
          id: "lic-1",
          email: "jane@example.com",
          type: "personal",
          createdAt: new Date(0).toISOString(),
          expiresAt: null,
          version: "1.0",
          keyId: "0123456789abcdef",
        }) as ReturnType<typeof verifier.verifyLicenseSignature>,
    );
    const resume = vi.fn(async () => {});
    const sup = {
      start: async () => {},
      stop: async () => {},
      relaunch: async () => ({ spawned: true as const }),
      startFresh: async () => ({ spawned: true as const }),
      refreshConfigured: async () => {},
      startAfterSetup: async () => "unknown" as const,
      resumeAfterLicence: resume,
      licenceRefusal: () => null,
      startByUser: async () => ({ spawned: true as const }),
      updateSettings: async () => ({
        startMode: "auto" as const,
        lifetime: "always" as const,
        idleMinutes: 30,
      }),
      appliedSettings: () => null,
      status: () => ({ running: false as const }),
    };
    const port = await allocPort();
    const server = await startMcpServerHttp(port, "127.0.0.1", undefined, undefined, {
      getSupervisor: () => sup,
      unavailableReason: () => "stdio-mode",
      startSupervisor: async () => {},
    });
    const url = `http://127.0.0.1:${port}/api/license/activate`;
    const licenseFile = path.join(dir, "license.json");
    try {
      // Simple-request shapes first, while nothing is installed: an
      // Origin-less caller that skipped the preflight gets a 400 and no write
      // (#2205 — the parsed JSON body is the proof).
      const plain = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ license: "a-good-key" }),
      });
      expect(plain.status).toBe(400);
      const form = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "license=a-good-key",
      });
      expect(form.status).toBe(400);
      expect(resume).not.toHaveBeenCalled();
      expect(fs.existsSync(licenseFile)).toBe(false);

      // The browser path: allowlisted Origin.
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ license: "a-good-key" }),
      });
      expect(res.status).toBe(200);
      expect(resume).toHaveBeenCalledTimes(1);

      // The CLI path (#2205): no Origin, application/json.
      const cli = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license: "a-good-key" }),
      });
      expect(cli.status).toBe(200);
      expect(resume).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(licenseFile)).toBe(true);
    } finally {
      await closeMcpSession();
      await new Promise<void>((r) => server.close(() => r()));
      verifySpy.mockRestore();
      if (saved === undefined) delete process.env.TANDEM_APP_DATA_DIR;
      else process.env.TANDEM_APP_DATA_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dark-build wire shape", () => {
  // The gate ships dark, so this is the shape EVERY user gets today.
  it("carries licenseInstalled so an activation is visibly confirmed", () => {
    const dark: LicenseState = { gateActive: false };
    const none = toLicenseStatusWire(dark, { installed: false });
    expect(none).toMatchObject({ gateActive: false, licenseInstalled: false });
    expect(none).not.toHaveProperty("licenseeEmail");

    const installed = toLicenseStatusWire(dark, {
      installed: true,
      licenseeEmail: "jane@example.com",
    });
    expect(installed).toMatchObject({ licenseInstalled: true, licenseeEmail: "jane@example.com" });
  });

  it("keeps the back-compat sentinel so the updater and client are unchanged", () => {
    const wire = toLicenseStatusWire({ gateActive: false }, { installed: true });
    // gateActive MUST stay false — it is what suppresses all gate-only chrome.
    expect(wire.gateActive).toBe(false);
    expect(wire.status).toBe("licensed");
    expect(wire.updateWindowCurrent).toBe(true);
  });

  it("never puts the licensee email on the LAN-scrubbed path", () => {
    const scrubbed = scrubForNonLoopback({ gateActive: false });
    expect(scrubbed).not.toHaveProperty("licenseeEmail");
    expect(typeof scrubbed.licenseInstalled).toBe("boolean");
  });
});

/**
 * #1789, review round 1. The Settings → License CLI hint cannot be decided in
 * the client: `isTauriRuntime()` answers "am I in the Tauri WebView", and a
 * desktop install also serves this same client over `http://127.0.0.1:3479`, so
 * a desktop user browsing there reads FALSE and is offered `tandem activate` —
 * which writes `license.json` under the npm env-paths root while the sidecar
 * reads the Tauri app-data dir. It prints "✓ License activated" and the desktop
 * never sees it. The server owns the discriminant; this is its wire.
 */
describe("cliActivateEffective on the wire", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.TANDEM_APP_DATA_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = saved;
  });

  it("is false for a loopback caller whose server reads an overridden root", () => {
    process.env.TANDEM_APP_DATA_DIR = path.join(os.tmpdir(), "tandem-desktop-root-fixture");
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("127.0.0.1"), res);
    expect((res.body as { cliActivateEffective?: boolean }).cliActivateEffective).toBe(false);
  });

  it("is true for a loopback caller on the plain npm root", () => {
    delete process.env.TANDEM_APP_DATA_DIR;
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("127.0.0.1"), res);
    expect((res.body as { cliActivateEffective?: boolean }).cliActivateEffective).toBe(true);
  });

  /**
   * Absence, not an always-false key: a LAN caller runs the CLI on THEIR
   * machine, which can never reach this server's root, and the client reads a
   * missing field as false. Keeping it off the scrubbed wire also keeps that
   * payload from widening.
   */
  it("never reaches a non-loopback caller", () => {
    delete process.env.TANDEM_APP_DATA_DIR;
    const res = fakeRes();
    handleGetLicenseStatus(reqFrom("203.0.113.5"), res);
    expect(res.body).not.toHaveProperty("cliActivateEffective");
  });
});
