/**
 * OS keychain backend for integration auth tokens.
 *
 * Stores per-integration secrets (`tokenSecretRef` from `schema.ts`) in the
 * platform-native keychain via `@napi-rs/keyring`:
 *   - macOS:   Keychain
 *   - Windows: Credential Manager
 *   - Linux:   Secret Service (libsecret/dbus)
 *
 * **Why a separate backend?** The integrations file is plain JSON on disk;
 * embedding raw API keys there would leak them through backups, sync, and
 * `cat`. The file holds only opaque references; the OS keychain holds the
 * actual secrets and gates access on user-session unlock.
 *
 * **Lazy load.** `@napi-rs/keyring` is a native module. Headless CI runners
 * and Linux systems without dbus / libsecret will throw on import. We
 * defer the require so importing this module never crashes; failures
 * surface only when a caller actually tries to read or write a secret.
 *
 * **Dependency injection.** Tests pass a fake backend to `createKeychain()`;
 * production callers use the default which lazy-loads `@napi-rs/keyring`.
 * No vitest mock state to manage across files.
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const esmRequire = createRequire(import.meta.url);

/** Keychain service identifier — all Tandem integration tokens live under this name. */
export const KEYCHAIN_SERVICE = "tandem-integrations" as const;

/** Thrown when the underlying OS keychain is unavailable (missing native module, no dbus, etc.). */
export class KeychainUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `OS keychain unavailable: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Install libsecret + dbus on Linux, or set the secret via env var (see docs).`,
    );
    this.name = "KeychainUnavailableError";
  }
}

/**
 * Minimal interface mirroring `@napi-rs/keyring`'s `Entry`. Tests pass a
 * fake implementation; production wraps the native module.
 */
export interface KeychainBackend {
  /** Returns `null` if no secret is stored under `(service, account)`. */
  get(service: string, account: string): string | null;
  /** Overwrites any existing secret at `(service, account)`. */
  set(service: string, account: string, secret: string): void;
  /** Returns `true` if a secret existed and was deleted; `false` otherwise. */
  delete(service: string, account: string): boolean;
}

export interface Keychain {
  /** Read a secret previously stored under `ref`. Returns `null` if absent. */
  getSecret(ref: string): Promise<string | null>;
  /** Store or overwrite a secret under `ref`. */
  setSecret(ref: string, secret: string): Promise<void>;
  /** Remove the secret stored under `ref`. Returns `true` if one existed. */
  deleteSecret(ref: string): Promise<boolean>;
}

/**
 * Generate a fresh `tokenSecretRef` value. Opaque, URL-safe, 128 bits of
 * entropy — enough to make accidental collisions across a user's history
 * negligible without crowding keychain UIs with long strings.
 */
export function generateSecretRef(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Create a keychain instance. If `backend` is omitted, lazy-loads
 * `@napi-rs/keyring` on first use; calls throw `KeychainUnavailableError`
 * if the native module cannot be loaded.
 */
export function createKeychain(backend?: KeychainBackend): Keychain {
  const resolveBackend: () => KeychainBackend = backend
    ? () => backend
    : memoize(() => loadNativeBackend());

  return {
    async getSecret(ref) {
      const b = resolveBackend();
      return b.get(KEYCHAIN_SERVICE, ref);
    },
    async setSecret(ref, secret) {
      if (!ref || ref.length === 0) {
        throw new Error("setSecret: ref is required");
      }
      if (typeof secret !== "string" || secret.length === 0) {
        throw new Error("setSecret: secret must be a non-empty string");
      }
      const b = resolveBackend();
      b.set(KEYCHAIN_SERVICE, ref, secret);
    },
    async deleteSecret(ref) {
      const b = resolveBackend();
      return b.delete(KEYCHAIN_SERVICE, ref);
    },
  };
}

function memoize<T>(fn: () => T): () => T {
  let cached: { v: T } | undefined;
  return () => {
    if (cached === undefined) cached = { v: fn() };
    return cached.v;
  };
}

/**
 * Lazy-load `@napi-rs/keyring`. Wrapped in a function so import-time
 * failures never crash the server — only direct keychain callers fail.
 */
function loadNativeBackend(): KeychainBackend {
  type NativeEntryCtor = new (
    service: string,
    account: string,
  ) => {
    getPassword(): string | null;
    setPassword(secret: string): void;
    deletePassword(): boolean;
  };
  let nativeEntry: NativeEntryCtor;
  try {
    // Lazy CJS require via createRequire — defers native module load until
    // first keychain call. Import-time failures (missing dbus, no libsecret)
    // never crash the server; only direct keychain callers see the error.
    const mod = esmRequire("@napi-rs/keyring") as { Entry: NativeEntryCtor };
    nativeEntry = mod.Entry;
  } catch (err) {
    throw new KeychainUnavailableError(err);
  }
  return {
    get(service, account) {
      try {
        return new nativeEntry(service, account).getPassword();
      } catch (err) {
        throw new KeychainUnavailableError(err);
      }
    },
    set(service, account, secret) {
      try {
        new nativeEntry(service, account).setPassword(secret);
      } catch (err) {
        throw new KeychainUnavailableError(err);
      }
    },
    delete(service, account) {
      try {
        return new nativeEntry(service, account).deletePassword();
      } catch (err) {
        throw new KeychainUnavailableError(err);
      }
    },
  };
}
