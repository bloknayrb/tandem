/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "crypto";
import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { isGrandfathered } from "./grandfather-list.js";
import { writeLicenseEntitlement } from "./kv-store.js";
import type { LicenseMetadata, SignedLicense } from "./license-types.js";
import { canonicalize } from "./verifier.js";

/**
 * Loads the private key for signing licenses.
 * Checks TANDEM_PRIVATE_KEY environment variable first, then falls back to local keys/ folder.
 */
export function getPrivateKey(): string | null {
  if (process.env.TANDEM_PRIVATE_KEY) {
    return process.env.TANDEM_PRIVATE_KEY;
  }
  const localPrivKeyPath = path.join(process.cwd(), "keys", "tandem-private-key.pem");
  if (fs.existsSync(localPrivKeyPath)) {
    return fs.readFileSync(localPrivKeyPath, "utf8");
  }
  return null;
}

/**
 * Verifies the HMAC signature of Polar webhooks.
 */
const MAX_WEBHOOK_AGE_S = 300; // 5 minutes — prevents replay attacks

export function verifyPolarSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));

  if (!tPart || !v1Part) return false;

  const timestamp = tPart.split("=")[1];
  const signature = v1Part.split("=")[1];

  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > MAX_WEBHOOK_AGE_S) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSignature, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Verifies the HMAC signature of Paddle webhooks (v3 API).
 */
export function verifyPaddleSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(";");
  const tsPart = parts.find((p) => p.startsWith("ts="));
  const h1Part = parts.find((p) => p.startsWith("h1="));

  if (!tsPart || !h1Part) return false;

  const timestamp = tsPart.split("=")[1];
  const signature = h1Part.split("=")[1];

  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > MAX_WEBHOOK_AGE_S) return false;

  const signedPayload = `${timestamp}:${payload}`;
  const expectedSignature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSignature, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Express Route Handler for incoming Polar/Paddle webhooks.
 * Generates and delivers Ed25519-signed licenses upon successful checkout.
 */
export async function handleLicenseWebhook(req: Request, res: Response): Promise<void> {
  try {
    // express.raw({ type: 'application/json' }) passes the original request bytes as a Buffer.
    // This preserves the exact bytes that Polar/Paddle signed for HMAC verification.
    const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer).toString("utf8") : "";
    const polarSecret = process.env.POLAR_WEBHOOK_SECRET;
    const paddleSecret = process.env.PADDLE_WEBHOOK_SECRET;

    let isVerified = false;
    let customerName = "";
    let customerEmail = "";
    let isTestPurchase = false;

    // A webhook secret is mandatory in every environment. There is deliberately
    // no dev-mode bypass: this endpoint is auth-exempt and publicly reachable (it
    // serves external payment processors), and signing licenses is the most
    // sensitive operation the server performs. A NODE_ENV-gated bypass is a
    // production backdoor waiting for a misconfigured deploy — to test locally,
    // configure POLAR_WEBHOOK_SECRET/PADDLE_WEBHOOK_SECRET and sign the payload.
    if (!polarSecret && !paddleSecret) {
      console.error("Webhook Error: no webhook secret configured; cannot verify signatures.");
      res
        .status(503)
        .json({ error: "Licensing server configuration error: webhook secret not configured" });
      return;
    }

    // 1. Signature Verification & Event Parsing
    const polarSig = req.headers["webhook-signature"] || req.headers["stripe-signature"];
    const paddleSig = req.headers["paddle-signature"];

    if (polarSig && polarSecret) {
      isVerified = verifyPolarSignature(rawBody, polarSig as string, polarSecret);
    } else if (paddleSig && paddleSecret) {
      isVerified = verifyPaddleSignature(rawBody, paddleSig as string, paddleSecret);
    }

    if (!isVerified) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    let payload: any;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    if (!payload || !payload.event) {
      res.status(400).json({ error: "Invalid payload: missing event type" });
      return;
    }

    // Parse events (Polar & Paddle)
    if (payload.event === "order.created" || payload.event === "subscription.created") {
      // Polar payload structure
      const order = payload.data;
      customerName = order?.customer?.name || order?.user?.name || "Valued Customer";
      customerEmail = order?.customer?.email || order?.user?.email;
      isTestPurchase = order?.is_test || false;
    } else if (payload.event === "transaction.completed") {
      // Paddle payload structure
      const transaction = payload.data;
      customerName = transaction?.customer?.name || "Valued Customer";
      customerEmail = transaction?.customer?.email;
      isTestPurchase = transaction?.billing_details?.is_test || false;
    } else {
      // Unhandled/ignored event types. (Note: a signed payload reached this point,
      // so a local dev test must send a real order.created/transaction.completed
      // shape — there is no longer a dev-only custom-payload branch.)
      res.status(200).json({ status: "ignored", event: payload.event });
      return;
    }

    if (!customerEmail) {
      res.status(400).json({ error: "Customer email missing from webhook payload" });
      return;
    }

    // 2. Load private key
    const privateKey = getPrivateKey();
    if (!privateKey) {
      console.error("Webhook Error: Private key not configured for signing licenses.");
      res.status(500).json({ error: "Licensing server configuration error: missing private key" });
      return;
    }

    // 3. Determine license type (grandfathered vs paid)
    const type = isGrandfathered(customerEmail) ? "grandfathered" : "personal";

    // 4. Generate license metadata
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // License has a 1-year update window (expiresAt for updates), but user can run current version indefinitely
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    const expiresAt = type === "grandfathered" ? null : expires.toISOString();

    const metadata: LicenseMetadata = {
      id,
      name: customerName,
      email: customerEmail,
      type,
      createdAt,
      expiresAt,
      version: "1.0",
    };

    // 5. Sign the canonical metadata
    const dataStr = canonicalize(metadata);
    const signature = crypto.sign(null, Buffer.from(dataStr), privateKey);

    const signedLicense: SignedLicense = {
      metadata,
      signature: signature.toString("hex"),
    };

    const base64License = Buffer.from(JSON.stringify(signedLicense)).toString("base64");

    // 6. Record the entitlement for the L3 update Worker (#1116, ADR-040 §7).
    // Real purchases only (§12 M3) — test-mode checkouts must not entitle
    // updates. Fire-and-forget + non-fatal: the signed blob below is the source
    // of truth, KV is only the updater's cache, and we must not delay the
    // webhook response (a slow KV call could trip the processor's retry → a
    // duplicate license). writeLicenseEntitlement never throws and logs itself.
    if (!isTestPurchase) {
      void writeLicenseEntitlement(id, {
        updateWindowEnd: expiresAt,
        status: type,
        version: metadata.version,
      });
    }

    // 7. Deliver the license
    console.error(`[license] generated for ${customerEmail} (ID: ${id})`);

    // In production we would integrate an email delivery service (like Resend)
    if (process.env.RESEND_API_KEY) {
      // Mock Resend delivery (could be imported if npm package is added)
      console.error(`[license] dispatching to ${customerEmail}`);
    }

    // Return only the license blob and test flag — metadata fields (name, email)
    // are unnecessary in the response and would appear in any proxy/APM logs.
    res.status(200).json({
      status: "success",
      license: base64License,
      test: isTestPurchase,
    });
  } catch (err: any) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: `Webhook internal error: ${err.message}` });
  }
}
