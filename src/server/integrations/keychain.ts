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
 *
 * **Tauri sidecar packaging — known limitation (tracked in roadmap).**
 * `@napi-rs/keyring` is marked external in `tsup.config.ts` because the
 * native dispatcher cannot be bundled — it dynamic-`require`s a
 * platform-specific subpackage (`@napi-rs/keyring-linux-x64-gnu`,
 * etc.) at runtime. The npm CLI install path resolves these via
 * `node_modules`. The Tauri sidecar ships only the bundled `dist/`
 * tree (no `node_modules`), so calls into the default backend WILL
 * throw `KeychainUnavailableError` in the Tauri build. PR 3c (wizard)
 * is the first production consumer and MUST address this before
 * exposing keychain features in Tauri — either by adding
 * `node_modules/@napi-rs/keyring/**` to Tauri resources, or by wiring
 * a Tauri Rust keychain bridge command and injecting a custom
 * `KeychainBackend` that delegates to it (mirroring
 * `src-tauri/src/token_store.rs`).
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const esmRequire = createRequire(import.meta.url);

/** Keychain service identifier — all Tandem integration tokens live under this name. */
export const KEYCHAIN_SERVICE = "tandem-integrations" as const;

/**
 * Keychain service identifier for the Models registry (#659). Separate from
 * `KEYCHAIN_SERVICE` so outbound third-party API keys (Anthropic, OpenAI,
 * Gemini) don't share a namespace with inbound MCP-client auth tokens.
 * Different blast radius (third-party paid account vs local server), so
 * different namespace.
 */
export const KEYCHAIN_SERVICE_MODELS = "tandem-models" as const;

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

export interface CreateKeychainOptions {
  /** OS keychain service name. Defaults to `KEYCHAIN_SERVICE` (integrations). */
  service?: string;
  /** Inject a fake backend for tests. */
  backend?: KeychainBackend;
}

/**
 * Create a keychain instance. Two arg forms:
 *   - `createKeychain(backend)` — inject a fake backend (tests).
 *   - `createKeychain({ service, backend? })` — service-scoped instance.
 *     Pass `KEYCHAIN_SERVICE_MODELS` for the Models registry so its keys
 *     don't share a namespace with integration auth tokens.
 *
 * No-arg / no-backend lazy-loads `@napi-rs/keyring` on first use; calls
 * throw `KeychainUnavailableError` if the native module cannot be loaded.
 */
export function createKeychain(
  backendOrOptions?: KeychainBackend | CreateKeychainOptions,
): Keychain {
  // Positional `KeychainBackend` arg form is kept for backwards compat with
  // existing call sites (integrations routes test fakes). The new options
  // form is used for the Models registry which needs a different service.
  const isLegacyBackendArg =
    backendOrOptions !== undefined &&
    typeof (backendOrOptions as KeychainBackend).get === "function";
  const opts: CreateKeychainOptions = isLegacyBackendArg
    ? { backend: backendOrOptions as KeychainBackend }
    : ((backendOrOptions as CreateKeychainOptions | undefined) ?? {});
  const service = opts.service ?? KEYCHAIN_SERVICE;
  const resolveBackend: () => KeychainBackend = opts.backend
    ? () => opts.backend as KeychainBackend
    : memoize(() => loadNativeBackend());

  return {
    async getSecret(ref) {
      const b = resolveBackend();
      return b.get(service, ref);
    },
    async setSecret(ref, secret) {
      if (!ref || ref.length === 0) {
        throw new Error("setSecret: ref is required");
      }
      if (typeof secret !== "string" || secret.length === 0) {
        throw new Error("setSecret: secret must be a non-empty string");
      }
      const b = resolveBackend();
      b.set(service, ref, secret);
    },
    async deleteSecret(ref) {
      const b = resolveBackend();
      return b.delete(service, ref);
    },
  };
}

/**
 * Memoize a synchronous factory. Throws are NOT memoized — if `fn()` throws,
 * the cache stays empty and the next call retries. This matters for the
 * keychain backend resolver: transient unavailability (Linux dbus not yet
 * up, libsecret service restart) should not permanently poison the
 * keychain for the rest of the process lifetime.
 */
function memoize<T>(fn: () => T): () => T {
  let cached: { v: T } | undefined;
  return () => {
    if (cached === undefined) cached = { v: fn() };
    return cached.v;
  };
}

type NativeEntryCtor = new (
  service: string,
  account: string,
) => {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deletePassword(): boolean;
};

/** Module loader signature — pass a custom one to `loadNativeBackend` for tests. */
export type NativeKeyringLoader = () => { Entry: NativeEntryCtor };

const defaultNativeKeyringLoader: NativeKeyringLoader = () =>
  // Lazy CJS require via createRequire — defers native module load until
  // first keychain call. Import-time failures (missing dbus, no libsecret)
  // never crash the server; only direct keychain callers see the error.
  esmRequire("@napi-rs/keyring") as { Entry: NativeEntryCtor };

/**
 * Lazy-load `@napi-rs/keyring`. Wrapped in a function so import-time
 * failures never crash the server — only direct keychain callers fail.
 * The `loader` parameter is a test seam — production callers use the
 * default which calls `esmRequire("@napi-rs/keyring")`.
 */
export function loadNativeBackend(
  loader: NativeKeyringLoader = defaultNativeKeyringLoader,
): KeychainBackend {
  let nativeEntry: NativeEntryCtor;
  try {
    nativeEntry = loader().Entry;
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
