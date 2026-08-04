import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";
import {
  type CodexApprovalDecision,
  codexApprovalResult,
  isCodexApprovalMethod,
  isCodexFileChangeMethod,
} from "../../codex-agent/approval-protocol.js";
import {
  API_CODEX_APPROVAL_DECISION,
  API_CODEX_APPROVAL_REQUEST,
  API_CODEX_APPROVALS,
} from "../../shared/api-paths.js";
import type {
  CodexApprovalView,
  CodexFileChangeKind,
  CodexFileChangeView,
} from "../../shared/codex/approval.js";
import { isLoopback } from "../auth/middleware.js";
import { assertOriginAllowlisted } from "../integrations/api-routes.js";
import type { Handler } from "../mcp/routes/_shared.js";

// Re-exported so the many existing server-side importers keep working; the
// definitions themselves live in `shared/` because the client renders them.
export type { CodexApprovalView, CodexFileChangeKind, CodexFileChangeView };

const MAX_PENDING = 32;
const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TEXT = 4_000;
/** Paths render as single rows; a long one is elided, not wrapped. */
const MAX_PATH = 512;
/** Per-change diff cap. */
const MAX_DIFF = 4_000;
/**
 * Total diff budget for one approval. `/api/codex/approvals` is polled roughly
 * once a second while a request is open, so the whole response has to stay
 * small; paths are always kept, diffs are what get dropped when the budget runs
 * out.
 */
const MAX_DIFF_TOTAL = 20_000;
/** Paths listed per approval. Beyond this the count is reported, not the rows. */
const MAX_CHANGES = 64;
/** Above this, added/removed line counts are skipped rather than scanned. */
const MAX_COUNTED_BYTES = 1_000_000;

export type { CodexApprovalDecision };

interface PendingApproval {
  view: CodexApprovalView;
  method: string;
  resolve: (result: unknown) => void;
  timer: NodeJS.Timeout;
}

export class CodexApprovalBroker {
  readonly workerToken = randomBytes(32).toString("base64url");
  private readonly pending = new Map<string, PendingApproval>();

  list(): CodexApprovalView[] {
    return [...this.pending.values()].map(({ view }) => view);
  }

  request(method: string, params: unknown): { id: string; result: Promise<unknown> } {
    if (this.pending.size >= MAX_PENDING) throw new Error("Codex approval queue is full");
    const view = toApprovalView(method, params);
    const id = randomUUID();
    let resolveResult!: (result: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.resolve(decisionResult(method, "decline"));
    }, APPROVAL_TIMEOUT_MS);
    this.pending.set(id, { view: { ...view, id }, method, resolve: resolveResult, timer });
    return { id, result };
  }

  decide(id: string, decision: CodexApprovalDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (decision === "acceptForSession" && !pending.view.allowForSession) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(decisionResult(pending.method, decision));
    return true;
  }

  cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(decisionResult(pending.method, "decline"));
  }

  authenticateWorker(header: unknown): boolean {
    if (typeof header !== "string") return false;
    const expected = Buffer.from(this.workerToken);
    const received = Buffer.from(header);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }
}

const broker = new CodexApprovalBroker();

export function getCodexApprovalBroker(): CodexApprovalBroker {
  return broker;
}

export function registerCodexApprovalRoutes(app: Express, mw: Handler): void {
  app.options(API_CODEX_APPROVALS, mw);
  app.get(API_CODEX_APPROVALS, mw, (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    res.json({ approvals: broker.list() });
  });

  app.options(API_CODEX_APPROVAL_DECISION, mw);
  app.post(API_CODEX_APPROVAL_DECISION, mw, (req: Request, res: Response) => {
    if (assertOriginAllowlisted(req, res, API_CODEX_APPROVAL_DECISION)) return;
    if (!requireLoopback(req, res)) return;
    const body = req.body as { id?: unknown; decision?: unknown } | undefined;
    if (
      typeof body?.id !== "string" ||
      !["accept", "acceptForSession", "decline"].includes(String(body.decision))
    ) {
      res.status(400).json({ error: "BAD_REQUEST", message: "invalid approval decision" });
      return;
    }
    const decided = broker.decide(body.id, body.decision as CodexApprovalDecision);
    if (!decided) {
      res.status(404).json({ error: "NOT_FOUND", message: "approval is no longer pending" });
      return;
    }
    res.json({ ok: true });
  });

  app.options(API_CODEX_APPROVAL_REQUEST, mw);
  app.post(API_CODEX_APPROVAL_REQUEST, mw, async (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    if (!broker.authenticateWorker(req.headers["x-tandem-codex-worker-token"])) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    const body = req.body as { method?: unknown; params?: unknown } | undefined;
    if (typeof body?.method !== "string" || !isCodexApprovalMethod(body.method)) {
      res.status(400).json({ error: "BAD_REQUEST", message: "unsupported approval method" });
      return;
    }
    let pending: ReturnType<CodexApprovalBroker["request"]>;
    try {
      pending = broker.request(body.method, body.params);
    } catch (err) {
      res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        message: err instanceof Error ? err.message : "approval queue is full",
      });
      return;
    }
    let finished = false;
    res.once("close", () => {
      if (!finished) broker.cancel(pending.id);
    });
    const result = await pending.result;
    finished = true;
    if (!res.headersSent) res.json({ result });
  });
}

function requireLoopback(req: Request, res: Response): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  res.status(403).json({ error: "FORBIDDEN", message: "Codex approvals are loopback-only" });
  return false;
}

function toApprovalView(method: string, params: unknown): Omit<CodexApprovalView, "id"> {
  const value = isRecord(params) ? params : {};
  const command = boundedString(value.command);
  const cwd = boundedLine(value.cwd);
  const reason = boundedString(value.reason);

  if (!isCodexFileChangeMethod(method)) {
    return {
      kind: "command",
      title: "Codex wants to run a command",
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(reason ? { reason } : {}),
      createdAt: Date.now(),
      allowForSession: true,
    };
  }

  const { changes, omittedChanges } = extractFileChanges(value);
  const grantRoot = boundedLine(value.grantRoot ?? value.grant_root);
  return {
    kind: "file-change",
    title: "Codex wants to change files",
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(reason ? { reason } : {}),
    changes,
    ...(omittedChanges > 0 ? { omittedChanges } : {}),
    ...(grantRoot ? { grantRoot } : {}),
    createdAt: Date.now(),
    allowForSession: changes.length > 0,
  };
}

/**
 * Normalize Codex's change set into rows the dialog can render.
 *
 * Tolerant by design: the app-server has shipped the change set as a
 * path-keyed map (`fileChanges` / `file_changes`, values tagged
 * `{add|delete|update}`) and as an array of flat records, in both camelCase and
 * snake_case, across versions. Anything unrecognised degrades to `kind:
 * "unknown"` with the path still shown, and a request that yields no rows at
 * all loses its "Allow for session" button rather than granting blind.
 */
function extractFileChanges(params: Record<string, unknown>): {
  changes: CodexFileChangeView[];
  omittedChanges: number;
} {
  const entries = collectChangeEntries(params);
  const changes: CodexFileChangeView[] = [];
  let budget = MAX_DIFF_TOTAL;
  for (const [rawPath, spec] of entries.slice(0, MAX_CHANGES)) {
    const path = boundedLine(rawPath, MAX_PATH);
    if (!path) continue;
    const change = normalizeChange(path, spec, Math.min(MAX_DIFF, budget));
    budget -= change.diff?.length ?? 0;
    changes.push(change);
  }
  return { changes, omittedChanges: Math.max(0, entries.length - changes.length) };
}

function collectChangeEntries(params: Record<string, unknown>): [unknown, unknown][] {
  const candidates = [params.fileChanges, params.file_changes, params.changes];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((item) => {
        const record = isRecord(item) ? item : {};
        return [record.path ?? record.file ?? record.filePath ?? record.file_path, record];
      });
    }
    if (isRecord(candidate)) return Object.entries(candidate);
  }
  return [];
}

function normalizeChange(path: string, spec: unknown, diffBudget: number): CodexFileChangeView {
  const record = isRecord(spec) ? spec : {};
  const { kind, body } = pickVariant(record);
  const raw = firstString(body, [
    "unifiedDiff",
    "unified_diff",
    "diff",
    "content",
    "newContent",
    "new_content",
  ]);
  const movePath = boundedLine(body.movePath ?? body.move_path, MAX_PATH);
  const diff = raw && diffBudget > 0 ? boundedText(raw, diffBudget) : undefined;
  // Keyed off the raw length against the cap, not the emitted length: control
  // stripping also shortens the text, and a diff flagged as possibly-incomplete
  // is a far better failure than one silently presented as whole.
  const diffTruncated = raw ? !diff || raw.length > diffBudget : false;
  return {
    path,
    kind,
    ...(movePath ? { movePath } : {}),
    ...(diff ? { diff } : {}),
    ...(diffTruncated ? { diffTruncated: true } : {}),
    ...countChangedLines(kind, raw),
  };
}

/** Tagged-union form (`{ update: {...} }`) first, then a flat `kind`/`type` field. */
function pickVariant(record: Record<string, unknown>): {
  kind: CodexFileChangeKind;
  body: Record<string, unknown>;
} {
  for (const key of ["add", "delete", "update"] as const) {
    if (record[key] === undefined) continue;
    return { kind: key, body: isRecord(record[key]) ? record[key] : {} };
  }
  const tag = typeof record.kind === "string" ? record.kind : record.type;
  const kind = tag === "add" || tag === "delete" || tag === "update" ? tag : ("unknown" as const);
  return { kind, body: record };
}

/**
 * Counted from the FULL text, before the diff is capped — so a change set too
 * large to display still tells the user how much it moves.
 */
function countChangedLines(
  kind: CodexFileChangeKind,
  raw: string | undefined,
): { added?: number; removed?: number } {
  if (!raw || raw.length > MAX_COUNTED_BYTES) return {};
  if (kind === "delete") return {};
  // An added file is all-new content, not a diff: every line counts, minus the
  // empty tail a trailing newline produces.
  if (kind === "add") return { added: raw.replace(/\n$/, "").split("\n").length, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of raw.split("\n")) {
    // `+++`/`---` are the unified-diff file headers, not content.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}

function decisionResult(method: string, decision: CodexApprovalDecision): unknown {
  return codexApprovalResult(method, decision);
}

/** Strip terminal controls, keeping tabs and newlines (a diff needs both). */
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return (
    value
      .slice(0, max * 2)
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal controls
        /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
        "",
      )
      .slice(0, max) || undefined
  );
}

function boundedString(value: unknown): string | undefined {
  return boundedText(value, MAX_TEXT);
}

/**
 * A path or root renders as one row. A newline inside it would let a crafted
 * change set forge extra rows in the list the user is approving, so whitespace
 * collapses rather than surviving.
 */
function boundedLine(value: unknown, max = MAX_TEXT): string | undefined {
  return boundedText(value, max)?.replace(/[\t\r\n]+/g, " ") || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
