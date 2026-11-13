/**
 * File-system names for a run. A model tag holds `:` and may hold `/`
 * (`hf.co/org/model:Q4_K_M`), so no tag is ever used raw in a path: it becomes
 * ONE path segment made of `[A-Za-z0-9._-]` plus a short hash of the exact tag,
 * so two tags that sanitise alike still get different names.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `probe/local-model-spike/`. */
export const SPIKE_DIR = path.resolve(HERE, "..");
/** Gitignored: one directory per run. The June files are not here. */
export const RUNS_DIR = path.join(SPIKE_DIR, "runs");

/** Starts with a letter or digit, so `.`, `..` and a leading dot are all refused. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One safe path segment for a model tag. Never contains a separator or `:`. */
export function safeTagName(tag: string): string {
  const cleaned = tag
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    // Short, so a long tag cannot push a run path past Windows' MAX_PATH.
    .slice(0, 40);
  return `${cleaned || "model"}-${sha256Hex(tag).slice(0, 8)}`;
}

/** `20261112T153000Z`: sortable, and free of `:`. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function makeRunId(parts: {
  date: Date;
  tier: string;
  mode: string;
  modelTag: string;
}): string {
  return `${utcStamp(parts.date)}-${parts.tier}-${parts.mode}-${safeTagName(parts.modelTag)}`;
}

/** A run id is a single safe segment; anything else is refused, never joined. */
export function isSafeRunId(runId: string): boolean {
  return SAFE_SEGMENT.test(runId) && runId.length <= 120;
}

/** The directory for a run id under `runsDir`, or a thrown refusal. */
export function runDirFor(runId: string, runsDir: string = RUNS_DIR): string {
  if (!isSafeRunId(runId)) {
    throw new Error(
      `not a run id (letters, digits, ".", "_" and "-", starting with a letter or digit): ${JSON.stringify(runId)}`,
    );
  }
  return path.join(runsDir, runId);
}
