/**
 * Mint a signed Tandem license locally (#1116, ADR-040).
 *
 * This is the operator's out-of-band issuance path — the one that does NOT go
 * through Paddle. Two uses: a free/complimentary license, and handing a buyer
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
 *   npx tsx scripts/sign-license.ts --email jane@example.com
 *   npx tsx scripts/sign-license.ts --email b@x.com --type grandfathered
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { writeLicenseEntitlement } from "../src/server/license/kv-store.js";
import type { LicenseMetadata, SignedLicense } from "../src/server/license/license-types.js";
import { KEYS_BY_ID, keyIdForPublicKey } from "../src/server/license/public-key.js";
import { canonicalize } from "../src/server/license/verifier.js";

const LICENSE_TYPES = ["personal", "commercial", "grandfathered"] as const;

const USAGE =
  'Usage: npx tsx scripts/sign-license.ts --email "user@example.com" ' +
  "[--type personal|commercial|grandfathered] [--expires days|never] [--key path] " +
  "[--skip-entitlement]";

/**
 * The private key `--key` defaults to: `keys/tandem-<id>.pem`, the name
 * `generate-keys.ts` writes, for the one key this build trusts. With more than
 * one trusted key (mid-rotation) there is no safe guess, so `--key` is required
 * (docs/licensing-operations.md §0).
 */
export function defaultPrivateKeyPath(
  trustedKeysById: Readonly<Record<string, string>> = KEYS_BY_ID,
): string | undefined {
  const ids = Object.keys(trustedKeysById);
  return ids.length === 1 ? path.join("keys", `tandem-${ids[0]}.pem`) : undefined;
}

/**
 * Sign license metadata with a private key, stamping the key's id.
 *
 * The id is derived from the key itself, never passed in, so a license cannot
 * name a key other than the one that signed it. A key no build trusts is
 * refused BEFORE signing: its licenses would fail verification everywhere, and
 * the buyer would be told their key is bad.
 */
export function signWithKey(
  fields: Omit<LicenseMetadata, "keyId">,
  privateKeyPem: string,
  trustedKeysById: Readonly<Record<string, string>> = KEYS_BY_ID,
): { metadata: LicenseMetadata; blob: string } {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const keyId = keyIdForPublicKey(crypto.createPublicKey(privateKey));
  if (!Object.hasOwn(trustedKeysById, keyId)) {
    throw new Error(
      `This private key (id ${keyId}) is not in TRUSTED_PUBLIC_KEYS ` +
        "(src/server/license/public-key.ts), so no build would accept its licenses.",
    );
  }
  const metadata: LicenseMetadata = { ...fields, keyId };
  const signature = crypto.sign(null, Buffer.from(canonicalize(metadata)), privateKey);
  const signedLicense: SignedLicense = { metadata, signature: signature.toString("hex") };
  return { metadata, blob: Buffer.from(JSON.stringify(signedLicense)).toString("base64") };
}

/**
 * Parse `--flag value` pairs.
 *
 * A valueless flag maps to `true` (the boolean), NOT the string `"true"` — the
 * previous version stored the string, which then had to be un-done at four
 * separate call sites, and leaked the parser's encoding into
 * `resolveExpiresAt`, an otherwise pure date function.
 */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1];
    if (val && !val.startsWith("--")) {
      options[key] = val;
      i++;
    } else {
      options[key] = true;
    }
  }
  return options;
}

/** Read a flag that requires a value; a valueless flag reads as absent. */
function str(options: Record<string, string | true>, key: string): string | undefined {
  const v = options[key];
  return typeof v === "string" ? v : undefined;
}

function fail(message: string, showUsage = false): never {
  console.error(`Error: ${message}`);
  if (showUsage) console.error(USAGE);
  process.exit(1);
}

/**
 * Resolve the update-window end from `--expires`.
 *
 * Omitting `--expires` means `null` (no update window) for every license type,
 * because every key includes all future updates (ADR-040, amended 2026-10-09,
 * decision A5) and the issuance Worker mints paid keys with a null window too.
 * The default used to be 365 days for `personal`/`commercial`, matching the
 * one-year window that decision removed; a null default was the D1 bug then,
 * and is the intended state now. `--expires <days>` still mints a windowed key,
 * for a test or a deliberate exception; nothing sells one.
 *
 * Throws (rather than exiting) on bad input so it stays unit-testable.
 */
export function resolveExpiresAt(rawExpires: string | undefined, now: Date): string | null {
  if (rawExpires === undefined || rawExpires === "never") return null;

  // Strict, not `parseInt`: the prefix-lenient version silently read
  // `--expires 30days` as 30 and `--expires 1e5` as 1.
  if (!/^\d+$/.test(rawExpires)) {
    throw new RangeError(
      `--expires must be a whole number of days, or "never" (got "${rawExpires}")`,
    );
  }
  const days = Number(rawExpires);
  if (days <= 0) {
    throw new RangeError(`--expires must be greater than zero (got "${rawExpires}")`);
  }

  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function generateLicense(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.name !== undefined) {
    // Refused rather than ignored: an operator passing it expects it in the key.
    fail("--name is no longer accepted: a license no longer carries a name.", true);
  }
  const email = str(options, "email");
  const type = (str(options, "type") ?? "personal") as LicenseMetadata["type"];

  if (!email) {
    fail("--email is required.", true);
  }
  if (!LICENSE_TYPES.includes(type as (typeof LICENSE_TYPES)[number])) {
    // A typo'd type would otherwise be SIGNED into the blob and rejected
    // on-device by `isLedgerRecord`-shaped consumers with no explanation.
    fail(`--type must be one of ${LICENSE_TYPES.join(" | ")} (got "${type}")`);
  }

  // Load private key
  const keyArg = str(options, "key") ?? defaultPrivateKeyPath();
  if (keyArg === undefined) {
    fail("More than one key is trusted, so there is no default: pass --key.");
  }
  const privKeyPath = path.resolve(process.cwd(), keyArg);
  if (!fs.existsSync(privKeyPath)) {
    fail(
      `Private key not found at ${privKeyPath}. Pass --key with the path to the signing ` +
        "key's offline copy (docs/licensing-operations.md §0).",
    );
  }
  const privateKey = fs.readFileSync(privKeyPath, "utf8");

  // Build metadata
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let expiresAt: string | null;
  try {
    expiresAt = resolveExpiresAt(str(options, "expires"), new Date());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  let signed: ReturnType<typeof signWithKey>;
  try {
    signed = signWithKey({ id, email, type, createdAt, expiresAt, version: "1.0" }, privateKey);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { metadata, blob: base64License } = signed;

  console.log("\n--- License Metadata ---");
  console.log(JSON.stringify(metadata, null, 2));
  console.log("\n--- Base64 Encoded Signed License (Use this as your license key) ---");
  console.log(base64License);
  console.log("--------------------------------------------------------------------");

  // Record the update entitlement. Ordered AFTER printing so a KV failure never
  // costs the operator the blob they just minted — they can still deliver it and
  // repair the entitlement separately (see docs/licensing-operations.md).
  if (options["skip-entitlement"] === true) {
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

// Run only when executed directly, so tests can import the exported helpers
// without side effects. The canonical ESM check, not a substring match on the
// path — `includes("sign-license")` also matched the test file's own name.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void generateLicense();
}
