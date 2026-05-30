// Runs once after the capture spec (immune to worker restarts on retry).
// Folds every per-scene part written during capture into the single
// baselines.html gallery, then removes the scratch parts dir.
import fs from "node:fs";
import { combineFromParts, OUT_FILE, PARTS_DIR } from "./combine";

export default function globalTeardown() {
  if (!fs.existsSync(PARTS_DIR)) return;
  const count = combineFromParts();
  fs.rmSync(PARTS_DIR, { recursive: true, force: true });
  console.error(`Combined ${count} scenes into ${OUT_FILE}`);
}
