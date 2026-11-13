import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOpenDocs } from "../../../src/server/documents/registry.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
} from "../../../src/server/documents/registry-testing.js";
import { resetForTesting as resetQueue } from "../../../src/server/events/queue.js";
import { createLocalModelCollaborator } from "../../../src/server/local-model/collaborator.js";
import type { LoopResult } from "../../../src/server/local-model/index.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import { LOCAL_RUN_GENERATION } from "../../../src/server/models/local-run-generation.js";
import { getOrCreateDocument } from "../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../../src/shared/origins.js";
import type { ChatMessage } from "../../../src/shared/types.js";

/**
 * #1123 A1, review round 1 item 10: a run whose reply the licence refused at
 * its first chat write records `stopped/aborted` (as `LocalRunStopReason`
 * documents), never `no-reply`. The collaborator's own licence check is
 * injected as "admit", so the run starts; the chat write's admission point
 * (`appendClaudeChatMessage` → `aiRefusal`) is what refuses, as when a licence
 * lapses mid-run.
 */
const refuse = vi.hoisted(() => ({ on: false }));
vi.mock("../../../src/server/license/ai-refusal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/server/license/ai-refusal.js")>();
  return {
    ...actual,
    aiRefusal: () =>
      refuse.on
        ? { error: "LICENSE_REQUIRED" as const, kind: "unlicensed" as const, message: "x" }
        : null,
  };
});

function clean(): LoopResult {
  return {
    metrics: {
      turns: 1,
      toolCalls: 0,
      jsonParseFailures: 0,
      anchorResolutionFailures: 0,
      flatOnlyAnchors: 0,
      replyFailures: 0,
      wallMs: 1,
      exit: "clean",
    },
    steps: [],
    finalContent: "",
    messages: [],
  };
}

const chatMap = () => getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);

beforeEach(() => {
  resetQueue();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    chatMap().clear();
    ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "tandem");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  refuse.on = false;
  vi.restoreAllMocks();
});

describe("run state when the licence refuses the reply (#1123 R3.4)", () => {
  for (const refused of [true, false]) {
    it(
      refused ? "refused at the first write: stopped, aborted" : "positive control: replied",
      async () => {
        refuse.on = refused;
        const ydoc = getOrCreateDocument("doc-lic");
        populateYDoc(ydoc, "Body");
        addDoc("doc-lic", {
          id: "doc-lic",
          filePath: "/tmp/doc-lic.md",
          format: "md",
          readOnly: false,
          source: "file",
        });
        setActiveDocId("doc-lic");
        const ctrl = getOrCreateDocument(CTRL_ROOM);
        const msg: ChatMessage = {
          id: "u1",
          author: "user",
          text: "hi",
          timestamp: Date.now(),
          read: false,
          documentId: "doc-lic",
        };
        withBrowser(ctrl, () => chatMap().set("u1", msg));
        const collab = createLocalModelCollaborator({
          runTurn: async (o) => {
            o.onContentDelta?.("an answer");
            return clean();
          },
          resolveConfig: () => ({
            endpoint: "http://127.0.0.1:11434",
            modelId: "m",
            transport: "v1",
            agentIdentity: { provider: "local-ollama", displayName: "M" },
          }),
          subscribe: () => {},
          unsubscribe: () => {},
          aiRefusal: () => null,
          chatAnswerer: () => "local",
        });
        collab.onEvent({
          id: "e",
          type: "chat:message",
          timestamp: Date.now(),
          documentId: "doc-lic",
          payload: { messageId: "u1", text: "hi", replyTo: null, anchor: null },
        });
        await Promise.resolve();
        await collab.__awaitCurrent();
        const state = (chatMap().get("u1") as ChatMessage).localRun;
        if (refused) {
          expect(state).toEqual({
            status: "stopped",
            reason: "aborted",
            generation: LOCAL_RUN_GENERATION,
          });
        } else {
          expect(state?.status).toBe("replied");
        }
      },
    );
  }
});
