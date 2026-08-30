/**
 * ADR-035 Unit 8e: the remove family behind the lifecycle seam.
 *
 * Three things this file exists to pin that nothing else could:
 *
 * 1. **The ROUTE, not the mechanism.** `adr027-note-write-guards.test.ts` pins
 *    that `removeAnnotationRecord` does not refuse a note. That spec stays green
 *    if someone rewires `routes/remove-annotation.ts` to call the guarded
 *    `lifecycle.remove` — which is #1680 verbatim, in a new location. Only a
 *    spec that drives `handleRemoveAnnotation` can tell "the browser can archive
 *    its own note" from "a function the browser used to call can."
 * 2. **Origin.** Unit 8e is the first thing to assert that the browser's Archive
 *    writes under `browser` and Claude's remove under `mcp`. Before it, nothing
 *    in `tests/server/` asserted an origin on this path at all, which is how a
 *    user action stayed tagged as Claude's for as long as it did.
 * 3. **Stderr silence on the delete path.** Moving to `withBrowser` takes the
 *    delete out of `CHANNEL_SKIP`, so the channel observer starts walking it —
 *    and `narrowForChannel(undefined)` refuses a delete with `reason: "missing"`,
 *    which `isNoteworthyRefusal` treats as worth logging. Without the
 *    `action === "delete"` early return in `events/observers/annotations.ts`,
 *    every Archive click prints a corruption-shaped line. That early return is
 *    unobservable from any other assertion in the suite.
 */

import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAnnotationRecord } from "../../src/server/annotations/lifecycle.js";
import { makeAnnotationsObserver } from "../../src/server/events/observers/annotations.js";
import { addReplyToAnnotation, createAnnotation } from "../../src/server/mcp/annotations.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { handleRemoveAnnotation } from "../../src/server/mcp/routes/remove-annotation.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { TandemEvent } from "../../src/shared/events/types.js";
import { BROWSER_ORIGIN, MCP_ORIGIN, withBrowser, withMcp } from "../../src/shared/origins.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { unanchored } from "../helpers/positions.js";

beforeEach(() => clearOpenDocs());

function mockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

const reqWith = (body: unknown) => ({ body }) as unknown as Request;

describe("the browser's Archive route — ADR-027 (#1680), pinned at the ROUTE", () => {
  it("removes the user's own private note, and its private reply thread", () => {
    const ydoc = setupDoc("rm-route-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "note", unanchored(0, 5), "private thought");
    addReplyToAnnotation(ydoc, map, id, "to myself", "user");
    expect((map.get(id) as { type: string }).type, "fixture precondition").toBe("note");

    const res = mockRes();
    handleRemoveAnnotation(reqWith({ annotationId: id, documentId: "rm-route-note" }), res);

    // The status is the whole finding. Route this handler through
    // `lifecycle.remove` and it becomes 404 with the note still present — which
    // is exactly the shape of the bug #1680 fixed, and every other spec in the
    // suite stays green through it.
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ data: { removed: true, annotationId: id } });
    expect(map.has(id), "the note is gone").toBe(false);
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size, "and so is its thread").toBe(0);
  });

  it("404s an unknown id without touching the map", () => {
    const ydoc = setupDoc("rm-route-404", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", unanchored(0, 5), "keep me");

    const res = mockRes();
    handleRemoveAnnotation(reqWith({ annotationId: "nope", documentId: "rm-route-404" }), res);

    expect(res._status).toBe(404);
    expect(map.size, "the real annotation survives").toBe(1);
  });
});

describe("Claude's remove — the guard is at the lifecycle, not the mechanism", () => {
  it("refuses a note by INVALID_ARGUMENT and leaves the record and its thread", () => {
    const ydoc = setupDoc("rm-claude-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "note", unanchored(0, 5), "private thought");
    addReplyToAnnotation(ydoc, map, id, "to myself", "user");
    const store = new YDocStore(ydoc, "/tmp/rm-claude-note.md", "rm-claude-note");

    const result = store.removeAnnotation(id);

    expect(result.kind).toBe("invalid-note");
    expect(map.has(id)).toBe(true);
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size, "the thread survives too").toBe(1);
  });

  it("removes a comment", () => {
    const ydoc = setupDoc("rm-claude-ok", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "fine");
    const store = new YDocStore(ydoc, "/tmp/rm-claude-ok.md", "rm-claude-ok");

    expect(store.removeAnnotation(id)).toStrictEqual({ kind: "ok", id });
    expect(map.has(id)).toBe(false);
  });

  it("answers not-found rather than ok for an unknown id", () => {
    const ydoc = setupDoc("rm-claude-404", "Hello world");
    const store = new YDocStore(ydoc, "/tmp/rm-claude-404.md", "rm-claude-404");

    expect(store.removeAnnotation("nope")).toStrictEqual({ kind: "not-found", id: "nope" });
  });
});

describe("ADR-031 origin — the contract the helper choice IS", () => {
  /** Origins of the transactions that actually changed THIS annotation key.
   *
   *  Filtered rather than collected wholesale: the reply sweep shares the
   *  transaction and neighbouring machinery (`publishDirty`, the durable
   *  queue) emits its own, so a bare `toContain` is satisfied by a correct
   *  write plus a spurious echo — which is the mutation that matters here. */
  function originsChangingKey(ydoc: ReturnType<typeof setupDoc>, key: string): unknown[] {
    const seen: unknown[] = [];
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    map.observe((event, txn) => {
      if (event.changes.keys.has(key)) seen.push(txn.origin);
    });
    return seen;
  }

  it("the browser's Archive writes under browser", () => {
    const ydoc = setupDoc("rm-origin-browser", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "x");
    const origins = originsChangingKey(ydoc, id);

    handleRemoveAnnotation(
      reqWith({ annotationId: id, documentId: "rm-origin-browser" }),
      mockRes(),
    );

    expect(origins).toStrictEqual([BROWSER_ORIGIN]);
  });

  it("Claude's remove writes under mcp", () => {
    const ydoc = setupDoc("rm-origin-mcp", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "x");
    const origins = originsChangingKey(ydoc, id);

    new YDocStore(ydoc, "/tmp/rm-origin-mcp.md", "rm-origin-mcp").removeAnnotation(id);

    expect(origins).toStrictEqual([MCP_ORIGIN]);
  });

  it("the mechanism's default is the BROWSER wrapper, so an omission mislabels nothing", () => {
    // The direction of the default is the point. The bug Unit 8e fixed was a
    // user action tagged as Claude's, so the safe value has to be the one a
    // caller gets by saying nothing.
    const ydoc = setupDoc("rm-origin-default", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "x");
    const origins = originsChangingKey(ydoc, id);

    removeAnnotationRecord(ydoc, map, id);

    expect(origins).toStrictEqual([BROWSER_ORIGIN]);
  });

  it("and passing withMcp explicitly is what switches it", () => {
    const ydoc = setupDoc("rm-origin-explicit", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "x");
    const origins = originsChangingKey(ydoc, id);

    removeAnnotationRecord(ydoc, map, id, withMcp);

    expect(origins).toStrictEqual([MCP_ORIGIN]);
  });
});

describe("the channel observer and a delete", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("emits no event and logs nothing for a browser-origin removal", () => {
    const ydoc = setupDoc("rm-observer", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "x");

    const events: TandemEvent[] = [];
    const stop = makeAnnotationsObserver({
      docName: "rm-observer",
      doc: ydoc,
      pushEvent: (e) => events.push(e),
    });

    try {
      // **Arm the observer first.** Both assertions below are zero-checks, and
      // review demonstrated the consequence by stubbing `makeAnnotationsObserver`
      // to `return () => {}` — every spec in this file stayed green. The header
      // claims this early return is unobservable from any other assertion in
      // the suite, and a spec that claims that has to prove its own instrument
      // was running. A browser-origin add of an outbound user comment is the
      // cheapest thing this observer will actually project.
      withBrowser(ydoc, () => {
        map.set("armed", {
          id: "armed",
          type: "comment",
          author: "user",
          audience: "outbound",
          status: "pending",
          range: unanchored(0, 5).range,
          content: "proof the observer is attached",
          timestamp: Date.now(),
          rev: 1,
        });
      });
      expect(
        events.map((e) => e.type),
        "control: the observer is attached and projecting",
      ).toStrictEqual(["annotation:created"]);
      events.length = 0;
      warn.mockClear();

      removeAnnotationRecord(ydoc, map, id);
    } finally {
      stop();
    }

    // `browser` is deliberately absent from CHANNEL_SKIP, so unlike the old
    // `withMcp` write this delete DOES reach `derive`. The `action === "delete"`
    // early return is the only thing between it and a
    // `refused to project … no such annotation` line, because a delete arrives
    // with `value: undefined` and the narrow refuses that as `"missing"` —
    // which `isNoteworthyRefusal` does not filter out.
    expect(
      warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("refused to project")),
      "an Archive click must not look like corruption in the log",
    ).toHaveLength(0);
    expect(events, "and there is no annotation:removed event to emit").toHaveLength(0);
  });
});

describe("the reply sweep", () => {
  it("takes the replies of the removed annotation and no others, on the browser path", () => {
    const ydoc = setupDoc("rm-sweep", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const doomed = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "first");
    const spared = createAnnotation(map, ydoc, "comment", unanchored(6, 11), "second");
    addReplyToAnnotation(ydoc, map, doomed, "goes", "user");
    addReplyToAnnotation(ydoc, map, spared, "stays", "user");

    handleRemoveAnnotation(reqWith({ annotationId: doomed, documentId: "rm-sweep" }), mockRes());

    const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(replies.size).toBe(1);
    const survivors: string[] = [];
    replies.forEach((v) => survivors.push((v as { annotationId: string }).annotationId));
    expect(survivors).toStrictEqual([spared]);
  });

  it("shares ONE transaction with the delete, so no peer sees an orphaned thread", () => {
    const ydoc = setupDoc("rm-sweep-txn", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "x");
    addReplyToAnnotation(ydoc, map, id, "r", "user");

    // Observed at the DOC level: two transactions would be two afterTransaction
    // fires, and a spec that only checked the end state cannot tell them apart.
    let transactions = 0;
    ydoc.on("afterTransaction", () => {
      transactions += 1;
    });

    removeAnnotationRecord(ydoc, map, id);

    expect(transactions).toBe(1);
  });
});

describe("who may reach the unguarded mechanism", () => {
  /**
   * The residual risk of this unit's shape, and the only control over it.
   *
   * The ADR-027 guard is on `AnnotationLifecycle.remove`, not on
   * `removeAnnotationRecord`, because the browser must reach the mechanism
   * ungated. That is right, and it means a NEW MCP-side caller can bypass the
   * guard simply by importing the wrong symbol — no edit to any existing file,
   * nothing red. Pinning the importer set is what turns that into a decision
   * someone has to make on purpose.
   *
   * Keyed on the SYMBOL, not on the module specifier. A specifier-shaped scan is
   * beaten by a dropped extension — `moduleResolution: "bundler"` makes
   * `from "../annotations/lifecycle"` legal — and the symbol name survives that.
   * Comments are stripped so `document-store.ts`'s prose about the mechanism is
   * not counted as a use of it.
   *
   * The assertion is an equality against a non-empty list, not "no unexpected
   * files": a sweep that silently found nothing satisfies the second and fails
   * the first.
   */
  const SANCTIONED = [
    // Defines it, and is where `AnnotationLifecycle.remove` adds the guard.
    "server/annotations/lifecycle.ts",
    // The browser's Archive. The ONE production caller entitled to the
    // unguarded path — see #1680.
    "server/mcp/routes/remove-annotation.ts",
  ];

  it("is exactly the lifecycle module and the browser's Archive route", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    const srcRoot = path.resolve(fileURLToPath(import.meta.url), "../../../src");

    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else out.push(full);
      }
      return out;
    }

    // **Every file under `src/`, no extension filter.** An earlier version
    // filtered to `.ts|.mts|.cts|.svelte`, and review put a caller in a
    // `.tsx` and then a `.js` — both survived green. There are no such files
    // in `src/` today, which is exactly why the filter looked harmless. Sweep
    // wider than the thing you are guarding, the way
    // `typecheck-tests-wiring.test.ts` does.
    const files = await walk(srcRoot);
    expect(files.length, "control: the sweep found source files").toBeGreaterThan(100);

    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    const users: string[] = [];
    for (const file of files) {
      const src = strip(await fs.readFile(file, "utf-8"));
      if (src.includes("removeAnnotationRecord")) {
        users.push(path.relative(srcRoot, file).replace(/\\/g, "/"));
      }
    }

    expect(users.sort()).toStrictEqual([...SANCTIONED].sort());

    // **The file-level pin alone is defeated from INSIDE a sanctioned file**,
    // and review demonstrated it: export a wrapper from `lifecycle.ts` that
    // calls the mechanism under `withMcp`, import THAT from an MCP-side module,
    // and every assertion above stays green — the new caller never mentions the
    // pinned symbol, and the wrapper lives in a file already on the list.
    //
    // So pin the call sites too. Exactly two occurrences of the name in
    // `lifecycle.ts`: the declaration, and the one call inside `removeForClaude`
    // (the guarded path). A wrapper is a third, and reds this.
    const lifecycle = strip(
      await fs.readFile(path.join(srcRoot, "server/annotations/lifecycle.ts"), "utf-8"),
    );
    expect(
      lifecycle.match(/removeAnnotationRecord/g) ?? [],
      "the declaration and removeForClaude's call — a third is a wrapper around the guard",
    ).toHaveLength(2);
  });
});
