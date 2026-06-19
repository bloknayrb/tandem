/* eslint-disable @typescript-eslint/no-explicit-any */

import { request as httpRequest } from "node:http";
import crypto from "crypto";
import type { Request, Response } from "express";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isGrandfathered } from "../../src/server/license/grandfather-list.js";
import {
  handleLicenseWebhook,
  verifyPaddleSignature,
  verifyPolarSignature,
} from "../../src/server/license/webhook.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

// Mock the L3 KV entitlement write so we can assert the `!isTestPurchase` gate
// (#1116 §12 M3) without a real Cloudflare account. The wrapper defers the
// reference so the hoisted vi.mock factory reads the initialized spy at call
// time (mirrors tests/client/license-store.svelte.test.ts).
const writeLicenseEntitlement = vi.fn();
vi.mock("../../src/server/license/kv-store.js", () => ({
  writeLicenseEntitlement: (...args: unknown[]) => writeLicenseEntitlement(...args),
}));

// Build a valid Polar `webhook-signature` header for a payload + secret. Mirrors
// the signing scheme verified by verifyPolarSignature (t=<ts>,v1=<hmac>).
function signPolar(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hash}`;
}

describe("Webhook Licensing", () => {
  describe("verifyPolarSignature", () => {
    it("should successfully verify a valid Polar signature", () => {
      const secret = "polar_test_secret";
      const payload = JSON.stringify({ event: "order.created", data: {} });
      const isValid = verifyPolarSignature(payload, signPolar(payload, secret), secret);
      expect(isValid).toBe(true);
    });

    it("should reject tampered payload", () => {
      const secret = "polar_test_secret";
      const payload = JSON.stringify({ event: "order.created", data: {} });
      const isValid = verifyPolarSignature(
        payload + "tampered",
        signPolar(payload, secret),
        secret,
      );
      expect(isValid).toBe(false);
    });
  });

  describe("verifyPaddleSignature", () => {
    it("should successfully verify a valid Paddle signature", () => {
      const secret = "paddle_test_secret";
      const payload = JSON.stringify({ event: "transaction.completed", data: {} });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const signedPayload = `${timestamp}:${payload}`;
      const hash = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

      const signatureHeader = `ts=${timestamp};h1=${hash}`;

      const isValid = verifyPaddleSignature(payload, signatureHeader, secret);
      expect(isValid).toBe(true);
    });
  });

  describe("handleLicenseWebhook", () => {
    const POLAR_SECRET = "polar_test_secret";
    let testPrivateKey: string;

    beforeAll(() => {
      const { privateKey } = crypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      testPrivateKey = privateKey;
    });

    beforeEach(() => {
      process.env.TANDEM_PRIVATE_KEY = testPrivateKey;
      process.env.POLAR_WEBHOOK_SECRET = POLAR_SECRET;
      writeLicenseEntitlement.mockClear();
    });

    afterEach(() => {
      delete process.env.TANDEM_PRIVATE_KEY;
      delete process.env.POLAR_WEBHOOK_SECRET;
    });

    const mockResponse = () => {
      const res: Partial<Response> = {};
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      return res as Response;
    };

    // Build a signed request for a Polar payload using POLAR_SECRET.
    const signedReq = (bodyPayload: unknown): Request => {
      const raw = JSON.stringify(bodyPayload);
      return {
        // express.raw() passes req.body as a Buffer; mirror that in unit tests
        body: Buffer.from(raw),
        headers: { "webhook-signature": signPolar(raw, POLAR_SECRET) },
      } as Partial<Request> as Request;
    };

    it("should generate a valid personal license on a signed Polar order.created", async () => {
      const res = mockResponse();
      await handleLicenseWebhook(
        signedReq({
          event: "order.created",
          data: { customer: { name: "John Doe", email: "john@example.com" }, is_test: true },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonResponse = (res.json as any).mock.calls[0][0];
      expect(jsonResponse.status).toBe("success");
      expect(jsonResponse.license).toBeDefined();
      // metadata is not returned in the response (PII reduction)
      expect(jsonResponse.metadata).toBeUndefined();

      // Decode the license blob directly — full crypto chain is tested in license.test.ts
      const decoded = JSON.parse(Buffer.from(jsonResponse.license, "base64").toString("utf-8"));
      expect(decoded.metadata.email).toBe("john@example.com");
      expect(decoded.metadata.type).toBe("personal");
    });

    it("should assign grandfathered type if email is in grandfather list", async () => {
      const res = mockResponse();
      await handleLicenseWebhook(
        signedReq({
          event: "order.created",
          data: { customer: { name: "Bryan Kolb", email: "bryan@tandem.chat" }, is_test: true },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonResponse = (res.json as any).mock.calls[0][0];
      // Decode the license blob to check type and expiry — metadata not in response body
      const decoded = JSON.parse(Buffer.from(jsonResponse.license, "base64").toString("utf-8"));
      expect(decoded.metadata.type).toBe("grandfathered");
      expect(decoded.metadata.expiresAt).toBeNull(); // Grandfathered never expires
    });

    it("writes the KV entitlement for a real (non-test) purchase", async () => {
      const res = mockResponse();
      await handleLicenseWebhook(
        signedReq({
          event: "order.created",
          data: { customer: { name: "Jane Real", email: "jane@example.com" }, is_test: false },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      // Fire-and-forget but the call itself is synchronous before the response.
      expect(writeLicenseEntitlement).toHaveBeenCalledTimes(1);
      expect(writeLicenseEntitlement).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "personal" }),
      );
    });

    it("does NOT write the KV entitlement for a test-mode purchase (§12 M3)", async () => {
      const res = mockResponse();
      await handleLicenseWebhook(
        signedReq({
          event: "order.created",
          data: { customer: { name: "Sandy Sandbox", email: "sandy@example.com" }, is_test: true },
        }),
        res,
      );

      // A license is still issued (test buyers get a working key)…
      expect(res.status).toHaveBeenCalledWith(200);
      // …but the test order must never entitle the update Worker.
      expect(writeLicenseEntitlement).not.toHaveBeenCalled();
    });

    it("rejects an unsigned request with 401 — no dev bypass, even in NODE_ENV=development", async () => {
      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const res = mockResponse();
      await handleLicenseWebhook(
        {
          body: Buffer.from(
            JSON.stringify({
              event: "order.created",
              data: { customer: { name: "Mallory", email: "mallory@evil.test" } },
            }),
          ),
          headers: {}, // no signature header
        } as Partial<Request> as Request,
        res,
      );
      process.env.NODE_ENV = oldEnv;

      expect(res.status).toHaveBeenCalledWith(401);
      const jsonResponse = (res.json as any).mock.calls[0][0];
      expect(jsonResponse.license).toBeUndefined();
    });

    it("rejects a forged signature with 401", async () => {
      const res = mockResponse();
      const raw = JSON.stringify({
        event: "order.created",
        data: { customer: { email: "mallory@evil.test" } },
      });
      await handleLicenseWebhook(
        {
          body: Buffer.from(raw),
          headers: { "webhook-signature": signPolar(raw, "wrong-secret") },
        } as Partial<Request> as Request,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect((res.json as any).mock.calls[0][0].license).toBeUndefined();
    });

    it("returns 503 when no webhook secret is configured (misconfiguration is loud, not bypassed)", async () => {
      delete process.env.POLAR_WEBHOOK_SECRET;
      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const res = mockResponse();
      await handleLicenseWebhook(
        {
          body: Buffer.from(JSON.stringify({ event: "order.created", data: {} })),
          headers: {},
        } as Partial<Request> as Request,
        res,
      );
      process.env.NODE_ENV = oldEnv;

      expect(res.status).toHaveBeenCalledWith(503);
      expect((res.json as any).mock.calls[0][0].license).toBeUndefined();
    });
  });

  describe("Grandfather List Checks", () => {
    it("should match grandfathered emails case-insensitively and trim spaces", () => {
      expect(isGrandfathered("bryan@tandem.chat")).toBe(true);
      expect(isGrandfathered("BRYAN@TANDEM.CHAT")).toBe(true);
      expect(isGrandfathered("  bryan@tandem.chat  ")).toBe(true);
      expect(isGrandfathered("someone-else@example.com")).toBe(false);
    });
  });

  describe("Webhook Route Integration (HTTP Server)", () => {
    const POLAR_SECRET = "polar_test_secret";
    let serverInstance: any;
    let serverPort: number;
    let testPrivateKey: string;

    beforeAll(() => {
      const { privateKey } = crypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      testPrivateKey = privateKey;
    });

    const rawPost = (
      p: number,
      path: string,
      headers: Record<string, string>,
      body: string,
    ): Promise<{ status: number; body: any }> => {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: p,
            path,
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
          },
          (res: any) => {
            let data = "";
            res.on("data", (chunk: string) => {
              data += chunk;
            });
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
              } catch {
                resolve({ status: res.statusCode ?? 0, body: data });
              }
            });
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
    };

    beforeEach(async () => {
      process.env.TANDEM_PRIVATE_KEY = testPrivateKey;
      process.env.POLAR_WEBHOOK_SECRET = POLAR_SECRET;
      serverPort = await allocPort();
      // startMcpServerHttp(port, bindHost, authToken)
      serverInstance = await startMcpServerHttp(serverPort, "127.0.0.1", "test-token");
    });

    afterEach(async () => {
      delete process.env.TANDEM_PRIVATE_KEY;
      delete process.env.POLAR_WEBHOOK_SECRET;
      await new Promise<void>((resolve) => {
        serverInstance.close(() => resolve());
      });
    });

    it("should process a signed webhook on /webhooks/license without an auth header", async () => {
      const body = JSON.stringify({
        event: "order.created",
        data: {
          customer: { name: "Integration Tester", email: "tester@example.com" },
          is_test: true,
        },
      });

      const { status, body: resBody } = await rawPost(
        serverPort,
        "/webhooks/license",
        { "webhook-signature": signPolar(body, POLAR_SECRET) },
        body,
      );

      expect(status).toBe(200);
      expect(resBody.status).toBe("success");
      expect(resBody.license).toBeDefined();
      // metadata is omitted from the response (PII reduction)
      expect(resBody.metadata).toBeUndefined();
    });

    it("rejects an unsigned webhook with 401 (auth-exempt route is still signature-gated)", async () => {
      const body = JSON.stringify({
        event: "order.created",
        data: { customer: { email: "mallory@evil.test" } },
      });

      const { status, body: resBody } = await rawPost(serverPort, "/webhooks/license", {}, body);

      expect(status).toBe(401);
      expect(resBody.license).toBeUndefined();
    });
  });
});
