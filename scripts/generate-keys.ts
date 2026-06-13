import crypto from "crypto";
import fs from "fs";
import path from "path";

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

  const keysDir = path.join(process.cwd(), "keys");
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir);
  }

  const pubPath = path.join(keysDir, "tandem-public-key.pem");
  const privPath = path.join(keysDir, "tandem-private-key.pem");

  fs.writeFileSync(pubPath, publicKey);
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 }); // owner read/write only

  console.log(`Keys generated successfully!`);
  console.log(`Public Key saved to: ${pubPath}`);
  console.log(`Private Key saved to: ${privPath}`);
  console.log("\n--- Public Key PEM ---");
  console.log(publicKey);
}

generateKeys();
