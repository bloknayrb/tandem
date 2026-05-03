import type { TandemNotification } from "../../shared/types";

export interface Toast extends TandemNotification {
  /** Number of times this dedup key has been seen (1 = first occurrence). */
  count: number;
}
