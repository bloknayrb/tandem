import crypto from "crypto";
import fs from "fs";
import path from "path";
import { keyIdForPublicKey } from "../src/server/license/public-key.js";

// Writes `keys/tandem-<keyId>.pem` and `.pub.pem`, named by the key's id and
// never overwriting: a second run is a NEW key beside the old one, not a
// replacement, so an existing signing key cannot be clobbered by accident.
// To make the new key usable, follow docs/licensing-operations.md §0.
function generateKeys() {
  console.log("Generating Ed25519 key pair for Tandem licensing...");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
  const keyId = keyIdForPublicKey(publicKey);

  const keysDir = path.join(process.cwd(), "keys");
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir);
  }

  const pubPath = path.join(keysDir, `tandem-${keyId}.pub.pem`);
  const privPath = path.join(keysDir, `tandem-${keyId}.pem`);

  // `wx` fails if the file exists. An id collision is not expected, but if it
  // happens the existing key must survive.
  fs.writeFileSync(pubPath, publicKey, { flag: "wx" });
  fs.writeFileSync(privPath, privateKey, { flag: "wx", mode: 0o600 }); // owner read/write only

  console.log(`Keys generated successfully! Key id: ${keyId}`);
  console.log(`Public Key saved to: ${pubPath}`);
  console.log(`Private Key saved to: ${privPath}`);
  console.log("\n--- Public Key PEM ---");
  console.log(publicKey);
}

generateKeys();
