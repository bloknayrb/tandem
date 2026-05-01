import type { Annotation, TandemMode } from "../../shared/types.js";

export function shouldShowInMode(ann: Annotation, mode: TandemMode): boolean {
  if (ann.status !== "pending") return true;
  if (mode === "tandem") return true;
  return ann.author !== "claude";
}

// React hook removed — utilities migrated to useModeGate.svelte.ts
