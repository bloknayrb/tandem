// Runs once before the capture spec (immune to worker restarts on retry).
// Clears any stale per-scene parts from a prior interrupted run.
import fs from "node:fs";
import { PARTS_DIR } from "./combine";

export default function globalSetup() {
  fs.rmSync(PARTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(PARTS_DIR, { recursive: true });
}
