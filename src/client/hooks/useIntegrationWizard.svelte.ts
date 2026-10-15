/**
 * Integration wizard state machine.
 *
 * Drives the wizard modal through three steps (+ error):
 *   connect  — `GET /api/integrations/existing` populates the "we found these"
 *              card list from `~/.claude.json` + Claude Desktop config.
 *              Selectable installs are preselected as soon as detection
 *              resolves (`isSelectable` — see below). The user toggles cards
 *              and may optionally store an auth token per integration under
 *              an Advanced disclosure: the token goes to the keychain backend
 *              under a client-generated opaque `ref` (`makeSecretRef`), which
 *              is then recorded on the integration config as `tokenSecretRef`.
 *              A `KEYCHAIN_UNAVAILABLE` result flips the disclosure into
 *              env-var fallback guidance — the user is told to set
 *              `TANDEM_INTEGRATION_<id>_TOKEN` instead, and the integration
 *              is saved without a `tokenSecretRef`.
 *   applying — `save()` in flight: `POST /api/integrations` persists, then
 *              `POST /api/integrations/apply` writes Claude's config.
 *   done     — per-integration apply outcomes.
 *
 * The wizard never owns secrets in memory beyond the duration of the
 * Advanced disclosure — each `setSecret` happens immediately on submit, not
 * batched, so an interrupted session doesn't strand a secret in the page's
 * heap. The keychain backend abstracts the transport: HTTP loopback to
 * `POST /api/integrations/secrets/:ref` on the npm CLI path, and a direct Rust
 * `invoke` in the desktop app (secrets never cross the loopback boundary
 * there — see `keychain-backend.ts`). `KEYCHAIN_UNAVAILABLE` is one possible
 * backend outcome, not a guaranteed desktop one.
 */

import {
  API_INTEGRATIONS,
  API_INTEGRATIONS_APPLY,
  API_INTEGRATIONS_EXISTING,
  API_INTEGRATIONS_WALKTHROUGH_CONFIRM,
  type ApplyItemResult,
  type ApplyResponse,
  ERROR_CODE_WALKTHROUGH_NOT_PENDING,
  type ExistingMcpInstall,
  type IntegrationConfig,
  type IntegrationsFile,
} from "../../shared/integrations/contract.js";
import {
  isTandemClaudeAfterSetup,
  type TandemClaudeAfterSetup,
} from "../../shared/launcher/contract";
import {
  type ClientKeychainBackend,
  createDefaultKeychainBackend,
} from "../keychain/keychain-backend.js";
import { MCP_BASE_URL } from "../utils/backend-ports.js";
import { responseErrorMessage } from "../utils/response-error.js";
import {
  buildSaveFile,
  isSomethingSetUp,
  matchRecord,
  normalizeConfigPath,
  preselects,
  recordToConfig,
  refsOf,
  tandemEntryValidationFailed,
} from "./integration-wizard-merge.js";

export type WizardStep = "connect" | "applying" | "done" | "error";

const UNREADABLE_SAVED_SETUP = "Could not read your saved Tandem setup. Try again.";
const SAVED_SETUP_CHANGED =
  "Your saved Tandem setup changed while this window was open. Try again to see it as it is now.";

export interface PickedIntegration {
  /** Stable client-side id, mirrored into `IntegrationConfig.id` on save. */
  id: string;
  config: IntegrationConfig;
  /** True once a token has been stored in the keychain for this integration
   *  (the ref itself lives on `config.tokenSecretRef`); drives the "Token
   *  saved" UI state. */
  hasStoredSecret: boolean;
  /** True iff the server returned 503 KEYCHAIN_UNAVAILABLE for this integration's setSecret. */
  keychainUnavailable: boolean;
  /** Built from a saved record (#2198): its id and `tokenSecretRef` are the
   * record's, so the wizard must never delete that ref on its own. */
  fromRecord?: true;
}

export interface IntegrationWizardState {
  readonly step: WizardStep;
  /** True while `begin()`'s detection fetch is in flight. Distinguishes the
   *  connect screen's loading sub-state from a genuine "nothing detected"
   *  empty state (`existing` is `[]` in both). Initializes `true` so the
   *  first paint (before the open-effect's `begin()` runs) shows loading
   *  rather than flashing the empty state. */
  readonly detecting: boolean;
  readonly existing: ExistingMcpInstall[];
  readonly picked: PickedIntegration[];
  readonly errorMessage: string | null;
  /** Per-integration apply outcomes after save() succeeds. Populated only when
   *  step === "done"; consult the `status === "error"` items to surface
   *  per-row error UX in the wizard's done step. */
  readonly applyResults: ApplyItemResult[];
  /** What the apply did about Tandem's own Claude (#2197), or null when no
   * claude-code entry was written or the server is older. */
  readonly tandemClaude: TandemClaudeAfterSetup | null;
  /**
   * Whether real-time push (the `tandem-channel` shim entry) actually landed on
   * disk for an applied claude-code target, determined by a post-apply re-read
   * of the detected entries (WS-B). `true` → push configured (Claude gets pushed
   * events after a restart); `false` → polling only; `null` → not yet
   * determined (or no claude-code target), so the done step shows nothing rather
   * than flashing a wrong label. This is a CONFIG-presence fact, never a runtime
   * "push is live now" claim — the shim still needs Claude to restart + connect.
   */
  readonly channelRegistered: boolean | null;
  /** Whether the keychain is known-unavailable on this server (set after first 503). */
  readonly keychainUnavailable: boolean;
  /** Something is already set up (#2198): a saved Claude record, or a valid
   * Tandem entry on disk — what the walkthrough's Keep keeps. */
  readonly hasSetupToKeep: boolean;
  /** Set when the walkthrough's Keep fails; the wizard stays open. */
  readonly keepError: string | null;
  begin(): Promise<void>;
  /**
   * Re-read the detected installs WITHOUT starting over (#2199) — after the
   * wizard installed Claude Code, or on the offer's Check again. The user's
   * picks are kept; nothing they unticked comes back. `pickNewOfKind` ticks
   * an install of that kind that was not detected before this call — the
   * Install click is the opt-in (Bryan, 2026-10-14). Joins the current
   * `begin()`: a response landing after `reset()` or a newer `begin()` is
   * dropped. Resolves the newly detected installs (empty when none, or when
   * the read failed or was superseded).
   */
  refreshDetected(opts?: {
    pickNewOfKind?: ExistingMcpInstall["target"]["kind"];
  }): Promise<ExistingMcpInstall[]>;
  setPicked(picked: PickedIntegration[]): void;
  /** The card for a detected install: from its saved record when it has one
   * (so re-checking a card never mints a fresh id or drops its fields). */
  pickedForInstall(install: ExistingMcpInstall): PickedIntegration | null;
  /** The v1.0 walkthrough's Keep this setup (#2198). Writes the walkthrough
   * marker on the server and nothing else; true on success. */
  keepSetup(serverVersion: string): Promise<boolean>;
  submitSecret(picked: PickedIntegration, secret: string): Promise<void>;
  save(): Promise<void>;
  reset(): void;
  /** Delete keychain secrets stored under Advanced but never persisted (the
   *  user dismissed before saving). No-op unless step === "connect", so it can
   *  never delete a live, file-referenced ref. Call BEFORE reset(). */
  cleanupUnsavedSecrets(): Promise<void>;
}

// The single source of truth for a hand-edited entry lives with the merge that
// turns it into `apply: "skip"`; re-exported for the card's status line.
export { tandemEntryValidationFailed };

/**
 * The message for a fetch that never reached the server — or null for any
 * other error. A network failure (server not up yet — common on first launch)
 * rejects with a TypeError whose message varies by engine: Chromium "Failed to
 * fetch", WKWebView (Tauri macOS) "Load failed", Firefox "NetworkError when
 * attempting to fetch resource". Gated on the message so a genuine programming
 * TypeError falls through to its real text instead of being mislabeled
 * "server unreachable".
 */
function networkErrorMessage(err: unknown): string | null {
  return err instanceof TypeError && /fetch|load failed|network/i.test(err.message)
    ? "Could not reach the Tandem server. Make sure Tandem is running, then try again."
    : null;
}

/**
 * Whether a detected install should be offered (and preselected) for
 * connection — readable on disk AND not locked by a failed entry validation.
 */
export function isSelectable(install: ExistingMcpInstall): boolean {
  const readable = install.status === "ok" || install.status === "missing";
  return readable && !tandemEntryValidationFailed(install);
}

/**
 * Generate a tokenSecretRef for a picked integration. Uses the integration's
 * `id` + a CSPRNG-derived suffix so the keychain entry is identifiable in OS
 * keychain UIs ("tandem-integrations / cc-1-9f3a…") and a refused-write retry
 * doesn't reuse a stale ref.
 *
 * `crypto.randomUUID()` provides 122 bits of CSPRNG entropy — far more than
 * needed for collision resistance among a single user's keychain entries.
 * Math.random() is not cryptographically secure (CodeQL js/insecure-randomness)
 * and would be misleading in this security context even if practically safe.
 */
function makeSecretRef(integrationId: string): string {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${integrationId}-${suffix}`;
}

/**
 * Build a stable id. `Date.now()` has only millisecond resolution and
 * `IntegrationsFileSchema` doesn't reject duplicate ids — two rapid picks
 * in the same tick would silently overwrite each other downstream.
 */
function newPickedId(kindPrefix: string): string {
  return `${kindPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Map a detected install to a fresh `PickedIntegration`. Returns null for
 * target kinds the wizard can't auto-configure (none today — detection only
 * surfaces claude-code / claude-desktop — but the shape is future-proof).
 */
export function detectedToPicked(install: ExistingMcpInstall): PickedIntegration | null {
  if (install.target.kind === "claude-code") {
    const url = install.tandemEntry?.url ?? MCP_BASE_URL;
    const id = newPickedId("claude-code");
    return {
      id,
      config: {
        kind: "claude-code",
        id,
        label: install.target.label,
        configPath: install.target.configPath,
        transport: "http",
        url,
      },
      hasStoredSecret: false,
      keychainUnavailable: false,
    };
  }
  if (install.target.kind === "claude-desktop") {
    const id = newPickedId("claude-desktop");
    return {
      id,
      config: {
        kind: "claude-desktop",
        id,
        label: install.target.label,
        configPath: install.target.configPath,
        transport: "stdio",
      },
      hasStoredSecret: false,
      keychainUnavailable: false,
    };
  }
  return null;
}

export interface IntegrationWizardOptions {
  /** Override `window.fetch` for tests. */
  fetchFn?: typeof fetch;
  /**
   * Override the base URL for API calls. Defaults to same-origin (empty string),
   * which is what the dev Vite server proxies and what production serves.
   */
  baseUrl?: string;
  /**
   * Inject a custom keychain backend. Defaults to
   * `createDefaultKeychainBackend()` which picks Tauri commands when running
   * inside the desktop app and the HTTP loopback elsewhere. Tests pass a
   * stub backend so the wizard logic can be verified without either transport.
   */
  keychainBackend?: ClientKeychainBackend;
}

export function createIntegrationWizard(
  opts: IntegrationWizardOptions = {},
): IntegrationWizardState {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.baseUrl ?? "";
  const keychainBackend =
    opts.keychainBackend ?? createDefaultKeychainBackend({ fetchFn, baseUrl });

  let step = $state<WizardStep>("connect");
  // True so the first paint (before the open-effect's begin()) shows the
  // loading sub-state instead of flashing "nothing detected".
  let detecting = $state(true);
  let existing = $state<ExistingMcpInstall[]>([]);
  let picked = $state<PickedIntegration[]>([]);
  let errorMessage = $state<string | null>(null);
  let applyResults = $state<ApplyItemResult[]>([]);
  let tandemClaude = $state<TandemClaudeAfterSetup | null>(null);
  // Post-apply push-vs-polling readout (WS-B). `null` until the post-apply
  // re-read of detected entries resolves — never flash a wrong label.
  let channelRegistered = $state<boolean | null>(null);
  let keychainUnavailable = $state(false);
  let keepError = $state<string | null>(null);
  // The saved setup (#2198), read with detection. `savedRecords` drives the
  // pre-fill and `hasSetupToKeep`; the rest are the merge's baselines, plain
  // (non-reactive) because nothing renders them.
  let savedRecords = $state<IntegrationConfig[]>([]);
  /** Every ref the saved file holds: never deleted by the wizard's own
   * clean-ups, which exist for refs minted this session. */
  let persistedRefs = new Set<string>();
  let originalRefs = new Map<string, string | undefined>();
  /** Saved records the user unchecked this session → kept as `skip`. */
  let deselected = new Set<string>();
  // Monotonic generation counter for `begin()` — a later run invalidates
  // earlier in-flight responses so rapid open/close/reopen can't have the
  // earlier request's response clobber the later one's state.
  let beginGen = 0;

  const setError = (msg: string) => {
    errorMessage = msg;
    step = "error";
    detecting = false;
  };

  /** The saved setup (#2198), or a throw carrying the message to show. */
  const readSavedSetup = async (): Promise<IntegrationsFile> => {
    const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS}`);
    if (!res.ok) {
      throw new Error(
        await responseErrorMessage(
          res,
          `Could not read your saved Tandem setup (HTTP ${res.status}).`,
        ),
      );
    }
    const saved = (await res.json()) as IntegrationsFile | null;
    if (!Array.isArray(saved?.integrations)) throw new Error(UNREADABLE_SAVED_SETUP);
    return saved;
  };

  const begin = async () => {
    const myGen = ++beginGen;
    detecting = true;
    step = "connect";
    errorMessage = null;
    try {
      // The saved setup is read alongside detection (#2198). A failed read
      // stops the wizard rather than falling back to detection alone: a save
      // built without it is the whole-file clobber the merge exists to prevent.
      const [res, saved] = await Promise.all([
        fetchFn(`${baseUrl}${API_INTEGRATIONS_EXISTING}`),
        readSavedSetup(),
      ]);
      if (myGen !== beginGen) return; // a newer begin() ran; drop this response
      if (!res.ok) {
        // #1792: a downgraded `integrations.json` answers 409 with an
        // actionable `message`; without this the wizard died on a bare status
        // code. Same shape as the persist path below.
        const message = await responseErrorMessage(
          res,
          `Could not load existing entries (HTTP ${res.status}).`,
        );
        if (myGen !== beginGen) return;
        setError(message);
        return;
      }
      const body = (await res.json()) as { installs: ExistingMcpInstall[] };
      if (myGen !== beginGen) return;
      const records = saved.integrations;
      existing = body.installs;
      savedRecords = records;
      persistedRefs = refsOf(records);
      originalRefs = new Map(records.map((r) => [r.id, r.tokenSecretRef]));
      deselected = new Set();
      // Preselect as soon as detection resolves — the connect screen renders
      // cards pre-checked, no separate pick step. With nothing set up that is
      // everything connectable; otherwise what is set up (#2198), each card
      // built from its saved record.
      const selective = isSomethingSetUp(body.installs, records);
      // One card per record: two installs whose paths differ only by case
      // would otherwise both claim it (and share an id).
      const claimed = new Set<string>();
      picked = body.installs.filter(isSelectable).flatMap((install) => {
        let record = matchRecord(install, records, body.installs);
        if (record && claimed.has(record.id)) record = undefined;
        if (record) claimed.add(record.id);
        if (!preselects(install, record, selective)) return [];
        const card = cardFor(install, record);
        return card ? [card] : [];
      });
    } catch (err) {
      if (myGen !== beginGen) return;
      setError(networkErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      // Only the winning generation clears the loading flag — a superseded
      // begin() finishing late must not hide the newer run's loading state.
      if (myGen === beginGen) detecting = false;
    }
  };

  const refreshDetected = async (
    opts: { pickNewOfKind?: ExistingMcpInstall["target"]["kind"] } = {},
  ): Promise<ExistingMcpInstall[]> => {
    const myGen = beginGen;
    if (step !== "connect" || detecting) return [];
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_EXISTING}`);
      if (myGen !== beginGen || step !== "connect" || !res.ok) return [];
      const body = (await res.json()) as { installs?: unknown };
      if (myGen !== beginGen || step !== "connect" || !Array.isArray(body.installs)) return [];
      const installs = body.installs as ExistingMcpInstall[];
      const known = new Set(existing.map((i) => normalizeConfigPath(i.target.configPath)));
      const fresh = installs.filter((i) => !known.has(normalizeConfigPath(i.target.configPath)));
      existing = installs;
      const kind = opts.pickNewOfKind;
      for (const install of fresh) {
        if (kind === undefined || install.target.kind !== kind || !isSelectable(install)) continue;
        // One at a time: `pickedForInstall` reads `picked`, so two new installs
        // never claim one saved record.
        const card = pickedForInstall(install);
        if (card) picked = [...picked, card];
      }
      return fresh;
    } catch {
      return [];
    }
  };

  const setPicked = (next: PickedIntegration[]) => {
    // Best-effort: if an entry that already stored a secret is removed from
    // the selection (unchecking a card after entering a token under Advanced),
    // delete its keychain ref so it isn't orphaned. The single-screen redesign
    // makes store-then-unpick reachable; the old multi-step flow picked before
    // the separate secrets step, so this couldn't happen. Errors are swallowed
    // — an unreferenced ref in the user's own keychain isn't worth a toast.
    //
    // A ref the saved file holds is never deleted here (#2198): unchecking a
    // pre-filled card keeps its record (as `skip`), and its secret with it.
    const removed = picked.filter((prev) => !next.some((n) => n.id === prev.id));
    for (const p of removed) if (p.fromRecord) deselected.add(p.id);
    for (const n of next) deselected.delete(n.id);
    picked = next;
    for (const p of removed) {
      const ref = p.config.tokenSecretRef;
      if (ref && !persistedRefs.has(ref)) void keychainBackend.delete(ref);
    }
  };

  /** A detected install's card: from its saved record when it has one. */
  const cardFor = (
    install: ExistingMcpInstall,
    record: IntegrationConfig | undefined,
  ): PickedIntegration | null => {
    if (!record) return detectedToPicked(install);
    return {
      id: record.id,
      config: recordToConfig(install, record),
      hasStoredSecret: typeof record.tokenSecretRef === "string",
      keychainUnavailable: false,
      fromRecord: true,
    };
  };

  const pickedForInstall = (install: ExistingMcpInstall): PickedIntegration | null => {
    const record = matchRecord(install, savedRecords, existing);
    // A record another card already holds is not this install's.
    const taken = record !== undefined && picked.some((p) => p.id === record.id);
    return cardFor(install, taken ? undefined : record);
  };

  const submitSecret = async (target: PickedIntegration, secret: string) => {
    const ref = makeSecretRef(target.id);
    const result = await keychainBackend.set(ref, secret);
    if (result.status === "unavailable") {
      keychainUnavailable = true;
      picked = picked.map((p) => (p.id === target.id ? { ...p, keychainUnavailable: true } : p));
      return;
    }
    if (result.status === "error") {
      // The ref is never recorded on the picked entry below, so neither
      // cleanupStoredSecrets nor the unpick cleanup could ever find it if the
      // backend wrote it but then failed the response. Best-effort delete of
      // the freshly-generated ref undoes a possible partial write (a no-op if
      // nothing was stored).
      void keychainBackend.delete(ref);
      setError(`Could not store secret: ${result.message}`);
      return;
    }
    picked = picked.map((p) =>
      p.id === target.id
        ? {
            ...p,
            config: { ...p.config, tokenSecretRef: ref } as IntegrationConfig,
            hasStoredSecret: true,
            keychainUnavailable: false,
          }
        : p,
    );
  };

  /**
   * Best-effort cleanup: when save fails after `submitSecret` calls have
   * already stored secrets in the OS keychain, delete each one so the user
   * isn't left with orphan credentials referenced by no integrations file.
   * Errors are swallowed because cleanup is post-failure — surfacing a
   * second error would replace the more actionable original.
   */
  const cleanupStoredSecrets = async (): Promise<void> => {
    // Only refs minted this session: a saved one is still referenced by the
    // file on disk, and deleting it is the SECRET_MISSING orphan (#2198).
    const storedRefs = [...refsOf(picked.map((p) => p.config))].filter(
      (ref) => !persistedRefs.has(ref),
    );
    await Promise.all(storedRefs.map((ref) => keychainBackend.delete(ref)));
  };

  /**
   * Two-call sequence separating intent (persist) from side-effect (apply)
   * — see ADR-038 §2b. The apply response flows back through
   * `applyResults` so the done step can surface per-integration failures.
   */
  /**
   * Post-apply re-read of detected entries, to report whether the channel-shim
   * (real-time push) entry actually landed on disk. Best-effort: a failed read
   * leaves `channelRegistered` null and the done step simply omits the line. The
   * `step === "done"` guard stops a late resolve from writing after a
   * close/reopen. NOT keyed per-target — an aggregate "any applied claude-code
   * target got a valid channel entry" is enough for the single info line.
   */
  const refreshChannelRegistered = async () => {
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_EXISTING}`);
      if (!res.ok) return;
      const body = (await res.json()) as { installs: ExistingMcpInstall[] };
      if (step !== "done") return;
      channelRegistered = body.installs.some(
        (i) =>
          i.target.kind === "claude-code" &&
          i.channelEntry !== undefined &&
          i.channelValidation?.status === "valid",
      );
    } catch {
      // best-effort — leave channelRegistered null
    }
  };

  const save = async () => {
    step = "applying";
    channelRegistered = null;
    // Re-read the saved setup (#2198): the wizard may have been open for
    // minutes, and a working-directory change persisted meanwhile must not be
    // overwritten by the copy read at begin().
    let saved: IntegrationsFile;
    try {
      saved = await readSavedSetup();
    } catch (err) {
      await cleanupStoredSecrets();
      setError(networkErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)));
      return;
    }
    // Apply intent per card (a hand-edited entry that failed validation is
    // "skip"), the saved records the wizard does not own kept as they are,
    // and the file in its original order — see integration-wizard-merge.ts.
    const { file, applyIds, superseded, stale } = buildSaveFile({
      saved,
      picked,
      existing,
      deselected,
      originalRefs,
    });
    if (stale) {
      // A saved record changed under the wizard: re-adding it from the copy
      // read at open would undo that change (or duplicate a re-keyed record).
      await cleanupStoredSecrets();
      setError(SAVED_SETUP_CHANGED);
      return;
    }
    // Once persist returns 200 the integrations file on disk durably
    // references the stored keychain refs, so the catch below must NOT delete
    // them — doing so would dangle the persisted config (and, if apply also
    // ran, Claude's freshly-written config), surfacing as a SECRET_MISSING
    // failure on next use with no trace of the deletion. Only the pre-persist
    // failure path cleans up. Realistic post-persist throw vectors: a network
    // drop before/after the apply fetch, or an unguarded `.json()` parse of a
    // malformed 200 body (lines below).
    let persisted = false;
    try {
      const persistRes = await fetchFn(`${baseUrl}${API_INTEGRATIONS}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(file),
      });
      if (!persistRes.ok) {
        const body = (await persistRes.json().catch(() => null)) as { message?: string } | null;
        await cleanupStoredSecrets();
        setError(body?.message ?? `Could not save (HTTP ${persistRes.status}).`);
        return;
      }
      persisted = true;
      // The new file holds these refs now; the ones a new token replaced are
      // referenced by nothing, so they go — only now, never before the persist.
      persistedRefs = refsOf(file.integrations);
      for (const ref of superseded) void keychainBackend.delete(ref);
      const persistBody = (await persistRes.json()) as {
        ids: string[];
        confirmationNonce: string;
      };

      // Apply — write the PICKED entries to Claude's config. Never the
      // server's full id list: a kept `other-mcp` record would answer
      // OTHER_MCP_NOT_APPLICABLE, and a kept record for a target the user did
      // not pick would be written to a config they never chose (#2198).
      const applyRes = await fetchFn(`${baseUrl}${API_INTEGRATIONS_APPLY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: applyIds,
          confirmationNonce: persistBody.confirmationNonce,
        }),
      });
      if (!applyRes.ok) {
        const body = (await applyRes.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `Could not apply (HTTP ${applyRes.status}).`);
        return;
      }
      const applyBody = (await applyRes.json()) as ApplyResponse;
      applyResults = applyBody.results;
      tandemClaude = isTandemClaudeAfterSetup(applyBody.tandemClaude)
        ? applyBody.tandemClaude
        : null;
      step = "done";
      // Re-read entries so the done step can honestly report push-vs-polling —
      // the pre-apply `existing` snapshot predates the channel-entry write.
      void refreshChannelRegistered();
    } catch (err) {
      // Skip cleanup once persisted — see the comment above the try.
      if (!persisted) await cleanupStoredSecrets();
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const keepSetup = async (serverVersion: string): Promise<boolean> => {
    keepError = null;
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_WALKTHROUGH_CONFIRM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverVersion }),
      });
      // Kept already (another tab, a double click): the walkthrough is done,
      // which is what Keep wanted.
      if (res.status === 409) {
        const body = (await res
          .clone()
          .json()
          .catch(() => null)) as { code?: string } | null;
        if (body?.code === ERROR_CODE_WALKTHROUGH_NOT_PENDING) return true;
      }
      if (!res.ok) {
        keepError = await responseErrorMessage(
          res,
          `Could not save that you kept your setup (HTTP ${res.status}).`,
        );
        return false;
      }
      return true;
    } catch (err) {
      keepError = networkErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const reset = () => {
    // Anything still in flight belongs to the wizard as it was.
    beginGen++;
    step = "connect";
    detecting = false;
    existing = [];
    picked = [];
    savedRecords = [];
    persistedRefs = new Set();
    originalRefs = new Map();
    deselected = new Set();
    keepError = null;
    errorMessage = null;
    applyResults = [];
    tandemClaude = null;
    channelRegistered = null;
    keychainUnavailable = false;
  };

  /**
   * Delete keychain secrets stored under Advanced but never persisted — the
   * user pasted a token then dismissed before saving. Gated on `step ===
   * "connect"`: a live, file-referenced ref only exists once persist succeeds,
   * after which step is "done" or "error" — never "connect" — so this can
   * never re-introduce the SECRET_MISSING orphan that 498b7bb fixed. Reads
   * `picked` synchronously (via cleanupStoredSecrets) so callers may invoke it
   * immediately before reset() clears `picked`.
   */
  const cleanupUnsavedSecrets = async (): Promise<void> => {
    if (step !== "connect") return;
    await cleanupStoredSecrets();
  };

  return {
    get step() {
      return step;
    },
    get detecting() {
      return detecting;
    },
    get existing() {
      return existing;
    },
    get picked() {
      return picked;
    },
    get errorMessage() {
      return errorMessage;
    },
    get applyResults() {
      return applyResults;
    },
    get tandemClaude() {
      return tandemClaude;
    },
    get channelRegistered() {
      return channelRegistered;
    },
    get keychainUnavailable() {
      return keychainUnavailable;
    },
    get hasSetupToKeep() {
      return isSomethingSetUp(existing, savedRecords);
    },
    get keepError() {
      return keepError;
    },
    begin,
    refreshDetected,
    setPicked,
    pickedForInstall,
    keepSetup,
    submitSecret,
    save,
    reset,
    cleanupUnsavedSecrets,
  };
}
