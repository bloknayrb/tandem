import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Express, Request, Response } from "express";

import {
  API_CODEX_APPROVAL_DECISION,
  API_CODEX_APPROVAL_REQUEST,
  API_CODEX_APPROVALS,
} from "../../shared/api-paths.js";
import { isLoopback } from "../auth/middleware.js";
import { assertOriginAllowlisted } from "../integrations/api-routes.js";
import type { Handler } from "../mcp/routes/_shared.js";

const MAX_PENDING = 32;
const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TEXT = 4_000;

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline";

export interface CodexApprovalView {
  id: string;
  kind: "command" | "file-change";
  title: string;
  command?: string;
  cwd?: string;
  reason?: string;
  createdAt: number;
  allowForSession: boolean;
}

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
    if (typeof body?.method !== "string" || !isSupportedApprovalMethod(body.method)) {
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

function isSupportedApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}

function toApprovalView(method: string, params: unknown): Omit<CodexApprovalView, "id"> {
  const value = isRecord(params) ? params : {};
  const command = boundedString(value.command);
  const cwd = boundedString(value.cwd);
  const reason = boundedString(value.reason);
  const fileChange =
    method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
  return {
    kind: fileChange ? "file-change" : "command",
    title: fileChange ? "Codex wants to change files" : "Codex wants to run a command",
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(reason ? { reason } : {}),
    createdAt: Date.now(),
    allowForSession: true,
  };
}

function decisionResult(method: string, decision: CodexApprovalDecision): unknown {
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  if (!legacy) return { decision };
  if (decision === "accept") return { decision: "approved" };
  if (decision === "acceptForSession") return { decision: "approved_for_session" };
  return { decision: { denied: { rejection: "Declined in Tandem" } } };
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal controls
      /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
      "",
    )
    .slice(0, MAX_TEXT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
