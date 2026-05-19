/**
 * Save / set / restore a process env var, scoped to either a single block
 * or every test in the enclosing describe.
 */

import { afterEach, beforeEach } from "vitest";

/**
 * Set `process.env[name] = value` for the duration of `fn`, then restore
 * the previous value (or delete the var if it was unset). Use when only
 * one test in a describe block needs the override and a beforeEach pair
 * would over-broaden the scope.
 */
export async function withEnvOverride<T>(
  name: string,
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

/**
 * Register beforeEach/afterEach hooks that save, set, and restore `name`
 * around every test in the enclosing describe block.
 */
export function useEnvOverride(name: string, value: string): void {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[name];
    process.env[name] = value;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}
