/**
 * Mint a signed Tandem license locally (#1116, ADR-040).
 *
 * This is the operator's out-of-band issuance path — the one that does NOT go
 * through Polar. Two uses: a free/complimentary license, and handing a buyer
 * their bytes directly when their mail provider quarantined the automated one
 * (re-sending through the same pipe cannot fix that case).
 *
 * IMPORTANT — signing is only half the job. A license whose `licenseId` has no
 * `LICENSE_KV` entitlement is served `204 No Content` by the update Worker,
 * which `tauri-plugin-updater` reports to the user as **"You're up to date."**
 * — permanently, while starved of updates. So this script writes the
 * entitlement too, and exits NON-ZERO if that write fails: a license you can't
 * update is worse than no license, because it fails silently and looks healthy.
 *
 * Requires the Cloudflare KV env (`TANDEM_CF_ACCOUNT_ID`,
 * `TANDEM_CF_KV_NAMESPACE_ID`, `TANDEM_CF_KV_API_TOKEN`) pointed at the SAME
 * namespace the update Worker binds as `LICENSE_KV`. Pass `--skip-entitlement`
 * to mint a blob without one — deliberately, e.g. for an offline test.
 *
 * Usage:
 *   npx tsx scripts/sign-license.ts --name "Jane Doe" --email jane@example.com
 *   npx tsx scripts/sign-license.ts --name "Beta Tester" --email b@x.com --type grandfathered
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { writeLicenseEntitlement } from "../src/server/license/kv-store.js";
import type { LicenseMetadata, SignedLicense } from "../src/server/license/license-types.js";
import { canonicalize } from "../src/server/license/verifier.js";

/** Default update window for a paid/complimentary license, in days. Matches the
 *  issuance Worker's `YEAR_MS`. A `grandfathered` license never expires. */
const DEFAULT_EXPIRES_DAYS = 365;

const LICENSE_TYPES = ["personal", "commercial", "grandfathered"] as const;

const USAGE =
  'Usage: npx tsx scripts/sign-license.ts --name "User Name" --email "user@example.com" ' +
  "[--type personal|commercial|grandfathered] [--expires days|never] [--skip-entitlement]";

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

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/**
 * Resolve the update-window end from `--expires` and the license type.
 *
 * The default is load-bearing: the pre-fix script left `expiresAt` as `null`
 * whenever `--expires` was omitted, which reads downstream as "update window
 * never ends" and is the exact state D1 describes. Only `grandfathered`
 * (or an explicit `--expires never`) legitimately means null.
 *
 * Throws (rather than exiting) on bad input so it stays unit-testable.
 */
export function resolveExpiresAt(
  rawExpires: string | undefined,
  type: LicenseMetadata["type"],
  now: Date,
): string | null {
  if (rawExpires === "never") return null;
  if (rawExpires === undefined || rawExpires === "true") {
    if (type === "grandfathered") return null;
    const d = new Date(now);
    d.setDate(d.getDate() + DEFAULT_EXPIRES_DAYS);
    return d.toISOString();
  }
  const days = Number.parseInt(rawExpires, 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new RangeError(
      `--expires must be a positive number of days, or "never" (got "${rawExpires}")`,
    );
  }
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function generateLicense(): Promise<void> {
  const options = parseArgs();
  const name = options.name === "true" ? "" : (options.name ?? "");
  const email = options.email === "true" ? "" : (options.email ?? "");
  const rawType = options.type === "true" ? undefined : options.type;
  const type = (rawType ?? "personal") as LicenseMetadata["type"];

  if (!name || !email) {
    console.error("Error: --name and --email are required.");
    console.log(USAGE);
    process.exit(1);
  }
  if (!LICENSE_TYPES.includes(type as (typeof LICENSE_TYPES)[number])) {
    // A typo'd type would otherwise be SIGNED into the blob and rejected
    // on-device by `isLedgerRecord`-shaped consumers with no explanation.
    fail(`--type must be one of ${LICENSE_TYPES.join(" | ")} (got "${type}")`);
  }

  // Load private key
  const privKeyPath = path.join(process.cwd(), "keys", "tandem-private-key.pem");
  if (!fs.existsSync(privKeyPath)) {
    fail(`Private key not found at ${privKeyPath}. Please run scripts/generate-keys.ts first.`);
  }
  const privateKey = fs.readFileSync(privKeyPath, "utf8");

  // Build metadata
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let expiresAt: string | null;
  try {
    expiresAt = resolveExpiresAt(options.expires, type, new Date());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
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

  // Record the update entitlement. Ordered AFTER printing so a KV failure never
  // costs the operator the blob they just minted — they can still deliver it and
  // repair the entitlement separately (see docs/licensing-operations.md).
  if (options["skip-entitlement"] === "true") {
    console.error(
      "\n[license] --skip-entitlement: no LICENSE_KV entry written. This license will be " +
        'told "You\'re up to date" forever. Only correct for an offline test.',
    );
    return;
  }

  const result = await writeLicenseEntitlement(id, {
    updateWindowEnd: expiresAt,
    status: type,
    version: metadata.version,
  });
  if (!result.ok) {
    console.error(
      "\n[license] FAILED to write the update entitlement for this license.\n" +
        (result.skipped
          ? "  Cloudflare KV is not configured. Set TANDEM_CF_ACCOUNT_ID, TANDEM_CF_KV_NAMESPACE_ID,\n" +
            "  and TANDEM_CF_KV_API_TOKEN (pointed at the update Worker's LICENSE_KV namespace).\n"
          : "  See the error above.\n") +
        "  The blob printed above is valid and will run forever, but it will NEVER be offered\n" +
        '  an update — the app will report "You\'re up to date". Do not deliver it until the\n' +
        "  entitlement is written (re-run this script, or PUT the key manually).\n",
    );
    process.exit(1);
  }
  console.log(`\n[license] Update entitlement written to Cloudflare KV for license ${id}.`);
}

// Guard so the exported helpers can be imported by tests without side effects.
if (process.argv[1]?.includes("sign-license")) {
  void generateLicense();
}
