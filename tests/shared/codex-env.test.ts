/**
 * `codexChildEnv` is the one allowlist for every Codex child Tandem spawns —
 * the `codex mcp add/get` shell-out, the managed worker, and the
 * `codex app-server` client. It replaced three hand-written copies of the same
 * nine keys, which is exactly the shape that drifts open one copy at a time.
 *
 * These tests assert the boundary, not the list: what is withheld, and that a
 * caller's `extra` cannot override an allowlisted key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_ENV_ALLOWLIST, codexChildEnv } from "../../src/shared/codex/env.js";

const SAVED: Record<string, string | undefined> = {};
const TOUCHED = [
  "PATH",
  "CODEX_HOME",
  "AWS_SECRET_ACCESS_KEY",
  "TANDEM_AUTH_TOKEN",
  "HTTPS_PROXY",
  "ANTHROPIC_API_KEY",
];

beforeEach(() => {
  for (const k of TOUCHED) SAVED[k] = process.env[k];
  process.env.PATH = "/usr/bin";
  process.env.CODEX_HOME = "/home/u/.codex";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  process.env.TANDEM_AUTH_TOKEN = "token";
  process.env.HTTPS_PROXY = "http://proxy:8080";
  process.env.ANTHROPIC_API_KEY = "key";
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("codexChildEnv", () => {
  it("passes allowlisted keys through", () => {
    const env = codexChildEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CODEX_HOME).toBe("/home/u/.codex");
  });

  // The assertion that matters. Paired with the pass-through above so
  // "undefined" is a real refusal rather than a function returning nothing.
  it("withholds credentials and proxy settings from the process environment", () => {
    const env = codexChildEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.TANDEM_AUTH_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("returns ONLY the allowlisted keys plus the caller's extras", () => {
    const env = codexChildEnv({ TANDEM_CODEX_CWD: "/w" });
    const unexpected = Object.keys(env).filter(
      (k) => k !== "TANDEM_CODEX_CWD" && !CODEX_ENV_ALLOWLIST.includes(k as never),
    );
    expect(unexpected).toEqual([]);
  });

  it("keeps the caller's extra keys", () => {
    expect(codexChildEnv({ TANDEM_CODEX_WORKER_TOKEN: "t" }).TANDEM_CODEX_WORKER_TOKEN).toBe("t");
  });

  // The allowlist is the boundary, so it must win over `extra`. Nothing today
  // passes a `PATH`, and this is what keeps that from being load-bearing.
  it("does not let an extra override an allowlisted key", () => {
    expect(codexChildEnv({ PATH: "/attacker/bin" }).PATH).toBe("/usr/bin");
  });

  it("omits an allowlisted key that is unset rather than setting it undefined", () => {
    delete process.env.CODEX_HOME;
    expect("CODEX_HOME" in codexChildEnv()).toBe(false);
  });
});
