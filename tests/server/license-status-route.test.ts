import crypto from "crypto";
import type { Request, Response } from "express";
import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import type { LicenseState } from "../../src/server/license/license-types.js";
import * as verifier from "../../src/server/license/verifier.js";
import { canonicalize } from "../../src/server/license/verifier.js";
import {
  handleActivateLicense,
  handleGetLicenseStatus,
  scrubForNonLoopback,
  toLicenseStatusWire,
} from "../../src/server/mcp/routes/license.js";

const FULL: LicenseState = {
  gateActive: true,
  status: "licensed",
  updateWindowCurrent: true,
  license: {
    id: "lic-123",
    name: "Jane Doe",
    email: "jane@example.com",
    type: "personal",
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    version: "1.0",
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
  it("drops licensee name/email/licenseId", () => {
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
    expect((res.body as LicenseState).status).toBeDefined();
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

describe("handleActivateLicense", () => {
  it("rejects a non-allowlisted origin with 403 before touching the body", async () => {
    const res = fakeRes();
    await handleActivateLicense(activateReq({ body: { license: "x" } }), res);
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
    await handleActivateLicense(activateReq({ body: { license: "x" } }), res);
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/computer running Tandem/);
    expect(message).not.toMatch(/integration routes/);
    expect(message).not.toMatch(/TANDEM_ALLOW_UNAUTHENTICATED_LAN/);
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
      name: "Jane Doe",
      email: "jane@example.com",
      type: "personal" as const,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      version: "1.0",
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

describe("dark-build wire shape", () => {
  // The gate ships dark, so this is the shape EVERY user gets today.
  it("carries licenseInstalled so an activation is visibly confirmed", () => {
    const dark: LicenseState = { gateActive: false };
    const none = toLicenseStatusWire(dark, { installed: false });
    expect(none).toMatchObject({ gateActive: false, licenseInstalled: false });
    expect(none).not.toHaveProperty("licenseeName");

    const installed = toLicenseStatusWire(dark, { installed: true, licenseeName: "Jane Doe" });
    expect(installed).toMatchObject({ licenseInstalled: true, licenseeName: "Jane Doe" });
  });

  it("keeps the back-compat sentinel so the updater and client are unchanged", () => {
    const wire = toLicenseStatusWire({ gateActive: false }, { installed: true });
    // gateActive MUST stay false — it is what suppresses all gate-only chrome.
    expect(wire.gateActive).toBe(false);
    expect(wire.status).toBe("licensed");
    expect(wire.updateWindowCurrent).toBe(true);
  });

  it("never puts the licensee name on the LAN-scrubbed path", () => {
    const scrubbed = scrubForNonLoopback({ gateActive: false });
    expect(scrubbed).not.toHaveProperty("licenseeName");
    expect(typeof scrubbed.licenseInstalled).toBe("boolean");
  });
});
