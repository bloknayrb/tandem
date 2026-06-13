/* eslint-disable @typescript-eslint/no-explicit-any */

import { request as httpRequest } from "node:http";
import crypto from "crypto";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isGrandfathered } from "../../src/server/license/grandfather-list.js";
import { verifyLicense } from "../../src/server/license/verifier.js";
import {
  handleLicenseWebhook,
  verifyPaddleSignature,
  verifyPolarSignature,
} from "../../src/server/license/webhook.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

describe("Webhook Licensing", () => {
  describe("verifyPolarSignature", () => {
    it("should successfully verify a valid Polar signature", () => {
      const secret = "polar_test_secret";
      const payload = JSON.stringify({ event: "order.created", data: {} });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const signedPayload = `${timestamp}.${payload}`;
      const hash = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

      const signatureHeader = `t=${timestamp},v1=${hash}`;

      const isValid = verifyPolarSignature(payload, signatureHeader, secret);
      expect(isValid).toBe(true);
    });

    it("should reject tampered payload", () => {
      const secret = "polar_test_secret";
      const payload = JSON.stringify({ event: "order.created", data: {} });
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const signedPayload = `${timestamp}.${payload}`;
      const hash = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

      const signatureHeader = `t=${timestamp},v1=${hash}`;

      const isValid = verifyPolarSignature(payload + "tampered", signatureHeader, secret);
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
    const mockResponse = () => {
      const res: Partial<Response> = {};
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      return res as Response;
    };

    it("should generate a valid personal license on Polar order.created in dev mode", async () => {
      const bodyPayload = {
        event: "order.created",
        data: {
          customer: { name: "John Doe", email: "john@example.com" },
          is_test: true,
        },
      };
      const req: Partial<Request> = {
        // express.raw() passes req.body as a Buffer; mirror that in unit tests
        body: Buffer.from(JSON.stringify(bodyPayload)),
        headers: {},
      };

      const res = mockResponse();

      // Force development mode in environment
      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      await handleLicenseWebhook(req as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonResponse = (res.json as any).mock.calls[0][0];
      expect(jsonResponse.status).toBe("success");
      expect(jsonResponse.license).toBeDefined();
      // metadata is not returned in the response (PII reduction)
      expect(jsonResponse.metadata).toBeUndefined();

      // Verify the generated license string itself
      const verified = verifyLicense(jsonResponse.license);
      expect(verified.email).toBe("john@example.com");
      expect(verified.type).toBe("personal");

      // Restore environment variables
      process.env.NODE_ENV = oldEnv;
    });

    it("should assign grandfathered type if email is in grandfather list", async () => {
      const bodyPayload = {
        event: "order.created",
        data: {
          customer: { name: "Bryan Kolb", email: "bryan@tandem.chat" },
          is_test: true,
        },
      };
      const req: Partial<Request> = {
        body: Buffer.from(JSON.stringify(bodyPayload)),
        headers: {},
      };

      const res = mockResponse();

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      await handleLicenseWebhook(req as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonResponse = (res.json as any).mock.calls[0][0];
      // Decode the license blob to check type and expiry — metadata not in response body
      const decodedGf = verifyLicense(jsonResponse.license);
      expect(decodedGf.type).toBe("grandfathered");
      expect(decodedGf.expiresAt).toBeNull(); // Grandfathered never expires

      process.env.NODE_ENV = oldEnv;
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
    let serverInstance: any;
    let serverPort: number;

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
      serverPort = await allocPort();
      // startMcpServerHttp(port, bindHost, authToken)
      serverInstance = await startMcpServerHttp(serverPort, "127.0.0.1", "test-token");
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        serverInstance.close(() => resolve());
      });
    });

    it("should process webhook requests on /webhooks/license without auth header", async () => {
      const payload = {
        event: "order.created",
        data: {
          customer: { name: "Integration Tester", email: "tester@example.com" },
          is_test: true,
        },
      };

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      const { status, body } = await rawPost(
        serverPort,
        "/webhooks/license",
        {},
        JSON.stringify(payload),
      );

      process.env.NODE_ENV = oldEnv;

      expect(status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.license).toBeDefined();
      // metadata is omitted from the response (PII reduction)
      expect(body.metadata).toBeUndefined();
    });
  });
});
