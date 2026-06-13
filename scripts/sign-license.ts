import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { LicenseMetadata, SignedLicense } from "../src/server/license/license-types.js";
import { canonicalize } from "../src/server/license/verifier.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        options[key] = val;
        i++;
      } else {
        options[key] = "true";
      }
    }
  }
  return options;
}

function generateLicense() {
  const options = parseArgs();
  const name = options.name || "";
  const email = options.email || "";
  const type = (options.type || "personal") as LicenseMetadata["type"];
  const expiresDays = options.expires ? parseInt(options.expires, 10) : null;

  if (!name || !email) {
    console.error("Error: --name and --email are required.");
    console.log(
      'Usage: npx tsx scripts/sign-license.ts --name "User Name" --email "user@example.com" [--type personal|commercial|grandfathered] [--expires days]',
    );
    process.exit(1);
  }

  // Load private key
  const privKeyPath = path.join(process.cwd(), "keys", "tandem-private-key.pem");
  if (!fs.existsSync(privKeyPath)) {
    console.error(
      `Error: Private key not found at ${privKeyPath}. Please run scripts/generate-keys.ts first.`,
    );
    process.exit(1);
  }
  const privateKey = fs.readFileSync(privKeyPath, "utf8");

  // Build metadata
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  let expiresAt: string | null = null;
  if (expiresDays !== null) {
    const d = new Date();
    d.setDate(d.getDate() + expiresDays);
    expiresAt = d.toISOString();
  }

  const metadata: LicenseMetadata = {
    id,
    name,
    email,
    type,
    createdAt,
    expiresAt,
    version: "1.0",
  };

  // Sign data
  const dataStr = canonicalize(metadata);
  const signature = crypto.sign(null, Buffer.from(dataStr), privateKey);

  const signedLicense: SignedLicense = {
    metadata,
    signature: signature.toString("hex"),
  };

  const base64License = Buffer.from(JSON.stringify(signedLicense)).toString("base64");

  console.log("\n--- License Metadata ---");
  console.log(JSON.stringify(metadata, null, 2));
  console.log("\n--- Base64 Encoded Signed License (Use this as your license key) ---");
  console.log(base64License);
  console.log("--------------------------------------------------------------------");

  return base64License;
}

generateLicense();
